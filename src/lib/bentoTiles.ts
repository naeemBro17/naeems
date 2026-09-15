import type { BentoTile, BentoTileFormData } from '../types';

/** Columns selected wherever bento tiles are read. */
export const BENTO_TILE_SELECT =
  'id, title, subtitle, image_url, link_url, sort_order, is_active, created_at';

/** Blank form state for the admin "add tile" form. */
export function emptyBentoTileForm(): BentoTileFormData {
  return {
    title: '',
    subtitle: '',
    image_url: '',
    link_url: '',
    sort_order: '0',
    is_active: true,
  };
}

/** Populate the admin form from an existing row. */
export function bentoTileToForm(tile: BentoTile): BentoTileFormData {
  return {
    title: tile.title,
    subtitle: tile.subtitle ?? '',
    image_url: tile.image_url ?? '',
    link_url: tile.link_url,
    sort_order: String(tile.sort_order),
    is_active: tile.is_active,
  };
}

/**
 * A link starting with '/' is a route inside this app and is navigated
 * client-side; anything else opens in a new tab.
 */
export function isInternalLink(url: string): boolean {
  return url.startsWith('/');
}
