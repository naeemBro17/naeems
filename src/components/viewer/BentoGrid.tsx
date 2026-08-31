import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AppSettings, Product } from '../../types';
import { getDisplayPrice } from '../../lib/pricing';
import { formatTaka } from '../../lib/format';
import { isOutOfStock } from '../../lib/stockStatus';

interface BentoGridProps {
  products: Product[];
  settings: AppSettings;
}

/** Faces per rotating tile — the flip animation shows exactly two. */
const FACES_PER_TILE = 2;

function PriceLine({ product }: { product: Product }) {
  const { mainPrice, strikePrice, savePercent } = getDisplayPrice(product);
  const outOfStock = isOutOfStock(product);

  return (
    <div className="bento-tile__price-row">
      <span
        className={`bento-tile__price${outOfStock ? ' bento-tile__price--out' : ''}`}
      >
        {formatTaka(mainPrice)}
      </span>
      {strikePrice !== null && (
        <span className="bento-tile__strike">{formatTaka(strikePrice)}</span>
      )}
      {savePercent !== null && !outOfStock && (
        <span className="bento-tile__save">Save {savePercent}%</span>
      )}
    </div>
  );
}

function TileFace({
  product,
  onOpen,
  face,
}: {
  product: Product;
  onOpen: (sku: string) => void;
  face: 'front' | 'back';
}) {
  return (
    <div
      className={`bento-face bento-face--${face}`}
      role="button"
      tabIndex={-1}
      onClick={() => onOpen(product.sku)}
    >
      {product.category && (
        <span className="bento-tile__category">{product.category.name}</span>
      )}
      <h3 className="bento-tile__name">{product.name}</h3>
      <PriceLine product={product} />
    </div>
  );
}

/**
 * One rotating tile. Both faces exist in the DOM at once and the wrapper is
 * flipped around the X axis by CSS, so the two products alternate without any
 * JavaScript timer.
 */
function FlipTile({
  faces,
  size,
  stagger,
  onOpen,
}: {
  faces: Product[];
  size: 'tall' | 'short';
  /** Offsets the shared 8s animation so the two tiles never flip together. */
  stagger: boolean;
  onOpen: (sku: string) => void;
}) {
  const [front, back] = faces;
  return (
    <div className={`bento-tile bento-tile--${size}`}>
      <div
        className={`bento-flipper${stagger ? ' bento-flipper--stagger' : ''}${
          back ? '' : ' bento-flipper--static'
        }`}
      >
        <TileFace product={front} onOpen={onOpen} face="front" />
        {back && <TileFace product={back} onOpen={onOpen} face="back" />}
      </div>
    </div>
  );
}

function SkeletonTile({ size }: { size: 'tall' | 'short' }) {
  return (
    <div className={`bento-tile bento-tile--${size}`} aria-hidden="true">
      <div className="bento-face bento-face--front bento-face--skeleton">
        <span className="skeleton bento-skeleton__category" />
        <span className="skeleton bento-skeleton__name" />
        <span className="skeleton bento-skeleton__name bento-skeleton__name--short" />
        <span className="skeleton bento-skeleton__price" />
      </div>
    </div>
  );
}

function ExpertTile({
  settings,
  onOpen,
}: {
  settings: AppSettings;
  onOpen: () => void;
}) {
  const { expert_name, expert_photo_url } = settings;
  return (
    <button type="button" className="bento-tile bento-tile--expert" onClick={onOpen}>
      <div className="bento-expert__head">
        <span className="bento-expert__avatar">
          {expert_photo_url !== '' ? (
            <img src={expert_photo_url} alt="" />
          ) : (
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="8" r="4" />
              <path d="M4 21v-1a6 6 0 016-6h4a6 6 0 016 6v1" />
            </svg>
          )}
        </span>
        <span className="bento-expert__names">
          <span className="bento-expert__label">Talk with</span>
          <span className="bento-expert__name">{expert_name}</span>
        </span>
      </div>
      <span className="bento-expert__cta">Skincare Expert →</span>
    </button>
  );
}

/**
 * Live tiles above the catalog: a tall tile and a short tile that each flip
 * between two featured products, plus a static expert CTA. Falls back to
 * skeletons when fewer than two featured products are available, so the grid
 * never renders an empty box.
 */
export function BentoGrid({ products, settings }: BentoGridProps) {
  const navigate = useNavigate();

  const featured = useMemo(
    () => products.filter((p) => p.is_featured).slice(0, FACES_PER_TILE * 2),
    [products]
  );

  const openProduct = (sku: string) => navigate(`/product/${sku}`);

  const hasEnough = featured.length >= 2;
  // Products alternate between the two tiles so each tile's pair is distinct.
  const tallFaces = featured.filter((_, i) => i % 2 === 0);
  const shortFaces = featured.filter((_, i) => i % 2 === 1);

  return (
    <section className="bento" aria-label="Featured products">
      {hasEnough ? (
        <>
          <FlipTile faces={tallFaces} size="tall" stagger={false} onOpen={openProduct} />
          <FlipTile faces={shortFaces} size="short" stagger onOpen={openProduct} />
        </>
      ) : (
        <>
          <SkeletonTile size="tall" />
          <SkeletonTile size="short" />
        </>
      )}
      <ExpertTile settings={settings} onOpen={() => navigate('/contact')} />
    </section>
  );
}
