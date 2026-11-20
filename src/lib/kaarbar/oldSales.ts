import type { SheetCell } from '../inventory/opening';
import { moneyText } from '../money/format';
import { cellText, cleanPhone, findHeader, parseAmountCell, parseDateCell } from './parse';

/**
 * Batch 50: old Kaarbar sales. Step 1 reads Kaarbar's "Item List Report"
 * (.xlsx) and matches every item to a site product once; Step 2 reads
 * Kaarbar's "Party Statement" PDFs (one per customer) into bills. Pure
 * functions: the screens and the unit tests use the same code. The files
 * never leave the browser — only the rows that are saved.
 */

/* ============================================================ Step 1 */

/** One name for an item: no case, spaces or punctuation ("Eco- Recharge"
 *  and "Eco-Recharge" are the same item). */
export function itemKey(name: string): string {
  return name.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

export interface ItemRow {
  /** Excel row number (1 = the first row of the sheet). */
  n: number;
  name: string;
  key: string;
  /** Kaarbar's Purchase Price (0 when Kaarbar has none). */
  price: number;
}

type ItemColumn = 'name' | 'price';

const ITEM_COLUMNS = [
  { key: 'name' as ItemColumn, label: 'Item Name', names: ['itemname', 'item', 'name', 'productname'], required: true },
  { key: 'price' as ItemColumn, label: 'Purchase Price', names: ['purchaseprice', 'purchase', 'purchaserate', 'buyingprice', 'costprice'], required: true },
];

export function readItemList(cells: readonly (readonly SheetCell[])[]): { rows: ItemRow[]; twice: string[]; error: string | null } {
  const { header, error } = findHeader(cells, ITEM_COLUMNS, 'Item List Report');
  if (!header) return { rows: [], twice: [], error };
  const c = header.columns;
  const rows: ItemRow[] = [];
  const twice: string[] = [];
  const seen = new Set<string>();
  for (let i = header.row + 1; i < cells.length; i++) {
    const row = cells[i] ?? [];
    const name = cellText(row[c.name] ?? null).replace(/\s+/g, ' ').trim();
    if (name === '') continue;
    const key = itemKey(name);
    // A totals line at the bottom is not an item.
    if (key === '' || /^(grand)?total$/.test(key)) continue;
    if (seen.has(key)) {
      twice.push(name);
      continue;
    }
    seen.add(key);
    rows.push({ n: i + 1, name, key, price: Math.max(0, parseAmountCell(row[c.price] ?? null) ?? 0) });
  }
  if (rows.length === 0) return { rows, twice, error: 'The file has no items under the header.' };
  return { rows, twice, error: null };
}

/* ------------------------------------------------------- name matching */

/** A site product, or one option of it, that an item can be matched to. */
export interface SiteChoice {
  productId: string;
  variantId: string | null;
  name: string;
  option: string | null;
  isActive: boolean;
  stockUnit: string;
  packSize: number;
  /** Buying price of one pack on the site today (null = none). */
  costPerPack: number | null;
  /** A hidden product the Kaarbar import made. */
  madeByImport: boolean;
}

export function choiceId(c: Pick<SiteChoice, 'productId' | 'variantId'>): string {
  return `${c.productId}:${c.variantId ?? ''}`;
}

export function choiceLabel(c: Pick<SiteChoice, 'name' | 'option'>): string {
  return c.option ? `${c.name} — ${c.option}` : c.name;
}

const SIZE = /(\d+(?:\.\d+)?)\s*(ml|ltr|litre|liter|l|gms|gm|g|kg|oz|pcs|pc|capsules|caps|tablets|tabs)(?![a-z])/g;
const SIZE_UNIT: Record<string, string> = {
  ml: 'ml', ltr: 'l', litre: 'l', liter: 'l', l: 'l', gms: 'g', gm: 'g', g: 'g', kg: 'kg', oz: 'oz',
  pcs: 'pcs', pc: 'pcs', capsules: 'caps', caps: 'caps', tablets: 'tabs', tabs: 'tabs',
};

/** Words that say where it is from, not what it is: "(Australia/USA)". */
const PLACE_WORDS = new Set([
  'australia', 'australian', 'au', 'aus', 'usa', 'us', 'america', 'american', 'uk', 'france', 'french', 'korea',
  'korean', 'japan', 'japanese', 'germany', 'german', 'canada', 'india', 'thailand', 'original', 'imported',
]);
const FILLER_WORDS = new Set(['and', 'the', 'for', 'with', 'of', 'a', 'an', 'in']);

interface NameParts {
  words: string[];
  sizes: string[];
}

/** "Moisturising Lotion 236 ML (Australia/USA)" → words + sizes "236ml". */
export function nameParts(name: string): NameParts {
  let text = name.normalize('NFKD').toLowerCase().replace(/&/g, ' and ');
  const sizes: string[] = [];
  text = text.replace(SIZE, (_m, n: string, u: string) => {
    sizes.push(`${Number(n)}${SIZE_UNIT[u] ?? u}`);
    return ' ';
  });
  const words = text
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '' && !PLACE_WORDS.has(w) && !FILLER_WORDS.has(w));
  return { words, sizes };
}

function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Same word, allowing small spelling differences ("moisturising" /
 *  "moisturizing") in longer words. */
export function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  if (shorter < 5) return false;
  return editDistance(a, b, shorter >= 9 ? 2 : 1) <= (shorter >= 9 ? 2 : 1);
}

/** 0 … 1: how alike two product names are. Different sizes never match. */
export function nameScore(a: string, b: string): number {
  const pa = nameParts(a);
  const pb = nameParts(b);
  if (pa.sizes.length > 0 && pb.sizes.length > 0 && !pa.sizes.some((s) => pb.sizes.includes(s))) return 0;
  if (pa.words.length === 0 || pb.words.length === 0) return 0;
  const used = new Set<number>();
  let same = 0;
  for (const w of pa.words) {
    const at = pb.words.findIndex((x, i) => !used.has(i) && sameWord(w, x));
    if (at >= 0) {
      used.add(at);
      same++;
    }
  }
  const score = (2 * same) / (pa.words.length + pb.words.length);
  // The same size on both sides is a small extra sign it is the same thing.
  const sizeBonus = pa.sizes.length > 0 && pa.sizes.every((s) => pb.sizes.includes(s)) ? 0.05 : 0;
  return Math.min(1, score + sizeBonus);
}

