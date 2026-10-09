import type { MouseEvent } from 'react';

/** Batch 35 Part 9: the props every shop product photo gets (cards, the
 *  product page gallery, brand pages, search) — no right-click menu, no
 *  dragging; the CSS class removes the long-press "Save image" menu and
 *  selection. Never used in the admin, where photos are dragged to reorder. */
export const protectedImageProps = {
  draggable: false,
  onContextMenu: (event: MouseEvent<HTMLImageElement>) => event.preventDefault(),
} as const;

export const PROTECTED_IMAGE_CLASS = 'protected-image';
