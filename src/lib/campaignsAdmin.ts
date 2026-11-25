import { supabase } from './supabase';
import { parseCampaigns, percentSalePrice, normalPrice, type CampaignMode, type CampaignStyle, type LiveCampaign } from './campaigns';
import type { Product, ProductVariant } from '../types';

/**
 * Batch 66: Admin → Campaigns. The database does every check again
 * (admin_save_campaign: Super Admin only, prices below retail, no product in
 * two campaigns at the same time); this file only shapes and words things.
 */

export interface AdminCampaign extends LiveCampaign {
  is_enabled: boolean;
  orders: number;
  sold: number;
  given_off: number;
}

export type CampaignStatus = 'live' | 'scheduled' | 'ended' | 'off';

/** PostgREST's "no such function" (migration-063 not run yet). */
const FUNCTION_NOT_FOUND = 'PGRST202';

export async function fetchAdminCampaigns(): Promise<{ campaigns: AdminCampaign[]; error: string | null; missing: boolean }> {
  const { data, error } = await supabase.rpc('admin_campaigns');
  if (error) {
    return { campaigns: [], error: error.message, missing: error.code === FUNCTION_NOT_FOUND };
  }
  const raw = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  const base = parseCampaigns(raw);
  const campaigns = base.map((c): AdminCampaign => {
    const r = raw.find((x) => x.id === c.id) ?? {};
    return {
      ...c,
      is_enabled: r.is_enabled !== false,
      orders: Number(r.orders ?? 0),
      sold: Number(r.sold ?? 0),
      given_off: Number(r.given_off ?? 0),
    };
  });
  return { campaigns, error: null, missing: false };
}

export interface CampaignSaveInput {
  id?: string;
  name: string;
  style: CampaignStyle;
  discount_mode: CampaignMode;
  percent: number | null;
  starts_at: string;
  ends_at: string;
  is_enabled: boolean;
  items: { product_id: string; variant_id: string | null; campaign_price: number | null; sort_order: number }[];
}

export async function saveCampaign(input: CampaignSaveInput): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await supabase.rpc('admin_save_campaign', { p: input });
  if (error) return { id: null, error: error.message || 'Could not save the campaign.' };
  return { id: typeof data === 'string' ? data : null, error: null };
}

export async function setCampaignEnabled(id: string, on: boolean): Promise<string | null> {
  const { error } = await supabase.rpc('admin_set_campaign_enabled', { p_id: id, p_on: on });
  return error ? error.message || 'Could not change the campaign.' : null;
}

export async function deleteCampaign(id: string): Promise<string | null> {
  const { error } = await supabase.rpc('admin_delete_campaign', { p_id: id });
  return error ? error.message || 'Could not delete the campaign.' : null;
}

/* --------------------------------------------------------------- status */

