import type { Product, ProductVariant } from '../types';

/**
 * Batch 66: Campaigns (timed sales). The ONE price rule the shop, the cart,
 * the order summary and place_order_core() (SQL campaign_sale_price()) all
 * follow:
 *
 *   percent  : one item row with variant_id null covers every size;
 *              sale = round(retail × (100 − percent) / 100), whole taka.
 *   own_price: the row of exactly this size (null = the product's own size,
 *              or a product without sizes) with the price Naeem typed.
 *   The customer pays the lower of the sale price and the normal price
 *   (the offer when below retail, else retail). Retail is struck through.
 *
 * The live campaigns sit in a small module store that CampaignProvider
 * fills once per app load, so getDisplayPrice() and friends can read them
 * without every caller changing.
 */

export type CampaignStyle = 'plain' | 'glitter';
export type CampaignMode = 'percent' | 'own_price';

export interface LiveCampaignItem {
  product_id: string;
  variant_id: string | null;
  campaign_price: number | null;
  sort_order: number;
}

export interface LiveCampaign {
  id: string;
  name: string;
  slug: string;
  style: CampaignStyle;
  discount_mode: CampaignMode;
  percent: number | null;
  starts_at: string;
  ends_at: string;
  items: LiveCampaignItem[];
}

export interface SaleInfo {
  campaign: LiveCampaign;
  /** What the customer pays. */
  price: number;
  /** Struck through. */
  retail: number;
  /** The price without the campaign (offer, else retail). */
  normal: number;
}

/** What DisplayPrice carries about the campaign (for tags and links). */
export interface DisplayCampaign {
  id: string;
  name: string;
  slug: string;
  style: CampaignStyle;
  ends_at: string;
}

let live: LiveCampaign[] = [];
let loaded = false;
let version = 0;
const listeners = new Set<() => void>();

function notify(): void {
  version += 1;
  listeners.forEach((l) => l());
}

export function setLiveCampaigns(next: LiveCampaign[]): void {
  live = next;
  loaded = true;
  notify();
}

/** True once the app load's live_campaigns() answer (or failure) is in. */
export function campaignsLoaded(): boolean {
  return loaded;
}

/** Something changed with time (a campaign just ended): re-render readers. */
export function refreshCampaigns(): void {
  notify();
}

export function subscribeCampaigns(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Changes whenever the store changes (for useSyncExternalStore). */
export function campaignsVersion(): number {
  return version;
}

export function liveCampaignsNow(now = Date.now()): LiveCampaign[] {
  return live.filter((c) => new Date(c.starts_at).getTime() <= now && now < new Date(c.ends_at).getTime());
}

/** The live campaign with this slug, or null. */
export function liveCampaignBySlug(slug: string, now = Date.now()): LiveCampaign | null {
  return liveCampaignsNow(now).find((c) => c.slug === slug) ?? null;
}

/** Turns the server's JSON into campaigns (numbers may come as strings). */
export function parseCampaigns(raw: unknown): LiveCampaign[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r): LiveCampaign[] => {
    if (typeof r !== 'object' || r === null) return [];
    const o = r as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.slug !== 'string') return [];
    const items = Array.isArray(o.items) ? o.items : [];
    return [
      {
        id: o.id,
        name: String(o.name ?? ''),
        slug: o.slug,
        style: o.style === 'glitter' ? 'glitter' : 'plain',
        discount_mode: o.discount_mode === 'own_price' ? 'own_price' : 'percent',
        percent: o.percent === null || o.percent === undefined ? null : Number(o.percent),
        starts_at: String(o.starts_at),
        ends_at: String(o.ends_at),
        items: items.flatMap((i): LiveCampaignItem[] => {
          if (typeof i !== 'object' || i === null) return [];
          const it = i as Record<string, unknown>;
          if (typeof it.product_id !== 'string') return [];
          return [
            {
              product_id: it.product_id,
              variant_id: typeof it.variant_id === 'string' ? it.variant_id : null,
              campaign_price: it.campaign_price === null || it.campaign_price === undefined ? null : Number(it.campaign_price),
              sort_order: Number(it.sort_order ?? 0),
            },
          ];
        }),
      },
    ];
  });
}

export function normalPrice(retail: number, offer: number | null): number {
  return offer !== null && offer < retail ? offer : retail;
}

/** round(retail × (100 − percent) / 100) to whole taka, worked in whole
 *  paisa so it never lands on 849.4999… where SQL has 849.5. */
export function percentSalePrice(retail: number, percent: number): number {
  const paisaTimesHundredths = Math.round(retail * 100) * Math.round((100 - percent) * 100);
  return Math.round(paisaTimesHundredths / 1_000_000);
}

/** The base option of a product carries the product's id; the database
 *  treats it as "no size" (null). */
export function campaignVariantId(productId: string, variantId: string | null | undefined): string | null {
  return !variantId || variantId === productId ? null : variantId;
}

/** Sale price of one product / size in a live campaign, or null. Same rule
 *  as SQL campaign_sale_price(). */
export function saleFor(
  productId: string,
  variantId: string | null,
  retail: number,
  offer: number | null,
  now = Date.now()
): SaleInfo | null {
  const size = campaignVariantId(productId, variantId);
  for (const c of liveCampaignsNow(now)) {
    const item =
      c.discount_mode === 'percent'
        ? c.items.find((i) => i.product_id === productId && i.variant_id === null)
        : c.items.find((i) => i.product_id === productId && i.variant_id === size && i.campaign_price !== null);
    if (!item) continue;
    const sale = c.discount_mode === 'percent' ? percentSalePrice(retail, c.percent ?? 0) : item.campaign_price;
    if (sale === null) continue;
    const normal = normalPrice(retail, offer);
    return { campaign: c, price: Math.min(sale, normal), retail, normal };
  }
  return null;
}

