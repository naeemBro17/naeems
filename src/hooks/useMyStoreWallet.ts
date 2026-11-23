import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from './useToast';
import { takaTight } from '../lib/advanceDiscount';
import { EMPTY_STORE_WALLET, fetchMyStoreWallet, markStoreWalletSeen, type MyStoreWallet } from '../lib/storeWallet';

// Answers already toasted in this tab (the Account and Wallet pages may
// both be mounted for a moment during a page transition).
const toasted = new Set<string>();

/**
 * Batch 60: the signed-in customer's wallet for the Account card, the
 * Wallet page and checkout. Loaded again whenever the tab comes back into
 * view, so a request Naeem has just confirmed shows at once. A confirmed
 * request shows the toast "৳3,000 added to your wallet" once.
 */
export function useMyStoreWallet(options: { toast?: boolean } = {}): {
  wallet: MyStoreWallet;
  loaded: boolean;
  reload: () => Promise<void>;
  /** Hides a "couldn't confirm" line for good. */
  dismiss: (requestId: string) => Promise<void>;
} {
  const { session, profile } = useAuth();
  const { showToast } = useToast();
  const isCustomer = Boolean(session) && profile?.role === 'customer';
  const [wallet, setWallet] = useState<MyStoreWallet>(EMPTY_STORE_WALLET);
  const [loaded, setLoaded] = useState(false);
  const wantToast = options.toast !== false;

  const reload = useCallback(async () => {
    if (!isCustomer) {
      setWallet(EMPTY_STORE_WALLET);
      setLoaded(true);
      return;
    }
    const next = await fetchMyStoreWallet();
    setWallet(next);
    setLoaded(true);
    if (!wantToast) return;
    for (const result of next.results) {
      if (result.status !== 'confirmed' || toasted.has(result.id)) continue;
      toasted.add(result.id);
      showToast(`${takaTight(result.amount)} added to your wallet`, 'success');
      void markStoreWalletSeen(result.id);
    }
  }, [isCustomer, wantToast, showToast]);

  useEffect(() => {
    void reload();
    const onFocus = () => {
      if (document.visibilityState === 'visible') void reload();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [reload]);

  const dismiss = useCallback(
    async (requestId: string) => {
      setWallet((w) => ({ ...w, results: w.results.filter((r) => r.id !== requestId) }));
      await markStoreWalletSeen(requestId);
    },
    []
  );

  return { wallet, loaded, reload, dismiss };
}
