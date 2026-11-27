// Batch 72: the one list of concerns (acne, anti aging...). Products carry
// them in products.skin_conditions; Naeem adds new ones right from the
// product editor; the list itself lives in app_settings.concern_list.

/** Until Naeem adds his own: the old tags plus Home's concern cards. */
export const DEFAULT_CONCERN_LIST: readonly string[] = [
  'Acne',
  'Hyperpigmentation',
  'Dark Spots',
  'Anti aging',
  'Sensitive',
  'Dehydrated',
  'Hydration',
  'Brightening',
  'Redness',
  'Uneven Texture',
];

/** The longest concern name. */
export const CONCERN_MAX = 24;

/** "Anti-Aging", "anti aging" and "Anti aging" are the same concern. */
export function concernKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function sameConcern(a: string, b: string): boolean {
  return concernKey(a) === concernKey(b);
}

/** app_settings.concern_list (a JSON array of names); unset = the defaults. */
export function parseConcernList(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined || raw.trim() === '') return [...DEFAULT_CONCERN_LIST];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [...DEFAULT_CONCERN_LIST];
  }
  if (!Array.isArray(parsed)) return [...DEFAULT_CONCERN_LIST];
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string') continue;
    const name = item.trim().slice(0, CONCERN_MAX);
    if (name === '' || out.some((n) => sameConcern(n, name))) continue;
    out.push(name);
  }
  return out;
}

/** The list with one more name (unchanged when it is already there). */
export function withConcern(list: readonly string[], name: string): string[] {
  const clean = name.trim().slice(0, CONCERN_MAX);
  if (clean === '' || list.some((n) => sameConcern(n, clean))) return [...list];
  return [...list, clean];
}

/** Names from the list that start with (or contain) what was typed. */
export function matchConcerns(list: readonly string[], typed: string): string[] {
  const k = concernKey(typed);
  if (k === '') return [];
  const starts = list.filter((n) => concernKey(n).startsWith(k));
  const contains = list.filter((n) => !starts.includes(n) && concernKey(n).includes(k));
  return [...starts, ...contains];
}

export function productHasConcern(conditions: readonly string[] | null | undefined, concern: string): boolean {
  return (conditions ?? []).some((c) => sameConcern(c, concern));
}
