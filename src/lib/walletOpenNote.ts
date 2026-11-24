/**
 * Batch 64 Part 4: the one-time "Your wallet is open" note. Since Batch 62
 * Naeem opens each customer's wallet himself; the next time she opens the
 * Account page or Home she is told once, on this device.
 *
 * "Seen" lives in this browser only (localStorage), keyed by her customer
 * key. If the storage can't be read or written the note is never shown:
 * better silent than showing it every time.
 */

const PREFIX = 'naeems.walletOpenSeen.';

/** Her customer key, the same one the database uses (store_wallet_my_key). */
export function customerKeyFor(userId: string): string {
  return `p:${userId}`;
}

export function walletNoteKey(customerKey: string): string {
  return PREFIX + customerKey;
}

/** True when seen, false when not, null when the storage can't be read. */
export function readWalletNoteSeen(customerKey: string, storage: Storage | null = safeLocalStorage()): boolean | null {
  if (!storage) return null;
  try {
    return storage.getItem(walletNoteKey(customerKey)) === '1';
  } catch {
    return null;
  }
}

export function markWalletNoteSeen(customerKey: string, storage: Storage | null = safeLocalStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(walletNoteKey(customerKey), '1');
  } catch {
    // Not saved: it may show again next time, which is the lesser harm.
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export interface WalletNoteFacts {
  /** A signed-in customer (never staff, never a visitor). */
  isCustomer: boolean;
  /** Her wallet as the app already knows it: available and open. */
  walletOpen: boolean;
  /** From readWalletNoteSeen: null means the storage failed. */
  seen: boolean | null;
}

/** The rule: a signed-in customer, wallet open, not seen yet. */
export function shouldShowWalletNote(facts: WalletNoteFacts): boolean {
  return facts.isCustomer && facts.walletOpen && facts.seen === false;
}