export function campaignStatus(c: Pick<AdminCampaign, 'is_enabled' | 'starts_at' | 'ends_at'>, now = Date.now()): CampaignStatus {
  if (!c.is_enabled) return 'off';
  if (now < new Date(c.starts_at).getTime()) return 'scheduled';
  if (now >= new Date(c.ends_at).getTime()) return 'ended';
  return 'live';
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "Live · 2d 4h left", "Starts in 3 days", "Ended", "Off". */
export function statusText(c: Pick<AdminCampaign, 'is_enabled' | 'starts_at' | 'ends_at'>, now = Date.now()): string {
  const status = campaignStatus(c, now);
  if (status === 'off') return 'Off';
  if (status === 'ended') return 'Ended';
  if (status === 'scheduled') {
    const mins = Math.ceil((new Date(c.starts_at).getTime() - now) / 60000);
    if (mins >= 2 * 1440) return `Starts in ${Math.floor(mins / 1440)} days`;
    if (mins >= 60) return `Starts in ${plural(Math.floor(mins / 60), 'hour')}`;
    return `Starts in ${plural(Math.max(1, mins), 'minute')}`;
  }
  const mins = Math.floor((new Date(c.ends_at).getTime() - now) / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  return `Live · ${d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`} left`;
}

/* ------------------------------------------------------------ Dhaka time */

const DHAKA_MS = 6 * 3600 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The date ("2026-11-25") and time ("22:00") in Dhaka (UTC+6, no
 *  daylight saving) of a moment. */
export function toDhakaParts(iso: string): { date: string; time: string } {
  const d = new Date(new Date(iso).getTime() + DHAKA_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
  };
}

/** A Dhaka date + time as a moment ("2026-11-25T22:00:00+06:00"), or null. */
export function fromDhakaParts(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const iso = `${date}T${time}:00+06:00`;
  return Number.isNaN(new Date(iso).getTime()) ? null : iso;
}

/** "25 Nov, 10:00 AM" in Dhaka. */
export function dhakaShort(iso: string): string {
  const d = new Date(new Date(iso).getTime() + DHAKA_MS);
  const h = d.getUTCHours();
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${h12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "25 Nov, 10:00 AM to 28 Nov, 11:59 PM". */
export function dhakaRange(startsAt: string, endsAt: string): string {
  return `${dhakaShort(startsAt)} to ${dhakaShort(endsAt)}`;
}

/** "15% off · 24 products" / "Own prices · 6 products". */
export function campaignSummary(c: Pick<LiveCampaign, 'discount_mode' | 'percent' | 'items'>): string {
  const products = new Set(c.items.map((i) => i.product_id)).size;
  const what = c.discount_mode === 'percent' ? `${plainPercent(c.percent ?? 0)}% off` : 'Own prices';
  return `${what} · ${plural(products, 'product')}`;
}

export function plainPercent(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** New campaign defaults: starts at the next whole hour, ends 3 days later
 *  at 11:59 PM (Dhaka). */
export function defaultCampaignDates(now = Date.now()): { startDate: string; startTime: string; endDate: string; endTime: string } {
  const nextHour = Math.ceil((now + 1) / 3600000) * 3600000;
  const start = toDhakaParts(new Date(nextHour).toISOString());
  const end = toDhakaParts(new Date(nextHour + 3 * 86400000).toISOString());
  return { startDate: start.date, startTime: start.time, endDate: end.date, endTime: '23:59' };
}

/* --------------------------------------------------------- editor blocks */

/** One size row in the editor (own price: its price field). */
export interface EditorRow {
  /** null = the product's own size (or a product without sizes). */
  variantId: string | null;
  label: string | null;
  retail: number;
  offer: number | null;
  /** What Naeem typed (own price); '' = this size is not in the sale. */
  price: string;
}

/** One product in the editor; its sizes move together as one block. */
export interface EditorBlock {
  productId: string;
  name: string;
  thumb: string | null;
  rows: EditorRow[];
}

function sizeLabel(v: Pick<ProductVariant, 'region' | 'size'>): string | null {
  const label = [v.region, v.size].filter((p) => p && p.trim() !== '').join(' · ');
  return label || null;
}

/** A product's block: its own size first, then each size. */
export function blockFor(product: Product, variants: readonly ProductVariant[], thumb: string | null): EditorBlock {
  const own: EditorRow = {
    variantId: null,
    label: variants.length > 0 ? sizeLabel({ region: product.region ?? '', size: product.size ?? '' }) ?? 'Own size' : null,
    retail: product.retail_price,
    offer: product.offer_price,
    price: '',
  };
  return {
    productId: product.id,
    name: product.name,
    thumb,
    rows: [own, ...variants.map((v) => ({ variantId: v.id, label: sizeLabel(v), retail: v.retail_price, offer: v.offer_price, price: '' }))],
  };
}

/** What one row would cost in the sale (null = not in it). */
export function rowSalePrice(row: EditorRow, mode: CampaignMode, percent: number | null): number | null {
  if (mode === 'percent') {
    if (percent === null || !(percent > 0 && percent < 100)) return null;
    return Math.min(percentSalePrice(row.retail, percent), normalPrice(row.retail, row.offer));
  }
  const typed = row.price.trim() === '' ? NaN : Number(row.price);
  if (!Number.isFinite(typed) || typed <= 0) return null;
  return Math.min(typed, normalPrice(row.retail, row.offer));
}

/** The first problem with the editor's products, or null. */
export function blocksProblem(blocks: readonly EditorBlock[], mode: CampaignMode): string | null {
  if (blocks.length === 0) return 'Add at least 1 product.';
  if (mode === 'percent') return null;
  for (const b of blocks) {
    const priced = b.rows.filter((r) => r.price.trim() !== '');
    if (priced.length === 0) return `${b.name}: type a sale price.`;
    for (const r of priced) {
      const n = Number(r.price);
      if (!Number.isFinite(n) || n <= 0) return `${b.name}: type a sale price.`;
      if (n >= r.retail) return `${b.name}: the sale price must be below ৳${r.retail.toLocaleString('en-US')}.`;
    }
  }
  return null;
}

/** The items admin_save_campaign() takes, in the editor's order. */
export function blocksToItems(blocks: readonly EditorBlock[], mode: CampaignMode): CampaignSaveInput['items'] {
  return blocks.flatMap((b, bi): CampaignSaveInput['items'] =>
    mode === 'percent'
      ? [{ product_id: b.productId, variant_id: null, campaign_price: null, sort_order: bi * 100 }]
      : b.rows.flatMap((r, ri) =>
          r.price.trim() === ''
            ? []
            : [{ product_id: b.productId, variant_id: r.variantId, campaign_price: Number(r.price), sort_order: bi * 100 + ri }]
        )
  );
}

/** A saved campaign's items back into editor blocks (product order kept). */
export function itemsToBlocks(
  c: Pick<LiveCampaign, 'items'>,
  makeBlock: (productId: string) => EditorBlock | null
): EditorBlock[] {
  const blocks: EditorBlock[] = [];
  for (const it of [...c.items].sort((a, b) => a.sort_order - b.sort_order)) {
    let block = blocks.find((b) => b.productId === it.product_id);
    if (!block) {
      const made = makeBlock(it.product_id);
      if (!made) continue;
      block = made;
      blocks.push(block);
    }
    const row = block.rows.find((r) => r.variantId === it.variant_id);
    if (row && it.campaign_price !== null) row.price = String(it.campaign_price);
  }
  return blocks;
}