export const AUTO_SCORE = 0.85;
const AUTO_LEAD = 0.1;

export interface MatchSuggestion {
  best: SiteChoice | null;
  score: number;
  /** Sure enough to match without asking. */
  confident: boolean;
  /** Every choice, the most alike first (for the picker). */
  ranked: SiteChoice[];
}

/** The site product an item most likely is. Hidden products the import
 *  made are never matched on their own. */
export function suggestMatch(name: string, choices: readonly SiteChoice[]): MatchSuggestion {
  const scored = choices
    .filter((c) => !c.madeByImport)
    .map((c) => ({ c, s: nameScore(name, choiceLabel(c)) }))
    .sort((x, y) => y.s - x.s || choiceLabel(x.c).localeCompare(choiceLabel(y.c)));
  const best = scored[0];
  if (!best || best.s <= 0) return { best: null, score: 0, confident: false, ranked: scored.map((x) => x.c) };
  const second = scored[1]?.s ?? 0;
  return {
    best: best.c,
    score: best.s,
    confident: best.s >= AUTO_SCORE && best.s - second >= AUTO_LEAD,
    ranked: scored.map((x) => x.c),
  };
}

/** The picker's list: the most alike first; typing narrows it by words. */
export function searchChoices(query: string, itemName: string, choices: readonly SiteChoice[]): SiteChoice[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const pool = words.length === 0 ? choices : choices.filter((c) => words.every((w) => choiceLabel(c).toLowerCase().includes(w)));
  return pool
    .map((c) => ({ c, s: nameScore(itemName, choiceLabel(c)) }))
    .sort((x, y) => y.s - x.s || choiceLabel(x.c).localeCompare(choiceLabel(y.c)))
    .map((x) => x.c);
}

/* ------------------------------------------------------- the item list */

export type MatchHow = 'auto' | 'hand' | 'hidden' | 'none';
export type PriceFrom = 'site' | 'kaarbar' | 'saved' | 'typed' | 'none';

/** An item already saved in the Step 1 list. */
export interface SavedItem {
  id: string;
  key: string;
  name: string;
  kaarbarPrice: number;
  productId: string | null;
  variantId: string | null;
  madeProductId: string | null;
  how: 'auto' | 'hand' | 'hidden';
  costPerPack: number;
  unitCosts: Record<string, number>;
  billLines: number;
}

export interface ItemDraft {
  key: string;
  name: string;
  kaarbarPrice: number;
  how: MatchHow;
  choice: SiteChoice | null;
  price: string;
  priceFrom: PriceFrom;
  saved: SavedItem | null;
}

function priceText(n: number | null): string {
  return n !== null && n > 0 ? String(Math.round(n * 100) / 100) : '';
}

function findChoice(choices: readonly SiteChoice[], productId: string | null, variantId: string | null): SiteChoice | null {
  if (!productId) return null;
  return choices.find((c) => c.productId === productId && c.variantId === variantId) ?? null;
}

/** The starting price for an item matched to a site product: the site's
 *  buying price, else Kaarbar's Purchase Price, else empty. */
export function startPrice(choice: SiteChoice | null, kaarbarPrice: number): { price: string; from: PriceFrom } {
  if (choice && choice.costPerPack !== null && choice.costPerPack > 0) return { price: priceText(choice.costPerPack), from: 'site' };
  if (kaarbarPrice > 0) return { price: priceText(kaarbarPrice), from: 'kaarbar' };
  return { price: '', from: 'none' };
}

/** One draft per item: what is saved wins; a new item gets a suggestion. */
export function buildDrafts(rows: readonly ItemRow[], saved: readonly SavedItem[], choices: readonly SiteChoice[]): ItemDraft[] {
  const byKey = new Map(saved.map((s) => [s.key, s]));
  const out: ItemDraft[] = rows.map((r) => {
    const s = byKey.get(r.key) ?? null;
    if (s) return savedDraft(s, choices, r.price, r.name);
    const m = suggestMatch(r.name, choices);
    const choice = m.confident ? m.best : null;
    const p = startPrice(choice, r.price);
    // No sure match: a new hidden product by default (change it in the picker).
    return { key: r.key, name: r.name, kaarbarPrice: r.price, how: choice ? 'auto' : 'hidden', choice, price: p.price, priceFrom: p.from, saved: null };
  });
  // Saved items that are not in this file stay in the list.
  const inFile = new Set(rows.map((r) => r.key));
  for (const s of saved) if (!inFile.has(s.key)) out.push(savedDraft(s, choices, s.kaarbarPrice, s.name));
  return out;
}

function savedDraft(s: SavedItem, choices: readonly SiteChoice[], kaarbarPrice: number, name: string): ItemDraft {
  const choice = s.how === 'hidden' ? null : findChoice(choices, s.productId, s.variantId);
  // A product deleted since: the item needs a product again.
  const how: MatchHow = s.how === 'hidden' ? 'hidden' : choice ? s.how : 'none';
  return { key: s.key, name, kaarbarPrice, how, choice, price: priceText(s.costPerPack), priceFrom: 'saved', saved: s };
}

/** Picking a product by hand: the price follows the new product unless it
 *  was typed or saved. */
export function pickChoice(d: ItemDraft, choice: SiteChoice): ItemDraft {
  const keep = d.priceFrom === 'typed' || d.priceFrom === 'saved';
  const p = keep ? { price: d.price, from: d.priceFrom } : startPrice(choice, d.kaarbarPrice);
  return { ...d, how: 'hand', choice, price: p.price, priceFrom: p.from };
}

export function pickHidden(d: ItemDraft): ItemDraft {
  const keep = d.priceFrom === 'typed' || d.priceFrom === 'saved';
  const p = keep ? { price: d.price, from: d.priceFrom } : startPrice(null, d.kaarbarPrice);
  return { ...d, how: 'hidden', choice: null, price: p.price, priceFrom: p.from };
}

