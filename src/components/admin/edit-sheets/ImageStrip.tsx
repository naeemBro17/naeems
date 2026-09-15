import type { CSSProperties } from 'react';
import { useDragReorder } from '../../../hooks/useDragReorder';

interface ImageStripProps {
  images: string[];
  onChange: (next: string[]) => void;
  onRemove: (url: string) => void;
}

/** Hold time on the handle before a thumbnail lifts. */
const HANDLE_LONG_PRESS_MS = 500;

function HandleGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="9" cy="6" r="1.7" />
      <circle cx="15" cy="6" r="1.7" />
      <circle cx="9" cy="12" r="1.7" />
      <circle cx="15" cy="12" r="1.7" />
      <circle cx="9" cy="18" r="1.7" />
      <circle cx="15" cy="18" r="1.7" />
    </svg>
  );
}

/**
 * Horizontal row of product image thumbnails. The first image is the cover
 * shown on the card, so it carries a "Cover" label that follows whichever
 * thumbnail is first. A 500ms long press on a thumbnail's handle lifts it;
 * dragging left or right slides the others aside; releasing drops it into
 * the new position. Reordering changes the draft only — the sheet's Save
 * persists it.
 */
export function ImageStrip({ images, onChange, onRemove }: ImageStripProps) {
  const drag = useDragReorder<string>({
    items: images,
    onReorder: (next) => onChange(next),
    mode: 'move',
    axis: 'x',
    enabled: images.length > 1,
    longPressMs: HANDLE_LONG_PRESS_MS,
  });

  return (
    <div className="image-strip" role="list" aria-label="Product images in display order">
      {images.map((url, index) => {
        const isDragged = drag.dragIndex === index;
        const style: CSSProperties = {};
        if (isDragged) {
          style.transform = `translateX(${drag.delta.x}px) scale(1.03)`;
        } else {
          const shift = drag.shiftFor(index);
          if (shift !== 0) style.transform = `translateX(${shift}px)`;
        }
        return (
          <div
            key={url}
            role="listitem"
            ref={drag.registerItem(index)}
            className={`image-strip__item${isDragged ? ' image-strip__item--dragging' : ''}${
              isDragged && drag.isDragging ? ' image-strip__item--live' : ''
            }`}
            style={style}
          >
            <img className="image-strip__thumb" src={url} alt={`Product image ${index + 1}`} />
            {index === 0 && <span className="image-strip__cover">Cover</span>}
            <button
              type="button"
              className="image-strip__remove"
              onClick={() => onRemove(url)}
              aria-label={`Remove image ${index + 1}`}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
            {images.length > 1 && (
              <span
                ref={drag.registerHandle(index)}
                className="image-strip__handle"
                role="button"
                tabIndex={-1}
                aria-label={`Hold to drag image ${index + 1}`}
              >
                <HandleGlyph />
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
