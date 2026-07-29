import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from 'react';
import { AuthModal, type AuthModalView } from '../components/shared/AuthModal';

interface AuthModalContextValue {
  /** Open the auth modal at a given screen (defaults to the choice screen). */
  openAuth: (view?: AuthModalView) => void;
  closeAuth: () => void;
}

const AuthModalContext = createContext<AuthModalContextValue | null>(null);

/**
 * Hosts the single app-wide auth modal and exposes openAuth() so any component
 * (e.g. the wholesale row's "Login to view") can trigger it without prop
 * drilling. Rendered inside the router + product/auth providers.
 */
export function AuthModalProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<AuthModalView | null>(null);

  const openAuth = useCallback((next: AuthModalView = 'choice') => {
    setView(next);
  }, []);

  const closeAuth = useCallback(() => setView(null), []);

  return (
    <AuthModalContext.Provider value={{ openAuth, closeAuth }}>
      {children}
      {view !== null && (
        <AuthModal view={view} onSetView={setView} onClose={closeAuth} />
      )}
    </AuthModalContext.Provider>
  );
}

export function useAuthModal(): AuthModalContextValue {
  const ctx = useContext(AuthModalContext);
  if (!ctx) {
    throw new Error('useAuthModal must be used within an AuthModalProvider');
  }
  return ctx;
}
