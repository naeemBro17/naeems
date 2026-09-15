import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AppSettings, BentoTile, Product } from '../../types';
import { getDisplayPrice } from '../../lib/pricing';
import { formatTaka } from '../../lib/format';
import { isOutOfStock } from '../../lib/stockStatus';
import { productPath } from '../../lib/slugify';
import { rememberGridScroll } from '../../lib/gridScroll';
import { BENTO_TILE_SELECT } from '../../lib/bentoTiles';
import { applyIdOrder, parseIdList } from '../../lib/settingsLists';
import { supabase } from '../../lib/supabase';
import { useSwipe } from '../../hooks/useSwipe';
import { BentoCustomTile } from './BentoCustomTile';
import { EditButton } from '../admin/EditButton';
import { BentoEditSheet, type BentoEditTarget } from '../admin/edit-sheets/BentoEditSheet';

interface BentoGridProps {
  products: Product[];
  settings: AppSettings;
}

/** Slides in the swipeable left tile. */
const STACK_SIZE = 4;
/** Faces in the auto-flipping right tile — the CSS animation shows exactly two. */
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

function ProductFaceBody({ product }: { product: Product }) {
  return (
    <>
      {product.category && (
        <span className="bento-tile__category">{product.category.name}</span>
      )}
      <h3 className="bento-tile__name">{product.name}</h3>
      <PriceLine product={product} />
    </>
  );
}

/* ---------- Left tile: manual vertical swipe ---------- */

/**
 * A vertical stack of featured products. It never auto-advances — the inner
 * track is translated by exactly one tile height per swipe, and the gesture is
 * captured so it can't scroll the page behind it.
 */
function SwipeStackTile({
  products,
  onOpen,
  onEdit,
}: {
  products: Product[];
  onOpen: (product: Product) => void;
  onEdit: () => void;
}) {
  const [index, setIndex] = useState(0);
  const count = products.length;

  // A shrinking featured list must never leave the track parked past its end.
  useEffect(() => {
    setIndex((current) => Math.min(current, Math.max(0, count - 1)));
  }, [count]);

  const swipeRef = useSwipe<HTMLDivElement>({
    axis: 'y',
    enabled: count > 1,
    onSwipe: (direction) =>
      setIndex((current) => Math.min(count - 1, Math.max(0, current + direction))),
  });

  return (
    <div className="bento-tile bento-tile--tall bento-tile--stack" ref={swipeRef}>
      <div
        className="bento-stack__track"
        style={{
          height: `${count * 100}%`,
          transform: `translateY(-${(index * 100) / count}%)`,
        }}
      >
        {products.map((product) => (
          <div
            className="bento-face bento-face--front bento-stack__slide"
            key={product.id}
            role="button"
            tabIndex={0}
            onClick={() => onOpen(product)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpen(product);
              }
            }}
            aria-label={`View details for ${product.name}`}
          >
            <ProductFaceBody product={product} />
          </div>
        ))}
      </div>

      {count > 1 && (
        <div className="bento-stack__dots" aria-hidden="true">
          {products.map((product, i) => (
            <span
              key={product.id}
              className={`bento-stack__dot${
                i === index ? ' bento-stack__dot--active' : ''
              }`}
            />
          ))}
        </div>
      )}

      <EditButton label="Edit left tile products" onClick={onEdit} />
    </div>
  );
}

/* ---------- Right top tile: automatic flip ---------- */

/**
 * Both faces exist in the DOM at once and the wrapper is flipped around the X
 * axis by CSS, so the two products alternate without any JavaScript timer.
 */
function FlipTile({
  faces,
  onOpen,
  onEdit,
}: {
  faces: Product[];
  onOpen: (product: Product) => void;
  onEdit: () => void;
}) {
  const [front, back] = faces;
  return (
    <div className="bento-tile bento-tile--short">
      <EditButton label="Edit right top tile products" onClick={onEdit} />
      <div className={`bento-flipper${back ? '' : ' bento-flipper--static'}`}>
        <div
          className="bento-face bento-face--front"
          role="button"
          tabIndex={-1}
          onClick={() => onOpen(front)}
        >
          <ProductFaceBody product={front} />
        </div>
        {back && (
          <div
            className="bento-face bento-face--back"
            role="button"
            tabIndex={-1}
            onClick={() => onOpen(back)}
          >
            <ProductFaceBody product={back} />
          </div>
        )}
      </div>
    </div>
  );
}

function SkeletonTile({ size, onEdit }: { size: 'tall' | 'short'; onEdit: () => void }) {
  return (
    <div className={`bento-tile bento-tile--${size}`}>
      <div className="bento-face bento-face--front bento-face--skeleton" aria-hidden="true">
        <span className="skeleton bento-skeleton__category" />
        <span className="skeleton bento-skeleton__name" />
        <span className="skeleton bento-skeleton__name bento-skeleton__name--short" />
        <span className="skeleton bento-skeleton__price" />
      </div>
      <EditButton label="Choose products for this tile" onClick={onEdit} />
    </div>
  );
}

/* ---------- Right bottom tile: manual horizontal carousel ---------- */

function ExpertCard({
  settings,
  onOpen,
}: {
  settings: AppSettings;
  onOpen: () => void;
}) {
  const { expert_name, expert_photo_url, bento_expert_subtitle } = settings;
  const subtitle = bento_expert_subtitle.trim() || 'Skincare Expert';
  return (
    <button type="button" className="bento-expert" onClick={onOpen}>
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
      <span className="bento-expert__cta">{subtitle} →</span>
    </button>
  );
}

/**
 * The expert CTA plus any admin-configured custom tiles, swiped horizontally.
 * With a single card there is nothing to swipe to, so both the gesture and the
 * pagination dots are switched off rather than advertising an interaction that
 * does nothing.
 */
