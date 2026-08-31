import type { MouseEvent } from 'react';
import type { Product } from '../../types';
import { shareProduct } from '../../lib/share';
import { useToast } from '../../hooks/useToast';

interface ShareButtonProps {
  product: Product;
  /** 'card' = small circular overlay on the image; 'header' = detail page header icon. */
  variant: 'card' | 'header';
}

/**
 * "Share This Product" control on the detail page header. Opens the OS share
 * sheet immediately on tap — there is nothing to wait on.
 */
export function ShareButton({ product, variant }: ShareButtonProps) {
  const { showToast } = useToast();

  const handleShare = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    void shareProduct(product, showToast);
  };

  return (
    <button
      type="button"
      className={`share-button share-button--${variant}`}
      onClick={handleShare}
      aria-label={`Share ${product.name} with a friend`}
    >
      <svg
        className="share-button__icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="18" cy="5" r="3" />
        <circle cx="6" cy="12" r="3" />
        <circle cx="18" cy="19" r="3" />
        <path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98" />
      </svg>
    </button>
  );
}