export function draftPrice(d: ItemDraft): number | null {
  const n = Number(d.price.replace(/[৳,\s]/g, ''));
  return d.price.trim() !== '' && Number.isFinite(n) && n > 0 && n < 100000000 ? Math.round(n * 100) / 100 : null;
}

export function needsMatch(d: ItemDraft): boolean {
  return d.how === 'none';
}

export function needsPrice(d: ItemDraft): boolean {
  return draftPrice(d) === null;
}

export type ItemFilter = 'all' | 'needs' | 'matched' | 'hidden';

/** Batch 53.1: the keys of the items the filter and the search show right
 *  now. Taken only when the filter, the search or the list itself changes,
 *  so a row never leaves the list while Naeem is still typing its price
 *  or has just picked its product. */
export function itemKeysInView(drafts: readonly ItemDraft[], filter: ItemFilter, search: string): ReadonlySet<string> {
  const q = search.trim().toLowerCase();
  return new Set(
    drafts
      .filter((d) => {
        if (filter === 'needs' && !(needsMatch(d) || needsPrice(d))) return false;
        if (filter === 'matched' && !(d.how === 'auto' || d.how === 'hand')) return false;
        if (filter === 'hidden' && d.how !== 'hidden') return false;
        if (q === '') return true;
        return d.name.toLowerCase().includes(q) || (d.choice ? choiceLabel(d.choice).toLowerCase().includes(q) : false);
      })
      .map((d) => d.key)
  );
}

/** The rows on screen: those kept in view, in list order, with their latest values. */
export function itemsKeptInView(drafts: readonly ItemDraft[], keys: ReadonlySet<string>): ItemDraft[] {
  return drafts.filter((d) => keys.has(d.key));
}

export interface ItemCounts {
  matched: number;
  byHand: number;
  hidden: number;
  noPrice: number;
}

export function itemCounts(drafts: readonly ItemDraft[]): ItemCounts {
  return {
    matched: drafts.filter((d) => d.how === 'auto' || d.how === 'hand').length,
    byHand: drafts.filter(needsMatch).length,
    hidden: drafts.filter((d) => d.how === 'hidden').length,
    noPrice: drafts.filter(needsPrice).length,
  };
}

export interface ItemSaveRow {
  name_key: string;
  kaarbar_name: string;
  kaarbar_price: number;
  choice: 'auto' | 'hand' | 'hidden';
  product_id: string | null;
  variant_id: string | null;
  cost_per_pack: number;
}

/** Null while any item has no product choice or no buying price. */
export function itemSaveRows(drafts: readonly ItemDraft[]): ItemSaveRow[] | null {
  const out: ItemSaveRow[] = [];
  for (const d of drafts) {
    const price = draftPrice(d);
    if (d.how === 'none' || price === null) return null;
    out.push({
      name_key: d.key,
      kaarbar_name: d.name,
      kaarbar_price: d.kaarbarPrice,
      choice: d.how,
      product_id: d.how === 'hidden' ? null : (d.choice?.productId ?? null),
      variant_id: d.how === 'hidden' ? null : (d.choice?.variantId ?? null),
      cost_per_pack: price,
    });
  }
  return out;
}

/* ============================================================ Step 2 */

/** One piece of text in the PDF, where pdf.js put it (y grows upwards). */
export interface PdfText {
  str: string;
  x: number;
  y: number;
  w: number;
  /** Font size. */
  h: number;
  page: number;
}

export interface StatementLine {
  name: string;
  key: string;
  quantity: number;
  /** null = packs; else "pcs", "ml" … */
  unit: string | null;
  rate: number;
  discount: number;
  total: number;
  isDelivery: boolean;
}

export interface StatementBill {
  kind: 'sale' | 'return';
  billNo: string;
  date: string;
  /** Kaarbar's bill Total (the real sale amount). */
  total: number;
  lines: StatementLine[];
  /** Product lines only. */
  itemsTotal: number;
  delivery: number;
  /** Lines + delivery − bill Total (a whole-bill discount). */
  billDiscount: number;
  /** Batch 54: the bill's own Rec/Paid Amt and Due (null when not shown). */
  paid: number | null;
  due: number | null;
  /** Batch 54: the first line of its Remarks (max 200 letters), or ''. */
  note: string;
}

/** Batch 54: a "Payment In" row of the statement. */
export interface StatementPayment {
  date: string;
  amount: number;
}

export interface Statement {
  partyName: string;
  phone: string;
  phoneKey: string | null;
  /** "Total Sales (Sales - Sales Return)" in the header. */
  headerTotal: number | null;
  bills: StatementBill[];
  /** Payment In and other rows that are not sales (left out of the bills). */
  otherRows: number;
  /** Batch 54: "Total Receivables" in the header (what the party owes). */
  totalReceivables: number | null;
  /** Batch 54: the "Report Generated on" day (yyyy-mm-dd). */
  reportDate: string | null;
  /** Batch 54: every Payment In row, in the order of the file. */
  payments: StatementPayment[];
}

export const OLD_LAYOUT =
  'This is the old statement layout. In Kaarbar, download the party statement again (the one with Total, Rec/Paid Amt and Due columns).';

