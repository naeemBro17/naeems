import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from './AuthContext';

/**
 * Safety Lock (Batch 24 Part 4): "Allow deleting orders at any stage".
 * Only the Super Admin can open it, only after typing his password again,
 * and it closes itself after 15 minutes (and on logout). The real check is
 * in the database — admin_delete_orders() refuses a late-stage order unless
 * the lock row for this Super Admin is still open — this context only keeps
 * the admin panel's switch, red bar and countdown in step with it.
 */
interface SafetyLockValue {
  /** When the lock closes again, or null while it is on (normal). */
  openUntil: Date | null;
  secondsLeft: number;
  /** Re-confirms the password, then opens the lock for 15 minutes. */
  open: (password: string) => Promise<{ error: string | null }>;
  close: () => Promise<void>;
  refresh: () => Promise<void>;
}

const SafetyLockContext = createContext<SafetyLockValue | null>(null);

export const SAFETY_LOCK_MINUTES = 15;

export function SafetyLockProvider({ children }: { children: ReactNode }) {
  const { isAdmin, session } = useAuth();
  const [openUntil, setOpenUntil] = useState<Date | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    if (!isAdmin) {
      setOpenUntil(null);
      return;
    }
    const { data, error } = await supabase.rpc('admin_delete_lock_until');
    if (error || !data) {
      setOpenUntil(null);
      return;
    }
    setOpenUntil(new Date(data as string));
  }, [isAdmin]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Ticks once a second only while the lock is open.
  useEffect(() => {
    if (!openUntil) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [openUntil]);

  const secondsLeft = openUntil ? Math.max(0, Math.round((openUntil.getTime() - now) / 1000)) : 0;

  useEffect(() => {
    if (openUntil && secondsLeft === 0) setOpenUntil(null);
  }, [openUntil, secondsLeft]);

  const open = useCallback(
    async (password: string): Promise<{ error: string | null }> => {
      const email = session?.user.email;
      if (!isAdmin || !email) return { error: 'Only the Super Admin can do this.' };
      // Standard re-confirmation: sign in again with the password. The new
      // login token carries the time of this password check, which the
      // database requires to be under 5 minutes old.
      const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
      if (authError) return { error: 'Password is incorrect.' };
      const { data, error } = await supabase.rpc('admin_open_delete_lock', {
        p_seconds: SAFETY_LOCK_MINUTES * 60,
      });
      if (error || !data) return { error: 'Could not turn off the lock. Please try again.' };
      setNow(Date.now());
      setOpenUntil(new Date(data as string));
      return { error: null };
    },
    [isAdmin, session]
  );

  const close = useCallback(async () => {
    await supabase.rpc('admin_close_delete_lock');
    setOpenUntil(null);
  }, []);

  const value = useMemo(
    () => ({ openUntil: secondsLeft > 0 ? openUntil : null, secondsLeft, open, close, refresh }),
    [openUntil, secondsLeft, open, close, refresh]
  );

  return <SafetyLockContext.Provider value={value}>{children}</SafetyLockContext.Provider>;
}

export function useSafetyLock(): SafetyLockValue {
  const ctx = useContext(SafetyLockContext);
  if (!ctx) throw new Error('useSafetyLock must be used within a SafetyLockProvider');
  return ctx;
}

export function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** The red bar across the top of the admin while the lock is off. */
export function SafetyLockBar() {
  const { openUntil, secondsLeft, close } = useSafetyLock();
  const [isClosing, setIsClosing] = useState(false);
  if (!openUntil) return null;
  return (
    <div className="safety-lock-bar" role="alert">
      <span>
        Safety lock OFF: orders can be deleted at any stage (turns back on in {formatCountdown(secondsLeft)})
      </span>
      <button
        type="button"
        className="safety-lock-bar__button"
        disabled={isClosing}
        onClick={async () => {
          setIsClosing(true);
          await close();
          setIsClosing(false);
        }}
      >
        Turn back on now
      </button>
    </div>
  );
}
