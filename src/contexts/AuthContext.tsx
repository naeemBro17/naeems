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
  /** True for an approved wholesaler OR admin. */
  isWholesalerOrAdmin: boolean;
  /** True only for a plain customer (Google sign-in, not admin/wholesaler). */
  isCustomer: boolean;
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
  /** Starts the Google OAuth redirect. redirectTo is where Supabase sends the
   *  browser back to after Google — defaults to the current page. */
  signInWithGoogle: (redirectTo?: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  /** Re-read the current user's profile (e.g. after an admin status change). */
  refreshProfile: () => Promise<void>;
  /** Updates the signed-in user's own contact/address fields. Role, status,
   *  and business_name are never touched here (see profiles_self_update +
   *  the prevent_profile_self_escalation trigger, migration-020) — this is
   *  the customer account page's "Save" action. */
  updateOwnProfile: (patch: {
    full_name?: string;
    phone?: string;
    division?: string;
    district?: string;
    thana?: string;
    address_line?: string;
  }) => Promise<{ error: string | null }>;
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

/**
 * A Google sign-in has no profiles row until this runs once — unlike the
 * wholesaler flow (signUpWholesaler below), which creates its own row
 * immediately after signUp(). Only ever inserts role: 'customer',
 * status: 'approved' — matches the profiles_self_insert policy
 * (migration-020) exactly, so this can never create a wholesaler or admin
 * row no matter what's in the Google profile data.
 */
async function ensureCustomerProfile(session: Session): Promise<void> {
  const meta = session.user.user_metadata as Record<string, unknown>;
  const fullName =
    (typeof meta.full_name === 'string' && meta.full_name) ||
    (typeof meta.name === 'string' && meta.name) ||
    null;
  const photoUrl =
    (typeof meta.avatar_url === 'string' && meta.avatar_url) ||
    (typeof meta.picture === 'string' && meta.picture) ||
    null;

  await supabase.from('profiles').insert({
    id: session.user.id,
    role: 'customer',
    status: 'approved',
    full_name: fullName,
    photo_url: photoUrl,
  });
  // Errors (e.g. a row already exists from a race with another tab) are
  // intentionally swallowed — the caller re-fetches either way, and
  // profiles_self_insert guarantees this can't ever write anything unsafe.
}

function isGoogleSession(session: Session): boolean {
  return session.user.app_metadata?.provider === 'google';
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
    if (!userId || !session) {
      profileForUserRef.current = null;
      setProfile(null);
      setProfileChecked(true);
      return;
    }
    let active = true;
    setProfileChecked(false);
    (async () => {
      let p = await fetchProfile(userId);
      // No row yet AND this is a Google session (never a wholesaler
      // email/password signup, which creates its own row — see
      // isGoogleSession) → first-ever login, provision a plain customer row.
      if (!p && isGoogleSession(session)) {
        await ensureCustomerProfile(session);
        p = await fetchProfile(userId);
      }
      if (!active) return;
      profileForUserRef.current = userId;
      setProfile(p);
      setProfileChecked(true);
    })();
    return () => {
      active = false;
    };
    // Deliberately keyed on userId alone, not session — session gets a new
    // object identity on every token refresh, and re-running this per
    // refresh would spam fetchProfile. `session` here is still the current
    // one (it's literally where userId came from this same render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const signInWithGoogle = useCallback(
    async (redirectTo?: string): Promise<{ error: string | null }> => {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: redirectTo ?? window.location.href },
      });
      if (error) {
        return { error: 'Could not start Google sign-in. Please try again.' };
      }
      // Success navigates the whole page away to Google immediately — there
      // is no "return value" to give the caller beyond "the redirect started".
      return { error: null };
    },
    []
  );

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setProfile(null);
  }, []);

  const updateOwnProfile = useCallback(
    async (patch: {
      full_name?: string;
      phone?: string;
      division?: string;
      district?: string;
      thana?: string;
      address_line?: string;
    }): Promise<{ error: string | null }> => {
      if (!userId) return { error: 'Not signed in.' };
      const { error } = await supabase.from('profiles').update(patch).eq('id', userId);
      if (error) {
        return { error: 'Could not save your details. Please try again.' };
      }
      const p = await fetchProfile(userId);
      setProfile(p);
      return { error: null };
    },
    [userId]
  );

  const isAdmin = profile?.role === 'admin' && profile?.status === 'approved';
  const isWholesalerOrAdmin =
    (profile?.role === 'wholesaler' || profile?.role === 'admin') && profile?.status === 'approved';
  const isCustomer = profile?.role === 'customer';
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
        isWholesalerOrAdmin: isWholesalerOrAdmin === true,
        isCustomer,
        isLoading,
        signIn,
        signUpWholesaler,
        signInWithGoogle,
        signOut,
        refreshProfile,
        updateOwnProfile,
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