/** "Tk. 5,020", "Tk. 8.50", "(Tk. 30)", "--" → numbers (null when none). */
export function tkAmount(text: string): number | null {
  const m = /(-)?\s*(?:tk\.?|৳)?\s*(\d[\d,]*(?:\.\d+)?)/i.exec(text);
  if (!m) return null;
  const n = Number(m[2].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return m[1] || /^\s*\(/.test(text) ? -n : n;
}

const UNIT_ALIASES: Record<string, string> = {
  pc: 'pcs', pcs: 'pcs', piece: 'pcs', pieces: 'pcs', nos: 'pcs', no: 'pcs',
  ml: 'ml', gm: 'g', gms: 'g', g: 'g', gram: 'g', grams: 'g',
};

/** "PCS" / "Pieces" → "pcs"; "ML" → "ml"; other words in lower case. */
export function normaliseUnit(word: string): string {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  return UNIT_ALIASES[w] ?? w;
}

/** "150 PCS" → 150 pcs; "1" → 1 pack; "473 ML" → 473 ml. */
export function parseQuantity(text: string): { quantity: number; unit: string | null } | null {
  const m = /^\s*(\d[\d,]*(?:\.\d+)?)\s*([A-Za-z]{1,12})?\.?\s*$/.exec(text.replace(/\s+/g, ' '));
  if (!m) return null;
  const quantity = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  return { quantity, unit: m[2] ? normaliseUnit(m[2]) : null };
}

const DATE_START = /^\d{1,2}\s+[A-Za-z]{3,9}\.?,?\s+\d{4}/;

interface Segment {
  text: string;
  left: number;
  right: number;
}

interface Line {
  page: number;
  y: number;
  /** The pdf.js pieces of the line, left to right. */
  parts: PdfText[];
  segs: Segment[];
  text: string;
}

/**
 * Batch 54: one pdf.js piece that runs over a column edge ("…473mlTk.
 * 3,999") is cut where the next cell starts: at a "Tk." / "৳" near the
 * edge (an amount column), else at the start of the word nearest to it.
 * Where each letter sits is worked out from the piece's own position and
 * width. A piece with no place to cut near the edge is left whole.
 */
function splitAtCuts(p: PdfText, cuts: readonly number[]): PdfText[] {
  const size = p.h > 0 ? p.h : 8;
  const cut = cuts.find((c) => c > p.x + size * 0.5 && c < p.x + p.w - size * 0.25);
  if (cut === undefined || p.str.length < 2) return [p];
  const per = p.w / p.str.length;
  // The piece ends inside the next column with an amount: that amount is
  // the cell of that column (its own width may include the gap before it,
  // so the letters' places are not used here).
  const trailing = /(?:tk\.?|৳)\s*-?\d[\d,]*(?:\.\d+)?\s*$/i.exec(p.str);
  if (trailing && trailing.index > 0) {
    const at = trailing.index;
    const left: PdfText = { ...p, str: p.str.slice(0, at), w: Math.max(0, cut - p.x - 1) };
    const right: PdfText = { ...p, str: p.str.slice(at), x: cut, w: p.x + p.w - cut };
    return [left, ...splitAtCuts(right, cuts)];
  }
  let best = -1;
  let bestD = Infinity;
  let bestMoney = false;
  for (let i = 1; i < p.str.length; i++) {
    const money = /^(?:tk\.|৳)/i.test(p.str.slice(i));
    const wordStart = /\s/.test(p.str[i - 1]) && !/\s/.test(p.str[i]);
    if (!money && !wordStart) continue;
    const d = Math.abs(p.x + i * per - cut);
    if (d > size * 2) continue;
    if ((money && !bestMoney) || (money === bestMoney && d < bestD)) {
      best = i;
      bestD = d;
      bestMoney = money;
    }
  }
  if (best < 0) return [p];
  const left: PdfText = { ...p, str: p.str.slice(0, best), w: best * per };
  const right: PdfText = { ...p, str: p.str.slice(best), x: p.x + best * per, w: p.w - best * per };
  return [left, ...splitAtCuts(right, cuts)];
}

/** Pieces of one line → segments (pieces close together, like the words
 *  of one cell). With `cuts` (the left edges of the table's columns) a
 *  segment never runs over a column edge: a long name that ends right
 *  before the Total column stays a name, and the price stays the Total. */
function segmentsOf(parts: readonly PdfText[], cuts: readonly number[] = []): Segment[] {
  const pieces = cuts.length === 0 ? parts : parts.flatMap((p) => splitAtCuts(p, cuts));
  const segs: Segment[] = [];
  for (const p of pieces) {
    const last = segs[segs.length - 1];
    const size = p.h > 0 ? p.h : 8;
    const gap = last ? p.x - last.right : Infinity;
    const edgeBetween = last ? cuts.some((c) => last.left < c - 0.5 && p.x >= c - 1.5) : false;
    if (last && gap <= size * 0.8 && !edgeBetween) {
      last.text = `${last.text}${gap > size * 0.1 && !last.text.endsWith(' ') && !p.str.startsWith(' ') ? ' ' : ''}${p.str}`;
      last.right = Math.max(last.right, p.x + p.w);
    } else {
      segs.push({ text: p.str, left: p.x, right: p.x + p.w });
    }
  }
  for (const s of segs) s.text = s.text.replace(/\s+/g, ' ').trim();
  return segs.filter((s) => s.text !== '');
}

/** The same line, its segments cut at a table's column edges. */
function cutLine(line: Line, cuts: readonly number[]): Line {
  const segs = segmentsOf(line.parts, cuts);
  return { ...line, segs, text: segs.map((s) => s.text).join(' ') };
}

/** Text pieces → lines (same y on a page) → segments (pieces close
 *  together on a line, like the words of one cell). */
export function textLines(items: readonly PdfText[]): Line[] {
  const sorted = items
    .filter((t) => t.str.trim() !== '')
    .slice()
    .sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const lines: Line[] = [];
  let bucket: PdfText[] = [];
  const flush = () => {
    if (bucket.length === 0) return;
    const parts = bucket.slice().sort((a, b) => a.x - b.x);
    const clean = segmentsOf(parts);
    lines.push({ page: bucket[0].page, y: bucket[0].y, parts, segs: clean, text: clean.map((s) => s.text).join(' ') });
    bucket = [];
  };
  for (const t of sorted) {
    const first = bucket[0];
    const tol = Math.max(2, (first?.h || 8) * 0.35);
    if (first && (t.page !== first.page || Math.abs(t.y - first.y) > tol)) flush();
    bucket.push(t);
  }
  flush();
  return lines;
}

interface Column<K extends string> {
  key: K;
  left: number;
  right: number;
}

/** The column a cell belongs to: the header it lines up with on the left,
 *  the centre or the right (cells may be aligned any of the three ways). */
function columnOf<K extends string>(seg: Segment, cols: readonly Column<K>[]): K | null {
  let best: K | null = null;
  let bestD = Infinity;
  const mid = (seg.left + seg.right) / 2;
  for (const c of cols) {
    const d = Math.min(Math.abs(seg.left - c.left), Math.abs(mid - (c.left + c.right) / 2), Math.abs(seg.right - c.right));
    if (d < bestD) {
      bestD = d;
      best = c.key;
    }
  }
  return best;
}

function cells<K extends string>(line: Line, cols: readonly Column<K>[]): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const s of line.segs) {
    const k = columnOf(s, cols);
    if (k) out[k] = out[k] ? `${out[k]} ${s.text}` : s.text;
  }
  return out;
}

