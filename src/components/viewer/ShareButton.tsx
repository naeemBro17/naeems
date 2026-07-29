import { useState, type MouseEvent } from 'react';
import type { Product } from '../../types';
import { shareProduct } from '../../lib/shareCard';
import { useToast } from '../../hooks/useToast';

interface ShareButtonProps {
  product: Product;
  /** 'card' = small circular overlay on the image; 'header' = detail page header icon. */
  variant: 'card' | 'header';
}

/**
 * Shared "Share This Product" control. Renders a spinner and blocks further
 * taps while the branded image is being generated, then returns to the icon.
 * stopPropagation keeps a card-level tap from navigating to the detail page.
 */
export function ShareButton({ product, variant }: ShareButtonProps) {
  const { showToast } = useToast();
  const [isSharing, setIsSharing] = useState(false);

  const handleShare = async (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (isSharing) return;
    setIsSharing(true);
    try {
      await shareProduct(product, showToast);
    } finally {
      setIsSharing(false);
    }
  };

  return (
    <button
      type="button"
      className={`share-button share-button--${variant}`}
      onClick={handleShare}
      disabled={isSharing}
      aria-label={`Share ${product.name} with a friend`}
    >
      {isSharing ? (
        <span className="spinner spinner--share" aria-hidden="true" />
      ) : (
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
      )}
    </button>
  );
}