function CarouselTile({
  settings,
  tiles,
  onOpenExpert,
  onEdit,
}: {
  settings: AppSettings;
  tiles: BentoTile[];
  onOpenExpert: () => void;
  onEdit: () => void;
}) {
  const [index, setIndex] = useState(0);
  const count = tiles.length + 1;

  useEffect(() => {
    setIndex((current) => Math.min(current, count - 1));
  }, [count]);

  const swipeRef = useSwipe<HTMLDivElement>({
    axis: 'x',
    enabled: count > 1,
    onSwipe: (direction) =>
      setIndex((current) => Math.min(count - 1, Math.max(0, current + direction))),
  });

  return (
    <div className="bento-tile bento-tile--carousel" ref={swipeRef}>
      <div
        className="bento-carousel__track"
        style={{
          width: `${count * 100}%`,
          transform: `translateX(-${(index * 100) / count}%)`,
        }}
      >
        <div className="bento-carousel__slide">
          <ExpertCard settings={settings} onOpen={onOpenExpert} />
        </div>
        {tiles.map((tile) => (
          <div className="bento-carousel__slide" key={tile.id}>
            <BentoCustomTile tile={tile} />
          </div>
        ))}
      </div>

      {count > 1 && (
        <div className="bento-carousel__dots" aria-hidden="true">
          {Array.from({ length: count }, (_, i) => (
            <span
              key={i}
              className={`bento-carousel__dot${
                i === index ? ' bento-carousel__dot--active' : ''
              }`}
            />
          ))}
        </div>
      )}

      <EditButton label="Edit bottom carousel" onClick={onEdit} />
    </div>
  );
}

/* ---------- Grid ---------- */

/**
 * Live tiles above the catalog. Three distinct interactions: the tall tile is
 * swiped vertically, the short tile flips on its own, and the bottom-right
 * tile is a horizontal carousel of the expert CTA plus custom link tiles.
 */
export function BentoGrid({ products, settings }: BentoGridProps) {
  const navigate = useNavigate();
  const [tiles, setTiles] = useState<BentoTile[]>([]);
  const [editTarget, setEditTarget] = useState<BentoEditTarget | null>(null);

  // All tiles, including inactive ones (which the editor needs to list); the
  // carousel filters to active. The public read policy already hides inactive
  // rows from non-admins, so customers only ever receive active tiles.
  const loadTiles = useCallback(async () => {
    const { data, error } = await supabase
      .from('bento_tiles')
      .select(BENTO_TILE_SELECT)
      .order('sort_order', { ascending: true });
    if (error) {
      // The table may not exist yet (migration-008 not run). The carousel
      // still works — it just shows the expert CTA on its own.
      console.warn('Bento tiles unavailable:', error.message);
      return;
    }
    setTiles((data ?? []) as BentoTile[]);
  }, []);

  useEffect(() => {
    void loadTiles();
  }, [loadTiles]);

  const activeTiles = useMemo(() => tiles.filter((t) => t.is_active), [tiles]);
  const featured = useMemo(() => products.filter((p) => p.is_featured), [products]);

  const openProduct = (product: Product) => {
    // Same Back-restores-position contract the product grid follows.
    rememberGridScroll();
    navigate(productPath(product));
  };

  // Default allocation when the admin hasn't arranged the tiles: the flip
  // tile takes the last two featured products and the stack the rest, so with
  // a normal-sized featured list no product shows up in both tiles. Below
  // four featured the lists overlap — a repeated product beats an empty tile.
  const canSplit = featured.length >= STACK_SIZE;
  const defaultFlip = useMemo(
    () => (canSplit ? featured.slice(-FACES_PER_TILE) : featured.slice(0, FACES_PER_TILE)),
    [featured, canSplit]
  );
  const defaultStack = useMemo(
    () =>
      canSplit
        ? featured.slice(0, Math.min(STACK_SIZE, featured.length - FACES_PER_TILE))
        : featured,
    [featured, canSplit]
  );

  // A saved order wins over the default, restricted to products that are
  // still featured; a product un-featured since falls out automatically.
  const leftOrder = parseIdList(settings.bento_left_order);
  const rightOrder = parseIdList(settings.bento_right_top_order);
  const stackProducts =
    leftOrder.length > 0 ? applyIdOrder(featured, leftOrder, true) : defaultStack;
  const flipFaces =
    rightOrder.length > 0
      ? applyIdOrder(featured, rightOrder, true).slice(0, FACES_PER_TILE)
      : defaultFlip;

  return (
    <section className="bento" aria-label="Featured products">
      {stackProducts.length > 0 ? (
        <SwipeStackTile
          products={stackProducts}
          onOpen={openProduct}
          onEdit={() => setEditTarget('left')}
        />
      ) : (
        <SkeletonTile size="tall" onEdit={() => setEditTarget('left')} />
      )}

      {flipFaces.length > 0 ? (
        <FlipTile
          faces={flipFaces}
          onOpen={openProduct}
          onEdit={() => setEditTarget('right-top')}
        />
      ) : (
        <SkeletonTile size="short" onEdit={() => setEditTarget('right-top')} />
      )}

      <CarouselTile
        settings={settings}
        tiles={activeTiles}
        onOpenExpert={() => navigate('/contact')}
        onEdit={() => setEditTarget('bottom')}
      />

      <BentoEditSheet
        target={editTarget}
        onClose={() => setEditTarget(null)}
        tiles={tiles}
        onTilesChanged={loadTiles}
        defaultLeft={defaultStack}
        defaultRightTop={defaultFlip}
      />
    </section>
  );
}
