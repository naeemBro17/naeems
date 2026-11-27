// Batch 72: "Complete your routine" (side cart + product page), the
// occasional question in the side cart, and Home's "Picked for you".
import type { Category, Product } from '../types';
import { inCategory, productCategoryIds } from './categoryFilter';
import { productHasConcern, sameConcern } from './concerns';
import { isInStock } from './stockStatus';

export interface RoutineRule {
  from: string;
  to: string;
}

export interface RoutineQuestion {
  text: string;
  concern: string;
}

/** The signed-in customer's "My skin" answers. */
export interface SkinProfile {
  skinType: string | null;
  concerns: string[];
  wants: string[];
}

export interface RoutinePick {
  product: Product;
  /** The small caps word on the card (the category name). */
  label: string;
}

export interface RoutineResult {
  picks: RoutinePick[];
  /** "for your <this>": the category of the product a rule matched; null
   *  when the picks came from "same concern or brand". */
  forCategory: string | null;
}

export const ROUTINE_MAX = 6;
export const QUESTION_TEXT_MAX = 40;

/** What a customer can answer for "What do you want right now?". */
export const SKIN_WANTS = ['A simple routine', 'Clearer skin', 'Even tone', 'Glow', 'Sun protection'] as const;

const WANT_CONCERNS: Record<string, readonly string[]> = {
  'Clearer skin': ['Acne'],
  'Even tone': ['Hyperpigmentation', 'Dark Spots', 'Brightening'],
  Glow: ['Brightening', 'Hydration', 'Dehydrated'],
};

/** Category-name words a want matches (lowercase, start of a word). */
const WANT_CATEGORY_WORDS: Record<string, readonly string[]> = {
  'Sun protection': ['sun'],
  'A simple routine': ['cleanser', 'moistur', 'sun'],
};