type TxCol = 'date' | 'particulars' | 'total' | 'paid' | 'due' | 'balance';
type ItemCol = 'name' | 'total' | 'quantity' | 'rate' | 'discount';

function headerColumns<K extends string>(line: Line, tests: readonly [K, RegExp][]): Column<K>[] {
  const out: Column<K>[] = [];
  for (const s of line.segs) {
    // "Rec/Paid Amt Due" may arrive as one piece; then it is split evenly.
    const words = s.text.split(' ');
    const found = tests.filter(([, re]) => re.test(s.text));
    if (found.length <= 1) {
      const hit = tests.find(([k, re]) => re.test(s.text) && !out.some((c) => c.key === k));
      if (hit) out.push({ key: hit[0], left: s.left, right: s.right });
      continue;
    }
    const step = (s.right - s.left) / words.length;
    words.forEach((w, i) => {
      const hit = tests.find(([k, re]) => re.test(w) && !out.some((c) => c.key === k));
      if (hit) out.push({ key: hit[0], left: s.left + i * step, right: s.left + (i + 1) * step });
    });
  }
  return out;
}

const TX_TESTS: readonly [TxCol, RegExp][] = [
  ['date', /^date$/i],
  ['particulars', /particular/i],
  ['total', /^total$/i],
  ['paid', /rec|paid/i],
  ['due', /^due$/i],
  ['balance', /running|balance/i],
];

const ITEM_TESTS: readonly [ItemCol, RegExp][] = [
  ['name', /^items?$/i],
  ['total', /^total$/i],
  ['quantity', /^(quantity|qty)$/i],
  ['rate', /^rate$/i],
  ['discount', /^discount$/i],
];

function isTableHeader(line: Line): boolean {
  return /particular/i.test(line.text) && /\bdate\b/i.test(line.text);
}

function isItemHeader(line: Line): boolean {
  return /^items?\b/i.test(line.segs[0]?.text ?? '') && /quantity|qty/i.test(line.text) && /\brate\b/i.test(line.text);
}

function isNoise(line: Line): boolean {
  return /^(page\s*\d+|\d+\s*(of|\/)\s*\d+$|report generated|generated on|powered by|kaarbar)/i.test(line.text);
}

interface RawItemLine {
  y: number;
  page: number;
  c: Partial<Record<ItemCol, string>>;
}

interface RawTx {
  dateText: string;
  particulars: string;
  totalText: string;
  paidText: string;
  dueText: string;
  note: string;
  items: RawItemLine[];
  sawItemHeader: boolean;
}

const PHONE_TEXT = /^\+?\d[\d\s-]{8,}\d$/;

/** The party's phone: "Phone No: 017…" on one line, or the number placed
 *  between "Phone" and "No:" on two lines (the newer layout) — the number
 *  nearest to the label, to its right. */
function partyPhone(items: readonly PdfText[], all: string): string {
  const inline = /phone(?:\s*no)?\.?\s*:\s*([+\d][\d\s-]{5,}\d)/i.exec(all)?.[1];
  if (inline) return inline.trim();
  const label = items.find((t) => /^phone\b/i.test(t.str.trim()));
  if (!label) return '';
  const near = items
    .filter((t) => t.page === label.page && t.x > label.x && PHONE_TEXT.test(t.str.trim()) && Math.abs(t.y - label.y) <= Math.max(label.h, 8) * 2)
    .sort((a, b) => Math.abs(a.y - label.y) - Math.abs(b.y - label.y) || a.x - b.x);
  return near[0]?.str.trim() ?? '';
}

/** The text of a "Remarks:" line after the word: the bill's note. */
function remarksText(line: Line): string {
  return line.text.replace(/^remarks?\s*:\s*/i, '').trim().slice(0, 200);
}

