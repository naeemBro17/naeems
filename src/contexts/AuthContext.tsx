import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { Profile } from '../types';

/** Result of a sign-in / sign-up attempt: an error message, or the profile. */
export interface AuthResult {
  error: string | null;
  profile: Profile | null;
}

interface AuthContextValue {
  session: Session | null;
  /** The logged-in user's profile (role + status), or null when signed out. */
  profile: Profile | null;
  /** True only for an approved admin — gates the admin panel and write policies. */
  isAdmin: boolean;
  /** True until the initial session AND profile check completes. */
  isLoading: boolean;
  /** Sign in, then resolve the profile. Returns the profile for routing. */
  signIn: (email: string, password: string) => Promise<AuthResult>;
  /** Self-service wholesaler sign-up: creates the auth user + a pending profile. */
  signUpWholesaler: (
    email: string,
    password: string,
    businessName: string,
    phone: string
  ) => Promise<AuthResult>;
  signOut: () => Promise<void>;
  /** Re-read the current user's profile (e.g. after an admin status change). */
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function fetchProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return data as Profile;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileChecked, setProfileChecked] = useState(false);
  // Which user the current profile answer belongs to. Between a session
  // arriving and its profile fetch starting there is one render where
  // profileChecked is still true from the signed-out state; without this,
  // that render reads as "loaded, not admin" and a cold load of /admin
  // redirects a real admin to the homepage.
  const profileForUserRef = useRef<string | null>(null);

  // Track the session. onAuthStateChange also fires an initial event, but
  // getSession resolves the first paint deterministically.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setSessionChecked(true);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange(
      (_event, newSession) => {
        setSession(newSession);
        setSessionChecked(true);
      }
    );

    return () => subscription.subscription.unsubscribe();
  }, []);

  const userId = session?.user.id ?? null;

  // Resolve the profile whenever the signed-in user changes. Fetching here
  // (rather than inside the auth callback) avoids Supabase's documented
  // deadlock when calling the client from within onAuthStateChange.
  useEffect(() => {
    if (!userId) {
      profileForUserRef.current = null;
      setProfile(null);
      setProfileChecked(true);
      return;
    }
    let active = true;
    setProfileChecked(false);
    (async () => {
      const p = await fetchProfile(userId);
      if (!active) return;
      profileForUserRef.current = userId;
      setProfile(p);
      setProfileChecked(true);
    })();
    return () => {
      active = false;
    };
  }, [userId]);

  const refreshProfile = useCallback(async () => {
    if (!userId) {
      setProfile(null);
      return;
    }
    const p = await fetchProfile(userId);
    setProfile(p);
  }, [userId]);

  const signIn = useCallback(
    async (email: string, password: string): Promise<AuthResult> => {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error || !data.user) {
        return { error: 'Incorrect email or password', profile: null };
      }
      const p = await fetchProfile(data.user.id);
      profileForUserRef.current = data.user.id;
      setProfile(p);
      setProfileChecked(true);
      return { error: null, profile: p };
    },
    []
  );

  const signUpWholesaler = useCallback(
    async (
      email: string,
      password: string,
      businessName: string,
      phone: string
    ): Promise<AuthResult> => {
      const { data, error } = await supabase.auth.signUp({ email, password });

      if (error) {
        console.error('Signup failed:', error);
        const message = /already|exist/i.test(error.message)
          ? 'An account with this email already exists. Try signing in instead.'
          : 'Could not create the account. Please try again.';
        return { error: message, profile: null };
      }

      if (!data.user) {
        return {
          error: 'Could not create the account. Please try again.',
          profile: null,
        };
      }

      // With email confirmation off, signUp returns an active session, so this
      // INSERT runs as the authenticated new user and satisfies profiles_self_insert.
      const { error: profileError } = await supabase.from('profiles').insert({
        id: data.user.id,
        role: 'wholesaler',
        status: 'pending',
        business_name: businessName,
        phone,
      });
      if (profileError) {
        console.error('Profile insert failed:', profileError);
        return {
          error: 'Account created, but saving your details failed. Please contact us.',
          profile: null,
        };
      }

      const p = await fetchProfile(data.user.id);
      profileForUserRef.current = data.user.id;
      setProfile(p);
      setProfileChecked(true);
      return { error: null, profile: p };
    },
    []
  );

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setProfile(null);
  }, []);

  const isAdmin = profile?.role === 'admin' && profile?.status === 'approved';
  // Loading until the session is known AND the profile answer is for this
  // very user — a stale "no profile" from the signed-out state doesn't count.
  const isLoading =
    !sessionChecked ||
    !profileChecked ||
    (userId !== null && profileForUserRef.current !== userId);

  return (
    <AuthContext.Provider
      value={{
        session,
        profile,
        isAdmin: isAdmin === true,
        isLoading,
        signIn,
        signUpWholesaler,
        signOut,
        refreshProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