/** The price the shop charges now: a live campaign's sale price, else the
 *  offer when below retail, else retail (Batch 66: the admin's New order /
 *  Edit order list price). */
export function shopPrice(productId: string, variantId: string | null, retail: number, offer: number | null): number {
  return saleFor(productId, variantId, retail, offer)?.price ?? normalPrice(retail, offer);
}

/** Whole % saved, always rounded DOWN (never overstated). */
export function floorPercent(retail: number, pays: number): number {
  if (retail <= 0) return 0;
  return Math.max(0, Math.floor(((retail - pays) * 100) / retail + 1e-9));
}

export function displayCampaign(c: LiveCampaign): DisplayCampaign {
  return { id: c.id, name: c.name, slug: c.slug, style: c.style, ends_at: c.ends_at };
}

interface SizePrice {
  id: string | null;
  retail: number;
  offer: number | null;
}

/** The sizes of a product one campaign item covers. */
function sizesCovered(
  item: LiveCampaignItem,
  product: Product,
  variants: readonly ProductVariant[],
  mode: CampaignMode
): SizePrice[] {
  const own: SizePrice = { id: null, retail: product.retail_price, offer: product.offer_price };
  const sizes: SizePrice[] = variants.map((v) => ({ id: v.id, retail: v.retail_price, offer: v.offer_price }));
  if (mode === 'percent') return [own, ...sizes];
  if (item.variant_id === null) return [own];
  return sizes.filter((s) => s.id === item.variant_id);
}

/** The floor % of each size this campaign puts on sale. */
function campaignPercents(
  c: LiveCampaign,
  products: readonly Product[],
  variantsFor: (productId: string) => ProductVariant[],
  onlyProduct?: string
): number[] {
  const pct: number[] = [];
  for (const it of c.items) {
    if (onlyProduct !== undefined && it.product_id !== onlyProduct) continue;
    const p = products.find((x) => x.id === it.product_id);
    if (!p) continue;
    for (const s of sizesCovered(it, p, variantsFor(p.id), c.discount_mode)) {
      const sale = saleFor(p.id, s.id, s.retail, s.offer);
      if (sale && sale.campaign.id === c.id && s.retail > 0) pct.push(floorPercent(s.retail, sale.price));
    }
  }
  return pct;
}

/** "X% off every item" or "Up to X% off" (always rounded down). */
export function campaignHeadline(
  c: LiveCampaign,
  products: readonly Product[],
  variantsFor: (productId: string) => ProductVariant[]
): string {
  const pct = campaignPercents(c, products, variantsFor);
  if (pct.length === 0) return '';
  const max = Math.max(...pct);
  return pct.every((x) => x === max) ? `${max}% off every item` : `Up to ${max}% off`;
}

/** One product's "-X%" on the campaign page (its best size). */
export function productCampaignPercent(
  c: LiveCampaign,
  product: Product,
  variantsFor: (productId: string) => ProductVariant[]
): number {
  const pct = campaignPercents(c, [product], variantsFor, product.id);
  return pct.length === 0 ? 0 : Math.max(...pct);
}

/** The live campaign a product is in (any of its sizes), or null. */
export function campaignOfProduct(productId: string, now = Date.now()): LiveCampaign | null {
  return liveCampaignsNow(now).find((c) => c.items.some((i) => i.product_id === productId)) ?? null;
}

/** A campaign's products in Naeem's order (sizes of one product once). */
export function campaignProductIds(c: LiveCampaign): string[] {
  const ids: string[] = [];
  for (const it of [...c.items].sort((a, b) => a.sort_order - b.sort_order)) {
    if (!ids.includes(it.product_id)) ids.push(it.product_id);
  }
  return ids;
}

/* ------------------------------------------------------------ cart / summary */

export interface PricedLine {
  unitPrice: number;
  quantity: number;
  /** Set when the line is a sale item. */
  sale?: { campaignId: string; campaignName: string; retail: number } | null;
}

/** The products' total a promo code / the advance discount works on: the
 *  lines without a campaign (place_order_core's v_promo_base). */
export function promoBase(lines: readonly PricedLine[]): number {
  return lines.reduce((sum, l) => (l.sale ? sum : sum + l.unitPrice * l.quantity), 0);
}

export interface CampaignSavings {
  /** "Summer Fest savings", or "Sale savings" for more than one campaign. */
  label: string;
  /** The campaign's name, or "Sale" for more than one. */
  name: string;
  amount: number;
}

/** Σ (retail − pays) × qty of the sale lines, or null when there are none. */
export function campaignSavings(lines: readonly PricedLine[]): CampaignSavings | null {
  const names = new Set<string>();
  let amount = 0;
  for (const l of lines) {
    if (!l.sale) continue;
    names.add(l.sale.campaignName);
    amount += Math.max(0, l.sale.retail - l.unitPrice) * l.quantity;
  }
  if (names.size === 0) return null;
  const name = names.size === 1 ? [...names][0] : 'Sale';
  return { label: `${name} savings`, name, amount: Math.round(amount * 100) / 100 };
}

/* ------------------------------------------------------------ admin sorting */

/** Moves the block at `from` up (-1) or down (+1) one place. */
export function moveBlock<T>(list: readonly T[], from: number, step: -1 | 1): T[] {
  const to = from + step;
  if (from < 0 || from >= list.length || to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [it] = next.splice(from, 1);
  next.splice(to, 0, it);
  return next;
}

/** The list after dragging the block at `from` to index `to`. */
export function dropBlock<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return [...list];
  const next = [...list];
  const [it] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, it);
  return next;
}