/** Reads one party statement. Bills come back in the order of the file. */
export function readStatement(items: readonly PdfText[]): { statement: Statement | null; error: string | null } {
  const lines = textLines(items);
  if (lines.length === 0) return { statement: null, error: 'This PDF has no text. Download the party statement from Kaarbar again.' };
  const all = lines.map((l) => l.text).join('\n');
  if (!/party statement/i.test(all)) return { statement: null, error: 'This is not a Kaarbar party statement.' };

  const headerAt = lines.findIndex(isTableHeader);
  const header = headerAt >= 0 ? lines[headerAt] : null;
  // The older layout: Debit / Credit / Running Balance, no bill Total.
  if (/\bdebit\b/i.test(all) && /\bcredit\b/i.test(all) && !/rec\s*\/?\s*paid/i.test(all)) return { statement: null, error: OLD_LAYOUT };
  if (!header) return { statement: null, error: 'The table (Date, Particulars, Total …) was not found in this PDF.' };
  const txCols = headerColumns(header, TX_TESTS);
  if (!txCols.some((c) => c.key === 'total') || !txCols.some((c) => c.key === 'paid')) return { statement: null, error: OLD_LAYOUT };

  // The name is the text after "Party Statement of" in its own cell (an
  // amount of the header can share its line).
  const nameSeg = lines.flatMap((l) => l.segs).find((s) => /party statement of/i.test(s.text))?.text ?? '';
  const partyName = (/party statement of\s+(.+?)(?=\s+total\s+sales\b|\s+(?:tk\.?|৳)\s*[\d,.]*$|$)/i.exec(nameSeg)?.[1] ?? '').trim();
  const phoneText = partyPhone(items, all);
  const totalMatch = /total\s+sales[^:\n]*:\s*(?:tk\.?|৳)?\s*(-?\d[\d,]*(?:\.\d+)?)/i.exec(all);
  const headerTotal = totalMatch ? Number(totalMatch[1].replace(/,/g, '')) : null;
  const receivablesMatch = /total\s+receivables?\s*:?\s*(?:tk\.?|৳)?\s*(-?\d[\d,]*(?:\.\d+)?)/i.exec(all);
  const totalReceivables = receivablesMatch ? Number(receivablesMatch[1].replace(/,/g, '')) : null;
  const generated = /report\s+generated\s+on\s*:?\s*(\d{1,2}\s+[A-Za-z]{3,9}\.?,?\s+\d{4})/i.exec(all)?.[1];
  const reportDate = generated ? parseDateCell(generated) : null;

  // Batch 54: every cell is read inside its own column (see segmentsOf).
  const txCuts = txCols.filter((c) => c.key !== 'date').map((c) => c.left);
  let itemCols: Column<ItemCol>[] | null = null;
  let itemCuts: number[] = [];
  const txs: RawTx[] = [];
  let tx: RawTx | null = null;
  let mode: 'head' | 'items' | 'remarks' = 'head';

  for (let i = headerAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isTableHeader(line) || isNoise(line)) continue;
    if (isItemHeader(line)) {
      itemCols = headerColumns(line, ITEM_TESTS);
      itemCuts = itemCols.filter((c) => c.key !== 'name').map((c) => c.left);
      if (tx) tx.sawItemHeader = true;
      mode = 'items';
      continue;
    }
    const tc = cells(cutLine(line, txCuts), txCols);
    if (tc.date && DATE_START.test(tc.date)) {
      tx = {
        dateText: tc.date,
        particulars: tc.particulars ?? '',
        totalText: tc.total ?? '',
        paidText: tc.paid ?? '',
        dueText: tc.due ?? '',
        note: '',
        items: [],
        sawItemHeader: false,
      };
      txs.push(tx);
      mode = 'head';
      continue;
    }
    if (/^remarks?\s*:/i.test(line.segs[0]?.text ?? '')) {
      if (tx && mode !== 'remarks' && tx.note === '') tx.note = remarksText(line);
      mode = 'remarks';
      continue;
    }
    if (!tx || mode === 'remarks') continue;
    if (mode === 'head') {
      // A date, bill number or amount that wrapped onto the next line.
      if (tc.date) tx.dateText += ` ${tc.date}`;
      if (tc.particulars) tx.particulars += ` ${tc.particulars}`;
      if (tc.total && !tx.totalText) tx.totalText = tc.total;
      if (tc.paid && !tx.paidText) tx.paidText = tc.paid;
      if (tc.due && !tx.dueText) tx.dueText = tc.due;
      continue;
    }
    if (itemCols) tx.items.push({ y: line.y, page: line.page, c: cells(cutLine(line, itemCuts), itemCols) });
  }

  // Item rows: the row with a Total is the item; the lines with only a
  // name (or a wrapped cell) around it belong to it. Cells are either
  // top-aligned (the wrapped lines come after the Total) or centred (the
  // wrapped lines sit around it): which one is decided over the whole file.
  const isAnchor = (l: RawItemLine) => tkAmount(l.c.total ?? '') !== null && parseQuantity(l.c.quantity ?? '') !== null;
  const centred = txs.some(
    (t) => (t.items.length > 0 && !isAnchor(t.items[0])) || t.items.some((l) => isAnchor(l) && !(l.c.name ?? '').trim())
  );

  let otherRows = 0;
  const bills: StatementBill[] = [];
  const payments: StatementPayment[] = [];
  for (const t of txs) {
    const p = t.particulars.replace(/\s+/g, ' ').trim();
    const kind: 'sale' | 'return' | null = /^sales?\s*return/i.test(p) ? 'return' : /^sale\b/i.test(p) ? 'sale' : null;
    const billNo = /#\s*([A-Za-z0-9][A-Za-z0-9/-]*)/.exec(p)?.[1] ?? '';
    if (!kind) {
      otherRows++;
      if (/^payment\s*in\b/i.test(p)) {
        const amount = tkAmount(t.paidText) || tkAmount(t.totalText) || 0;
        payments.push({ date: parseDateCell(t.dateText.replace(/\s+/g, ' ').trim()) ?? '', amount: Math.abs(amount) });
      }
      continue;
    }
    const date = parseDateCell(t.dateText.replace(/\s+/g, ' ').trim());
    const total = tkAmount(t.totalText);
    const lines = groupItems(t.items, isAnchor, centred);
    const products = lines.filter((l) => !l.isDelivery);
    const itemsTotal = round2(products.reduce((s, l) => s + l.total, 0));
    const delivery = round2(lines.filter((l) => l.isDelivery).reduce((s, l) => s + l.total, 0));
    bills.push({
      kind,
      billNo,
      date: date ?? '',
      total: total ?? 0,
      lines,
      itemsTotal,
      delivery,
      billDiscount: round2(itemsTotal + delivery - (total ?? 0)),
      paid: tkAmount(t.paidText),
      due: tkAmount(t.dueText),
      note: t.note,
    });
  }
  return {
    statement: {
      partyName,
      phone: phoneText,
      phoneKey: cleanPhone(phoneText),
      headerTotal,
      bills,
      otherRows,
      totalReceivables,
      reportDate,
      payments,
    },
    error: null,
  };
}

/* ---------------------------------------------- Batch 54: bill checks */

export type BillProblem =
  | { kind: 'short'; amount: number }
  | { kind: 'over'; amount: number }
  | { kind: 'maths'; name: string }
  | { kind: 'price-in-name'; name: string };

const PRICE_IN_NAME = /(?:\btk\.?|৳)\s*\d/i;

/**
 * What is wrong with a bill as read (the review page, the receipt page and
 * the old Step 2 card use the same checks):
 *  - the lines + delivery come to less than Kaarbar's total by more than
 *    ৳1 (a line was lost or misread). A positive whole-bill discount is
 *    normal in Kaarbar and never a problem;
 *  - a line where quantity × rate − its discount is not its total (±৳1);
 *  - a line name with a price inside ("… Tk. 499").
 */
export function billProblems(b: { total: number; lines: readonly Pick<StatementLine, 'name' | 'quantity' | 'rate' | 'discount' | 'total'>[] }): BillProblem[] {
  const out: BillProblem[] = [];
  const sum = round2(b.lines.reduce((s, l) => s + l.total, 0));
  if (sum - b.total < -1) out.push({ kind: 'short', amount: round2(b.total - sum) });
  for (const l of b.lines) {
    if (Math.abs(l.quantity * l.rate - l.discount - l.total) > 1) out.push({ kind: 'maths', name: l.name });
    if (PRICE_IN_NAME.test(l.name)) out.push({ kind: 'price-in-name', name: l.name });
  }
  return out;
}

