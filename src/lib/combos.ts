import { supabase, STORAGE_BUCKET, LONG_CACHE_SECONDS, randomFileId, storagePathFromUrl } from './supabase';

/**
 * Batch 52 Part 3 — "Share as a combo". A combo is a personal, shareable
 * list of products Naeem picked for a customer: /c/{code}. There is no
 * combo price — the shop's normal prices apply, and coupons work as
 * usual in the cart. Combos never touch stock, orders, money or promo
 * codes (supabase/migration-053-batch52.sql).
 */

/** Letters and digits that can't be mistaken for each other (no 0/o, 1/l/i). */
export const COMBO_CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const COMBO_CODE_LENGTH = 8;
export const COMBO_NAME_MAX = 60;
export const COMBO_NOTE_MAX = 300;

/** A new unguessable link code: 8 random letters / digits (31^8 ≈ 850
 *  billion). `randomBytes` is only swapped out by the unit tests. */
export function newComboCode(
  randomBytes: (count: number) => Uint8Array = (count) => crypto.getRandomValues(new Uint8Array(count))
): string {
  const size = COMBO_CODE_ALPHABET.length;
  // Bytes at or above this are thrown away, so every letter is equally likely.
  const cutoff = 256 - (256 % size);
  let code = '';
  while (code.length < COMBO_CODE_LENGTH) {
    for (const byte of randomBytes(COMBO_CODE_LENGTH * 2)) {
      if (byte >= cutoff) continue;
      code += COMBO_CODE_ALPHABET[byte % size];
      if (code.length === COMBO_CODE_LENGTH) break;
    }
  }
  return code;
}

/** The same shape the database accepts (get_combo checks it too). */
export function isComboCode(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[a-z2-9]{8}$/.test(value);
}

export function comboPath(code: string): string {
  return `/c/${code}`;
}

/** The full link to send (this site's own address). */
export function comboUrl(code: string, origin: string = window.location.origin): string {
  return `${origin}${comboPath(code)}`;
}

/** One line as saved: product, option (null = the product itself), how many. */
export interface ComboItem {
  product_id: string;
  variant_id: string | null;
  quantity: number;
}

/** What the customer page reads (get_combo). */
export interface ComboData {
  code: string;
  name: string;
  note: string | null;
  preview_url: string | null;
  items: ComboItem[];
}

/** One combo in Admin → Combos. */
export interface ComboRow extends ComboData {
  id: string;
  created_at: string;
}

/* ------------------------------------------------------------- totals */

/** One line priced with today's shop prices. */
export interface PricedComboLine {
  available: boolean;
  /** Today's price for one (the offer, else retail). */
  price: number;
  /** The retail price for one (struck through when above `price`). */
  retail: number;
  quantity: number;
}

export interface ComboTotals {
  /** Today's prices × quantities, sold-out lines not counted. */
  total: number;
  /** Retail prices × quantities, sold-out lines not counted. */
  retailTotal: number;
  /** retailTotal − total (never below 0). */
  savings: number;
  availableCount: number;
  soldOutCount: number;
}

export function comboTotals(lines: readonly PricedComboLine[]): ComboTotals {
  let total = 0;
  let retailTotal = 0;
  let availableCount = 0;
  let soldOutCount = 0;
  for (const line of lines) {
    if (!line.available) {
      soldOutCount += 1;
      continue;
    }
    const qty = Math.max(0, Math.floor(line.quantity));
    availableCount += 1;
    total += line.price * qty;
    retailTotal += Math.max(line.retail, line.price) * qty;
  }
  return { total, retailTotal, savings: Math.max(0, retailTotal - total), availableCount, soldOutCount };
}

/** How many of one line "Add all to cart" adds: the combo's quantity, but
 *  never past what may be in the cart (order limit / stock), counting what
 *  is already there. */
export function unitsToAdd(wanted: number, alreadyInCart: number, max: number): number {
  const room = max === Number.POSITIVE_INFINITY ? wanted : Math.floor(max) - alreadyInCart;
  return Math.max(0, Math.min(Math.floor(wanted), room));
}

/** "Added 3 items. 1 sold out." (Naeem's words); "Added 3 items" when
 *  nothing was sold out. */
export function addedToastText(added: number, soldOut: number): string {
  const items = `${added} item${added === 1 ? '' : 's'}`;
  return soldOut > 0 ? `Added ${items}. ${soldOut} sold out.` : `Added ${items}`;
}

/* ------------------------------------------------------------- sharing */

export function isPhone(userAgent: string = navigator.userAgent): boolean {
  return /Android|iPhone|iPad|iPod/i.test(userAgent);
}

export function whatsAppShareUrl(link: string): string {
  return `https://wa.me/?text=${encodeURIComponent(link)}`;
}

/** Messenger's own share screen (phones with the Messenger app). */
export function messengerShareUrl(link: string): string {
  return `fb-messenger://share/?link=${encodeURIComponent(link)}`;
}

/** "Hi! About my combo: {combo name}" for the customer's chat button. */
export function comboChatMessage(name: string): string {
  return `Hi! About my combo: ${name.trim()}`;
}

/* ------------------------------------------------------------ database */

