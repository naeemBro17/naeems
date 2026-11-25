import { supabase } from './supabase';

/**
 * Batch 65: the note Naeem sends a customer about her order (she sees it
 * in My Orders and once as a floating card), and the delivery charge a
 * customer paid when a parcel came back. See migration-062.
 */

export interface UnseenOrderNote {
  order_id: string;
  order_number: string;
  note: string;
  note_at: string | null;
}

/** "24 Nov, 10:20 PM" in Dhaka time (the admin card and My Orders). */
export function noteDateText(at: string): string {
  const d = new Date(at);
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Dhaka' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Dhaka' });
  return `${date}, ${time}`;
}

/** Seen only when she opened it after it was sent (an edited note is new). */
export function noteSeen(noteAt: string | null, seenAt: string | null): boolean {
  if (noteAt === null || seenAt === null) return false;
  const sent = Date.parse(noteAt);
  const seen = Date.parse(seenAt);
  if (Number.isNaN(sent) || Number.isNaN(seen)) return false;
  return seen >= sent;
}

/** Mark returned: courier charge minus what the customer paid. */
export function returnLoss(courierCost: number, customerPaid: number): { kind: 'loss' | 'gain'; amount: number } {
  const rest = Math.round((courierCost - customerPaid) * 100) / 100;
  return rest >= 0 ? { kind: 'loss', amount: rest } : { kind: 'gain', amount: -rest };
}

/** The typed amount: digits only, at most 6 of them. */
export function cleanTakaInput(value: string): string {
  return value.replace(/[^0-9]/g, '').slice(0, 6);
}

function errorText(error: { message?: string } | null, fallback: string): string {
  return error?.message?.trim() || fallback;
}

export async function setNoteToCustomer(orderId: string, text: string): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('admin_set_note_to_customer', { p_order_id: orderId, p_note: text });
  return { error: error ? errorText(error, 'Could not save the note.') : null };
}

/** The newest note she has not seen, or null (none, not signed in, or the
 *  database said no: then nothing is shown). */
export async function fetchUnseenOrderNote(): Promise<UnseenOrderNote | null> {
  const { data, error } = await supabase.rpc('my_unseen_order_note');
  if (error || !Array.isArray(data) || data.length === 0) return null;
  const row = data[0] as Record<string, unknown>;
  if (typeof row.order_id !== 'string' || typeof row.note !== 'string' || row.note.trim() === '') return null;
  return {
    order_id: row.order_id,
    order_number: typeof row.order_number === 'string' ? row.order_number : '',
    note: row.note,
    note_at: typeof row.note_at === 'string' ? row.note_at : null,
  };
}

export async function markOrderNoteSeen(orderId: string): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('mark_order_note_seen', { p_order_id: orderId });
  return { error: error ? errorText(error, 'Could not mark the note seen.') : null };
}

export async function setReturnDeliveryPaid(orderId: string, amount: number): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('admin_set_return_delivery_paid', { p_order_id: orderId, p_amount: amount });
  return { error: error ? errorText(error, 'Could not save the amount.') : null };
}

/* ------------------------------------------------ one card at a time */

/**
 * The note card and Batch 64's "Your wallet is open" card never show
 * together. For a signed-in customer the note check runs once per app
 * load: 'waiting' until it answers, then 'shown' (a note is on screen or
 * waiting for a page it may show on) or 'none'. Before the check starts
 * it is 'off'. The wallet card (customers only, like the check) shows only
 * at 'none'; after a note it waits for the next app load.
 */
export type OrderNoteGate = 'off' | 'waiting' | 'shown' | 'none';

let gate: OrderNoteGate = 'off';
const listeners = new Set<() => void>();

export function orderNoteGate(): OrderNoteGate {
  return gate;
}

export function setOrderNoteGate(next: OrderNoteGate): void {
  if (gate === next) return;
  gate = next;
  listeners.forEach((fn) => fn());
}

export function subscribeOrderNoteGate(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** May the wallet card show now? */
export function walletNoteMayShow(g: OrderNoteGate): boolean {
  return g === 'none';
}

/** Pages the note card may show on: Home (shop grid), Account, My Orders. */
export function noteCardAllowedOn(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return path === '/' || path === '/account' || path === '/orders';
}