/** The words for a problem; `tap` adds "Tap to check." (the lists). */
export function billProblemText(p: BillProblem, tap: boolean): string {
  const more = tap ? ' Tap to check.' : '';
  const money = (n: number) => moneyText(Math.round(n));
  switch (p.kind) {
    case 'short':
      return `Doesn't add up: ${money(p.amount)} less than Kaarbar's total.${more}`;
    case 'over':
      return `Doesn't add up: ${money(p.amount)} more than Kaarbar's total.${more}`;
    case 'maths':
      return `Line maths wrong: ${p.name}.${more}`;
    case 'price-in-name':
      return `Name holds a price: ${p.name}.${more}`;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function groupItems(raw: readonly RawItemLine[], isAnchor: (l: RawItemLine) => boolean, centred: boolean): StatementLine[] {
  const anchors = raw.map((l, i) => (isAnchor(l) ? i : -1)).filter((i) => i >= 0);
  if (anchors.length === 0) return [];
  const owner = raw.map((l, i) => {
    if (isAnchor(l)) return i;
    if (!centred) {
      const before = anchors.filter((a) => a < i);
      return before.length > 0 ? before[before.length - 1] : anchors[0];
    }
    // Centred: the nearest item row (pages count as far apart).
    let best = anchors[0];
    let bestD = Infinity;
    for (const a of anchors) {
      const d = raw[a].page === l.page ? Math.abs(raw[a].y - l.y) : 10000 + Math.abs(a - i);
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    return best;
  });
  return anchors.map((a) => {
    const parts = raw.filter((_, i) => owner[i] === a);
    const join = (k: ItemCol) => parts.map((p) => p.c[k] ?? '').filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const name = join('name');
    const q = parseQuantity(raw[a].c.quantity ?? '') ?? { quantity: 0, unit: null };
    // A unit word that wrapped onto the next line ("150" / "PCS").
    const unitWrapped = q.unit === null ? /^\s*\d[\d,.]*\s+([A-Za-z]{1,12})\s*$/.exec(join('quantity'))?.[1] : undefined;
    const key = itemKey(name);
    return {
      name,
      key,
      quantity: q.quantity,
      unit: unitWrapped ? normaliseUnit(unitWrapped) : q.unit,
      rate: tkAmount(raw[a].c.rate ?? '') ?? 0,
      discount: Math.max(0, tkAmount(raw[a].c.discount ?? '') ?? 0),
      total: tkAmount(raw[a].c.total ?? '') ?? 0,
      isDelivery: /^deliverycharges?$/.test(key),
    };
  });
}

/* ------------------------------------------------------- bills preview */

export type BillStatus = 'new' | 'already' | 'after' | 'unknown' | 'bad';

export interface BillPreview extends StatementBill {
  /** Which statement (file) it came from. */
  file: number;
  status: BillStatus;
  reason: string;
  unknown: string[];
}

export interface StatementPreview {
  file: number;
  fileName: string;
  statement: Statement;
  /** All Sale totals − returns in the file (both sides of the cut-off). */
  fileTotal: number;
  matches: boolean;
  toAdd: number;
  after: number;
  bills: BillPreview[];
}

export function billKey(b: Pick<StatementBill, 'kind' | 'billNo'>): string {
  return `${b.kind}:${b.billNo}`;
}

export interface BillContext {
  cutoff: string;
  /** "sale:SS0858" for every bill already added. */
  done: ReadonlySet<string>;
  /** Step 1 items by name key. */
  items: ReadonlyMap<string, SavedItem>;
}

export function previewStatements(files: readonly { fileName: string; statement: Statement }[], ctx: BillContext): StatementPreview[] {
  const seen = new Set<string>();
  return files.map((f, file) => {
    const s = f.statement;
    const fileTotal = round2(s.bills.reduce((sum, b) => sum + (b.kind === 'return' ? -b.total : b.total), 0));
    const matches = s.headerTotal !== null && Math.abs(fileTotal - s.headerTotal) < 1;
    const bills = s.bills.map((b): BillPreview => {
      const out = (status: BillStatus, reason: string, unknown: string[] = []): BillPreview => ({ ...b, file, status, reason, unknown });
      if (!b.billNo) return out('bad', 'no bill number');
      if (!b.date) return out('bad', 'date not readable');
      if (b.date > ctx.cutoff) return out('after', 'after the cut-off');
      const key = billKey(b);
      if (ctx.done.has(key)) return out('already', 'already added');
      if (seen.has(key)) return out('already', 'in another file too');
      if (b.lines.length === 0) return out('bad', 'no items read');
      if (b.lines.some((l) => l.quantity <= 0)) return out('bad', 'a quantity is not readable');
      // Batch 54: a bill that doesn't add up (a line lost or misread) is never imported.
      const problem = billProblems(b)[0];
      if (problem) return out('bad', billProblemText(problem, false));
      seen.add(key);
      const unknown = [...new Set(b.lines.filter((l) => !l.isDelivery && !ctx.items.has(l.key)).map((l) => l.name))];
      if (unknown.length > 0) return out('unknown', 'unknown item', unknown);
      return out('new', 'new');
    });
    return {
      file,
      fileName: f.fileName,
      statement: s,
      fileTotal,
      matches,
      toAdd: bills.filter((b) => b.status === 'new').length,
      after: bills.filter((b) => b.status === 'after').length,
      bills,
    };
  });
}

export interface BillCounts {
  toAdd: number;
  already: number;
  after: number;
  unknown: number;
  bad: number;
}

export function billCounts(previews: readonly StatementPreview[]): BillCounts {
  const all = previews.flatMap((p) => p.bills);
  const n = (s: BillStatus) => all.filter((b) => b.status === s).length;
  return { toAdd: n('new'), already: n('already'), after: n('after'), unknown: n('unknown'), bad: n('bad') };
}

/* ------------------------------------------------------- per-unit cost */

export interface UnitNeed {
  itemId: string;
  itemName: string;
  unit: string;
  /** Worked out from the pack size, if the site product has one in this unit. */
  suggested: number | null;
  /** The highest price one unit was sold for (a sanity check). */
  maxRate: number;
}

/**
 * Cost of one unit from the cost of a pack, when the site product's pack
 * is in the same unit (a 473 ml bottle → per ml). Null when it can't be
 * worked out, or when it would cost more than twice what one unit was
 * sold for (a bottle's price is not the price of one capsule).
 */
export function derivedUnitCost(costPerPack: number, choice: Pick<SiteChoice, 'stockUnit' | 'packSize'> | null, unit: string, maxRate: number): number | null {
  if (!choice || costPerPack <= 0 || choice.packSize < 1 || normaliseUnit(choice.stockUnit) !== unit) return null;
  const cost = Math.round((costPerPack / choice.packSize) * 10000) / 10000;
  if (maxRate > 0 && cost > maxRate * 2) return null;
  return cost;
}

/** Every item + unit sold in the bills to add whose price of one unit is
 *  not in the Step 1 list yet. */
export function unitNeeds(
  bills: readonly BillPreview[],
  items: ReadonlyMap<string, SavedItem>,
  choices: readonly SiteChoice[]
): UnitNeed[] {
  const map = new Map<string, UnitNeed>();
  for (const b of bills) {
    if (b.status !== 'new') continue;
    for (const l of b.lines) {
      if (l.isDelivery || l.unit === null) continue;
      const item = items.get(l.key);
      if (!item || item.unitCosts[l.unit] !== undefined) continue;
      const k = `${item.id}:${l.unit}`;
      const need = map.get(k) ?? { itemId: item.id, itemName: item.name, unit: l.unit, suggested: null, maxRate: 0 };
      need.maxRate = Math.max(need.maxRate, l.rate);
      map.set(k, need);
    }
  }
  return [...map.values()]
    .map((n) => {
      const item = [...items.values()].find((i) => i.id === n.itemId) ?? null;
      const choice = item ? (choices.find((c) => c.productId === item.productId && c.variantId === item.variantId) ?? null) : null;
      return { ...n, suggested: item ? derivedUnitCost(item.costPerPack, choice, n.unit, n.maxRate) : null };
    })
    .sort((a, b) => a.itemName.localeCompare(b.itemName) || a.unit.localeCompare(b.unit));
}

export function unitWord(unit: string): string {
  if (unit === 'pcs') return 'piece';
  return unit;
}

/* ---------------------------------------------- whole-bill discount */

/**
 * A whole-bill discount spread over the bill's product lines by their
 * totals, in whole paisa; leftover paisa go to the largest remainders
 * (the same rule as the database and as discounts on site orders).
 */
export function spreadDiscount(lineTotals: readonly number[], discount: number): number[] {
  const lp = lineTotals.map((t) => Math.round(t * 100));
  const tp = lp.reduce((s, v) => s + v, 0);
  if (tp <= 0) return lineTotals.map(() => 0);
  const dp = Math.min(Math.round(discount * 100), tp);
  if (dp <= 0) return lineTotals.map(() => 0);
  const floors = lp.map((v) => Math.floor((dp * v) / tp));
  const rems = lp.map((v, i) => ({ i, r: (dp * v) % tp }));
  let left = dp - floors.reduce((s, v) => s + v, 0);
  rems.sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of rems) {
    if (left <= 0) break;
    floors[i] += 1;
    left--;
  }
  return floors.map((v) => v / 100);
}

/* ---------------------------------------------------------- import rows */

export interface BillImportRow {
  kind: 'sale' | 'return';
  bill_no: string;
  date: string;
  customer_key: string | null;
  phone_key: string | null;
  party_name: string;
  party_phone: string | null;
  items_total: number;
  bill_discount: number;
  delivery: number;
  bill_total: number;
  lines: {
    item_id: string;
    kaarbar_name: string;
    quantity: number;
    unit: string | null;
    rate: number;
    line_discount: number;
    line_total: number;
  }[];
}

export function billImportRows(
  previews: readonly StatementPreview[],
  items: ReadonlyMap<string, SavedItem>,
  customers: ReadonlyMap<number, string | null>
): BillImportRow[] {
  const out: BillImportRow[] = [];
  for (const p of previews) {
    if (!p.matches) continue;
    for (const b of p.bills) {
      if (b.status !== 'new') continue;
      const lines = b.lines.filter((l) => !l.isDelivery);
      out.push({
        kind: b.kind,
        bill_no: b.billNo,
        date: b.date,
        customer_key: customers.get(p.file) ?? null,
        phone_key: p.statement.phoneKey,
        party_name: p.statement.partyName || p.fileName,
        party_phone: p.statement.phone || null,
        items_total: b.itemsTotal,
        bill_discount: b.billDiscount,
        delivery: b.delivery,
        bill_total: b.total,
        lines: lines.map((l) => ({
          item_id: items.get(l.key)?.id ?? '',
          kaarbar_name: l.name,
          quantity: l.quantity,
          unit: l.unit,
          rate: l.rate,
          line_discount: l.discount,
          line_total: l.total,
        })),
      });
    }
  }
  return out;
}

/* ===================================== Correct previous balance (Part 4) */

export interface CorrectionView {
  /** The typed amount, or null while it isn't a valid amount (0 allowed). */
  value: number | null;
  error: string | null;
  /** What the "Total due" becomes. */
  totalDue: number;
  /** New − now (what is stored as the change). */
  change: number;
}

export function correctionView(now: number, typed: string, siteOrdersDue: number): CorrectionView {
  const clean = typed.replace(/[৳,\s]/g, '');
  const n = clean === '' ? null : Number(clean);
  const value = n !== null && Number.isFinite(n) && /^\d+(\.\d{1,2})?$/.test(clean) ? n : null;
  let error: string | null = null;
  if (clean === '') error = null;
  else if (/^-/.test(clean)) error = 'The amount can’t be below 0.';
  else if (value === null) error = 'Type an amount like 1500.';
  else if (Math.round(value * 100) === Math.round(now * 100)) error = 'That is the amount already.';
  const usable = value !== null && error === null;
  return {
    value: usable ? value : null,
    error,
    totalDue: Math.round(((usable ? value : now) + siteOrdersDue) * 100) / 100,
    change: usable ? Math.round((value - now) * 100) / 100 : 0,
  };
}
