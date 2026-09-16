import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { Product } from '../../types';
import { productUrl, shareProduct } from '../../lib/share';
import { buildCopyText, copyToClipboard } from '../../lib/clipboard';
import { useToast } from '../../hooks/useToast';
import { useAdminEdit } from '../../contexts/AdminEditContext';

interface CardMenuProps {
  product: Product;
  /** The card's displayed price (its "from" price when it has variants) — same
   *  figure the removed card button used to copy. */
  copyPrice: number;
  outOfStock: boolean;
}

/**
 * The "..." overlay on a product card image and its popup. Every handler stops
 * propagation so opening the menu never navigates to the product detail page.
 */
export function CardMenu({ product, copyPrice, outOfStock }: CardMenuProps) {
  const { showToast } = useToast();
  const { isEditMode, openProductEdit } = useAdminEdit();
  const [isOpen, setIsOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on a tap anywhere outside the menu, or on Escape.
  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setIsOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const stop = (e: MouseEvent) => e.stopPropagation();

  const handleShare = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    setIsOpen(false);
    void shareProduct(product, showToast);
  };

  const handleEdit = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    setIsOpen(false);
    openProductEdit(product);
  };

  const handleCopyLink = async (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    setIsOpen(false);
    const ok = await copyToClipboard(productUrl(product));
    showToast(ok ? 'Link copied' : 'Could not copy link', ok ? 'success' : 'error');
  };

  const handleCopyPrice = async (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    setIsOpen(false);
    const ok = await copyToClipboard(buildCopyText(product, copyPrice));
    showToast(ok ? 'Copied to clipboard' : 'Could not copy', ok ? 'success' : 'error');
  };

  return (
    <div className="card-menu" ref={wrapRef} onClick={stop}>
      <button
        type="button"
        className="card-menu__trigger"
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen((open) => !open);
        }}
        aria-label={`More options for ${product.name}`}
        aria-expanded={isOpen}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.9" />
          <circle cx="12" cy="12" r="1.9" />
          <circle cx="19" cy="12" r="1.9" />
        </svg>
      </button>

      {isOpen && (
        <div className="card-menu__popup" role="menu">
          {/* Admin-only, and only while Edit Mode is on. */}
          {isEditMode && (
            <button
              type="button"
              className="card-menu__item card-menu__item--edit"
              role="menuitem"
              onClick={handleEdit}
            >
              Edit Product
            </button>
          )}
          <button
            type="button"
            className="card-menu__item"
            role="menuitem"
            onClick={handleShare}
          >
            Share Product
          </button>
          <button
            type="button"
            className="card-menu__item"
            role="menuitem"
            onClick={handleCopyLink}
          >
            Copy Link
          </button>
          {outOfStock ? (
            <span className="card-menu__item card-menu__item--disabled" aria-disabled="true">
              Copy Price
              <span className="card-menu__hint">Out of Stock</span>
            </span>
          ) : (
            <button
              type="button"
              className="card-menu__item"
              role="menuitem"
              onClick={handleCopyPrice}
            >
              Copy Price
            </button>
          )}
          <span className="card-menu__item card-menu__item--disabled" aria-disabled="true">
            Save
            <span className="card-menu__hint">Coming Soon</span>
          </span>
        </div>
      )}
    </div>
  );
}