function isItem(value: unknown): value is ComboItem {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.product_id === 'string' &&
    (v.variant_id === null || typeof v.variant_id === 'string') &&
    typeof v.quantity === 'number'
  );
}

function toComboData(value: unknown): ComboData | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.code !== 'string' || typeof v.name !== 'string') return null;
  const items = Array.isArray(v.items) ? v.items.filter(isItem) : [];
  return {
    code: v.code,
    name: v.name,
    note: typeof v.note === 'string' && v.note.trim() !== '' ? v.note : null,
    preview_url: typeof v.preview_url === 'string' ? v.preview_url : null,
    items,
  };
}

export type ComboLoad = { kind: 'ready'; combo: ComboData } | { kind: 'gone' } | { kind: 'error' };

/** One combo by its link code (works for logged-out visitors). */
export async function fetchCombo(code: string): Promise<ComboLoad> {
  if (!isComboCode(code)) return { kind: 'gone' };
  const { data, error } = await supabase.rpc('get_combo', { p_code: code });
  if (error) {
    // The function not being there yet means the SQL has not been run:
    // to a customer that is the same as "not available".
    return error.code === 'PGRST202' || error.code === '42883' ? { kind: 'gone' } : { kind: 'error' };
  }
  const combo = toComboData(data);
  return combo ? { kind: 'ready', combo } : { kind: 'gone' };
}

export type ComboListLoad = { kind: 'ready'; rows: ComboRow[] } | { kind: 'missing' } | { kind: 'error' };

/** Every combo, newest first (admin only — the database refuses others). */
export async function listCombos(): Promise<ComboListLoad> {
  const { data, error } = await supabase
    .from('combos')
    .select('id, code, name, note, preview_url, created_at, combo_items(product_id, variant_id, quantity, sort_order)')
    .order('created_at', { ascending: false });
  if (error) return error.code === '42P01' || error.code === 'PGRST205' ? { kind: 'missing' } : { kind: 'error' };
  const rows = (data ?? []).map((raw) => {
    const r = raw as Record<string, unknown>;
    const lines = Array.isArray(r.combo_items) ? (r.combo_items as (ComboItem & { sort_order: number })[]) : [];
    return {
      id: String(r.id),
      code: String(r.code),
      name: String(r.name),
      note: typeof r.note === 'string' ? r.note : null,
      preview_url: typeof r.preview_url === 'string' ? r.preview_url : null,
      created_at: String(r.created_at),
      items: [...lines]
        .sort((a, b) => a.sort_order - b.sort_order)
        .map(({ product_id, variant_id, quantity }) => ({ product_id, variant_id, quantity })),
    };
  });
  return { kind: 'ready', rows };
}

export interface NewCombo {
  name: string;
  note: string;
  items: ComboItem[];
}

export type CreateResult = { ok: true; id: string; code: string } | { ok: false; message: string };

/** Saves a combo with a fresh code (a new code is tried if one is taken). */
export async function createCombo(input: NewCombo): Promise<CreateResult> {
  const name = input.name.trim().slice(0, COMBO_NAME_MAX);
  const note = input.note.trim().slice(0, COMBO_NOTE_MAX);
  if (name === '') return { ok: false, message: 'Give the combo a name.' };
  if (input.items.length === 0) return { ok: false, message: 'Your cart is empty.' };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const code = newComboCode();
    const { data, error } = await supabase.rpc('admin_create_combo', {
      p_code: code,
      p_name: name,
      p_note: note,
      p_items: input.items,
    });
    if (!error && typeof data === 'string') return { ok: true, id: data, code };
    if (error?.code === '23505') continue;
    if (error?.code === 'PGRST202' || error?.code === '42883') {
      return { ok: false, message: 'Combos are not set up yet. Run the Batch 52 SQL in Supabase first.' };
    }
    return { ok: false, message: 'Could not make the link. Please try again.' };
  }
  return { ok: false, message: 'Could not make the link. Please try again.' };
}

/** Saves the combo's preview picture (made once, in the browser) and
 *  returns its address. Null when it could not be saved — the link still
 *  works; its preview then shows the shop banner. */
export async function saveComboPreview(comboId: string, code: string, picture: Blob): Promise<string | null> {
  const path = `combos/${code}-${randomFileId().slice(0, 8)}.jpg`;
  const { error } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(path, picture, { contentType: 'image/jpeg', cacheControl: LONG_CACHE_SECONDS });
  if (error) return null;
  const url = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path).data.publicUrl;
  const { error: saveError } = await supabase.from('combos').update({ preview_url: url }).eq('id', comboId);
  if (saveError) {
    await supabase.storage.from(STORAGE_BUCKET).remove([path]);
    return null;
  }
  return url;
}

/** Deletes a combo (its link stops working) and its preview picture. */
export async function deleteCombo(row: Pick<ComboRow, 'id' | 'preview_url'>): Promise<boolean> {
  const { error } = await supabase.from('combos').delete().eq('id', row.id);
  if (error) return false;
  const path = row.preview_url ? storagePathFromUrl(row.preview_url) : null;
  if (path && path.startsWith('combos/')) await supabase.storage.from(STORAGE_BUCKET).remove([path]);
  return true;
}