function parseJsonList(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseRoutineRules(raw: string | null | undefined): RoutineRule[] {
  const out: RoutineRule[] = [];
  for (const item of parseJsonList(raw)) {
    if (!isRecord(item) || typeof item.from !== 'string' || typeof item.to !== 'string') continue;
    if (item.from === '' || item.to === '' || item.from === item.to) continue;
    out.push({ from: item.from, to: item.to });
  }
  return out;
}

export function parseRoutineQuestions(raw: string | null | undefined): RoutineQuestion[] {
  const out: RoutineQuestion[] = [];
  for (const item of parseJsonList(raw)) {
    if (!isRecord(item) || typeof item.text !== 'string' || typeof item.concern !== 'string') continue;
    const text = item.text.trim().slice(0, QUESTION_TEXT_MAX);
    if (text === '' || item.concern.trim() === '') continue;
    out.push({ text, concern: item.concern.trim() });
  }
  return out;
}

/** "Same concern or brand" is on unless Naeem switched it off. */
export function isFallbackOn(raw: string | null | undefined): boolean {
  return raw !== '0';
}

/** The default rules, by category name (skipped when a name is missing). */
export function defaultRoutineRules(categories: Pick<Category, 'id' | 'name'>[]): RoutineRule[] {
  const idOf = (name: string) => categories.find((c) => c.name.trim().toLowerCase() === name.toLowerCase())?.id ?? null;
  const pairs: [string, string][] = [
    ['Moisturizer', 'Cleanser'],
    ['Cleanser', 'Moisturizer'],
    ['Sunscreen', 'Oil cleanser'],
    ['Serum', 'Sunscreen'],
  ];
  const out: RoutineRule[] = [];
  for (const [from, to] of pairs) {
    const a = idOf(from);
    const b = idOf(to);
    if (a && b) out.push({ from: a, to: b });
  }
  return out;
}

function brandKey(p: Product): string | null {
  if (p.brand_id) return `id:${p.brand_id}`;
  const name = p.brand?.trim().toLowerCase() ?? '';
  return name === '' ? null : `name:${name}`;
}

/** How well a product fits the customer's skin (0 = no profile or no fit). */
export function profileScore(p: Product, profile: SkinProfile | null): number {
  if (!profile) return 0;
  let score = 0;
  if (profile.skinType && (p.skin_types ?? []).includes(profile.skinType)) score += 2;
  for (const c of profile.concerns) if (productHasConcern(p.skin_conditions, c)) score += 3;
  return score;
}

function byFit(anchor: Product, profile: SkinProfile | null) {
  const brand = brandKey(anchor);
  return (a: Product, b: Product): number =>
    profileScore(b, profile) - profileScore(a, profile) ||
    Number(b.is_featured) - Number(a.is_featured) ||
    Number(brand !== null && brandKey(b) === brand) - Number(brand !== null && brandKey(a) === brand) ||
    b.created_at.localeCompare(a.created_at) ||
    a.name.localeCompare(b.name);
}

/**
 * Products that complete a routine with `anchor` (the product just added,
 * or the product page's product). Never: the anchor, anything in
 * `exclude` (the cart), hidden or out-of-stock products. First Naeem's
 * rules for any of the anchor's categories (in his order), the customer's
 * fit first; else, when the fallback is on, products sharing a concern,
 * then the same brand.
 */
export function routineSuggestions(args: {
  anchor: Product;
  catalogue: Product[];
  categories: Pick<Category, 'id' | 'name'>[];
  rules: RoutineRule[];
  fallback: boolean;
  exclude: ReadonlySet<string>;
  profile: SkinProfile | null;
  max?: number;
}): RoutineResult {
  const { anchor, catalogue, categories, rules, fallback, exclude, profile } = args;
  const max = args.max ?? ROUTINE_MAX;
  const nameOf = (id: string | null) => categories.find((c) => c.id === id)?.name ?? '';
  const pool = catalogue.filter((p) => p.id !== anchor.id && !exclude.has(p.id) && p.is_active && isInStock(p));
  const anchorCats = productCategoryIds(anchor);
  const matched = rules.filter((r) => anchorCats.includes(r.from));

  const picks: RoutinePick[] = [];
  const taken = new Set<string>();
  for (const rule of matched) {
    const inTarget = pool.filter((p) => !taken.has(p.id) && inCategory(p, rule.to)).sort(byFit(anchor, profile));
    for (const p of inTarget) {
      picks.push({ product: p, label: nameOf(rule.to) });
      taken.add(p.id);
    }
  }
  if (picks.length > 0) {
    return { picks: picks.slice(0, max), forCategory: nameOf(matched[0].from) };
  }
  if (!fallback) return { picks: [], forCategory: null };

  const concerns = anchor.skin_conditions ?? [];
  const brand = brandKey(anchor);
  const similar = pool
    .filter((p) => concerns.some((c) => productHasConcern(p.skin_conditions, c)) || (brand !== null && brandKey(p) === brand))
    .sort(
      (a, b) =>
        Number(concerns.some((c) => productHasConcern(b.skin_conditions, c))) -
          Number(concerns.some((c) => productHasConcern(a.skin_conditions, c))) || byFit(anchor, profile)(a, b)
    )
    .slice(0, max)
    .map((p) => ({ product: p, label: nameOf(p.category_id) }));
  return { picks: similar, forCategory: null };
}

/** The question card shows on every 4th side-cart open (opens 4, 8, 12...). */
export function shouldAsk(openCount: number): boolean {
  return openCount > 0 && openCount % 4 === 0;
}

/**
 * Which question to show: skip one whose concern she already told us, or
 * one a product in her cart is already for; then rotate by the open count.
 */
export function pickQuestion(
  questions: RoutineQuestion[],
  openCount: number,
  skipConcerns: readonly string[]
): RoutineQuestion | null {
  const usable = questions.filter((q) => !skipConcerns.some((c) => sameConcern(c, q.concern)));
  if (usable.length === 0) return null;
  return usable[Math.floor(openCount / 4) % usable.length];
}

export interface PickedItem {
  product: Product;
  /** The green word on the card: the concern, want or skin type it fits. */
  why: string;
}

/** Below this many, Home shows Best sellers instead. */
export const PICKED_MIN = 3;
export const PICKED_MAX = 10;

function wantsCategory(want: string, categoryName: string): boolean {
  const words = WANT_CATEGORY_WORDS[want] ?? [];
  const name = categoryName.toLowerCase();
  return words.some((w) => name.split(/[^a-z]+/).some((part) => part.startsWith(w)));
}

/** Home's "Picked for you": in-stock products that fit her answers. */
export function pickedForYou(
  catalogue: Product[],
  profile: SkinProfile,
  categories: Pick<Category, 'id' | 'name'>[]
): PickedItem[] {
  const rows: { product: Product; score: number; why: string }[] = [];
  for (const p of catalogue) {
    if (!p.is_active || !isInStock(p)) continue;
    let score = 0;
    let why = '';
    for (const c of profile.concerns) {
      if (productHasConcern(p.skin_conditions, c)) {
        score += 3;
        if (why === '') why = c;
      }
    }
    const catNames = productCategoryIds(p).map((id) => categories.find((c) => c.id === id)?.name ?? '');
    for (const w of profile.wants) {
      const byConcern = (WANT_CONCERNS[w] ?? []).some((c) => productHasConcern(p.skin_conditions, c));
      const byCategory = catNames.some((n) => wantsCategory(w, n));
      if (byConcern || byCategory) {
        score += 2;
        if (why === '') why = w;
      }
    }
    if (profile.skinType && (p.skin_types ?? []).includes(profile.skinType)) {
      score += 2;
      if (why === '') why = profile.skinType;
    }
    if (score > 0) rows.push({ product: p, score, why });
  }
  const picked = rows
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.product.is_featured) - Number(a.product.is_featured) ||
        b.product.created_at.localeCompare(a.product.created_at)
    )
    .slice(0, PICKED_MAX)
    .map(({ product, why }) => ({ product, why }));
  return picked.length < PICKED_MIN ? [] : picked;
}

/** "For combination skin, acne and even tone". "" when nothing to say. */
export function pickedForYouLine(profile: SkinProfile): string {
  const parts: string[] = [];
  if (profile.skinType) parts.push(`${profile.skinType.toLowerCase()} skin`);
  for (const c of profile.concerns.slice(0, 2)) parts.push(c.toLowerCase());
  if (parts.length === 0) return '';
  const last = parts.pop() as string;
  return `For ${parts.length > 0 ? `${parts.join(', ')} and ${last}` : last}`;
}

/** The profile row's answers, or null when she has none / the SQL is not run. */
export function skinProfileOf(profile: {
  skin_type?: string | null;
  skin_concerns?: string[] | null;
  skin_wants?: string[] | null;
} | null): SkinProfile | null {
  if (!profile) return null;
  const skinType = profile.skin_type ?? null;
  const concerns = profile.skin_concerns ?? [];
  const wants = profile.skin_wants ?? [];
  if (skinType === null && concerns.length === 0 && wants.length === 0) return null;
  return { skinType, concerns, wants };
}
