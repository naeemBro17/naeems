import { parseIdList } from './settingsLists';

/* ---------- Bento tiles ---------- */

/**
 * Tile identities. The names describe each tile's default position; after a
 * swap the identity stays with the tile's contents, not the slot.
 */
export type BentoTileId = 'left' | 'right_top' | 'right_bottom';

export const DEFAULT_BENTO_ORDER: BentoTileId[] = ['left', 'right_top', 'right_bottom'];

/** Grid placement for one tile, expressed as CSS grid line values. */
export interface BentoPlacement {
  gridColumn: string;
  gridRow: string;
}

/**
 * Where each tile sits for a given order. The 'left' tile is tall and always
 * spans both rows, so it owns a whole column: position 0 is the first column,
 * anything else is the second. The two short tiles stack in the other column
 * in the order they appear.
 */
export function bentoPlacements(order: BentoTileId[]): Record<BentoTileId, BentoPlacement> {
  const tallIndex = order.indexOf('left');
  const tallColumn = tallIndex === 0 ? 1 : 2;
  const shortColumn = tallColumn === 1 ? 2 : 1;
  const shorts = order.filter((id) => id !== 'left');

  const placements = {} as Record<BentoTileId, BentoPlacement>;
  placements.left = { gridColumn: String(tallColumn), gridRow: 'span 2' };
  shorts.forEach((id, i) => {
    placements[id] = { gridColumn: String(shortColumn), gridRow: String(i + 1) };
  });
  return placements;
}

/* ---------- Homepage sections ---------- */

export type HomeSectionId = 'hero' | 'browse' | 'bento' | 'chips' | 'products';

export const DEFAULT_SECTION_ORDER: HomeSectionId[] = [
  'hero',
  'browse',
  'bento',
  'chips',
  'products',
];

/** Sections the admin may drag. 'products' is pinned last and never listed. */
export const REORDERABLE_SECTIONS: Exclude<HomeSectionId, 'products'>[] = [
  'hero',
  'browse',
  'bento',
  'chips',
];

/* ---------- Shared parsing ---------- */

/**
 * Read a saved id order, tolerating anything: unknown ids are dropped,
 * missing ids are appended in default order, and a pinned id (if given) is
 * forced to the end. An empty or malformed value yields the default.
 */
export function readOrder<Id extends string>(
  raw: string,
  defaults: readonly Id[],
  pinnedLast?: Id
): Id[] {
  const known = new Set<string>(defaults);
  const saved = parseIdList(raw).filter((id): id is Id => known.has(id));
  const seen = new Set<Id>();
  const result: Id[] = [];
  for (const id of [...saved, ...defaults]) {
    if (seen.has(id) || id === pinnedLast) continue;
    seen.add(id);
    result.push(id);
  }
  if (pinnedLast !== undefined) result.push(pinnedLast);
  return result;
}
