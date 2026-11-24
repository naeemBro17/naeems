import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BackButton } from '../components/shared/BackButton';
import { HeartIcon } from '../components/viewer/Wishlist';
import { LimitPopup } from '../components/viewer/LimitPopup';
import { VariantPickerSheet } from '../components/viewer/VariantPickerSheet';
import { useAuth } from '../contexts/AuthContext';
import { useCart } from '../contexts/CartContext';
import { useProducts } from '../contexts/ProductContext';
import { useWishlist } from '../contexts/WishlistContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useSellLimit } from '../hooks/useSellLimit';
import { useToast } from '../hooks/useToast';
import { formatTaka } from '../lib/format';
import { getDisplayPrice } from '../lib/pricing';
import { cardImage } from '../lib/productImages';
import { lowStockText, type LimitReason } from '../lib/sellRules';
import { productPath } from '../lib/slugify';
import { isOutOfStock } from '../lib/stockStatus';
import { isVariantInStock, lowestVariantPrice, variantOptionsFor } from '../lib/variants';
import { trackAddToCart } from '../lib/analytics';
import type { Product } from '../types';

/** One saved product: glass card, photo, name, price, stock, heart, Add. */
function WishCard({ product }: { product: Product }) {
  const { variantsFor } = useProducts();
  const { toggle } = useWishlist();
  const { addItem, items } = useCart();
  const { showToast } = useToast();
  const sell = useSellLimit();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [popup, setPopup] = useState<LimitReason | null>(null);

  const variants = variantsFor(product.id);
  const options = variantOptionsFor(product, variants);
  const hasOptions = variants.length > 0;
  const available = hasOptions ? options.some((o) => isVariantInStock(o)) : !isOutOfStock(product);
  const facts = sell.factsFor(product, null);
  const low = !hasOptions && available ? lowStockText(facts, sell.limit) : null;
  const { mainPrice, strikePrice } = getDisplayPrice(product);
  const fromPrice = hasOptions ? lowestVariantPrice(options) : null;
  const image = cardImage(product);
  const status = !available ? 'out' : low ? 'low' : 'in';

  const add = () => {
    if (!available) return;
    if (hasOptions) {
      setPickerOpen(true);
      return;
    }
    const inCart = items.find((i) => i.productId === product.id && i.variantId === null)?.quantity ?? 0;
    if (inCart + 1 > sell.maxFor(facts)) {
      setPopup(sell.reasonFor(facts));
      return;
    }
    addItem(product.id, mainPrice);
    trackAddToCart({ id: product.id, name: product.name, price: mainPrice }, 1);
    showToast('Added to cart', 'success');
  };

  return (
    <li className="wish-card" data-testid="wish-card">
      <Link to={productPath(product)} className="wish-card__photo" aria-label={product.name}>
        {image ? <img src={image} alt="" loading="lazy" decoding="async" width={96} height={96} /> : <span className="wish-card__photo-empty" />}
      </Link>
      <div className="wish-card__body">
        <div className="wish-card__top">
          <Link to={productPath(product)} className="wish-card__name">
            {product.name}
          </Link>
          <button
            type="button"
            className="wish-card__heart"
            onClick={() => toggle(product.id)}
            aria-label={`Remove ${product.name} from your wishlist`}
            data-testid="wish-card-heart"
          >
            <HeartIcon filled className="wish-card__heart-icon" />
          </button>
        </div>
        <p className="wish-card__price">
          {fromPrice !== null ? (
            <span className="wish-card__main">
              <span className="wish-card__from">from</span> {formatTaka(fromPrice)}
            </span>
          ) : (
            <>
              <span className="wish-card__main">{formatTaka(mainPrice)}</span>
              {strikePrice !== null && <span className="wish-card__strike">{formatTaka(strikePrice)}</span>}
            </>
          )}
        </p>
        <div className="wish-card__foot">
          <p className="wish-card__stock" data-testid="wish-card-stock">
            <span className={`wish-card__dot wish-card__dot--${status}`} aria-hidden="true" />
            {status === 'out' ? 'Sold out' : low ?? 'In Stock'}
          </p>
          <div className="wish-card__add-wrap">
            {popup && (
              <LimitPopup reason={popup} productName={product.name} optionLabel={null} onClose={() => setPopup(null)} />
            )}
            {available ? (
              <button type="button" className="wish-card__add" onClick={add} data-testid="wish-card-add">
                Add to cart
              </button>
            ) : (
              <button type="button" className="wish-card__add wish-card__add--off" disabled>
                Sold out
              </button>
            )}
          </div>
        </div>
      </div>
      {hasOptions && (
        <VariantPickerSheet product={product} variants={variants} isOpen={pickerOpen} onClose={() => setPickerOpen(false)} />
      )}
    </li>
  );
}

/**
 * /wishlist (Batch 51 Part 4, mockup frame 4): the customer's saved
 * products as glass cards over soft colour washes. Hidden or deleted
 * products drop out. Add to cart follows the order limit.
 */
export function WishlistPage() {
  useDocumentTitle("Wishlist | NAEEM'S");
  const { session, isLoading: authLoading } = useAuth();
  const { products, isLoading } = useProducts();
  const { ids, ready } = useWishlist();

  const saved = useMemo(() => {
    const byId = new Map(products.filter((p) => p.is_active).map((p) => [p.id, p]));
    return ids.map((id) => byId.get(id)).filter((p): p is Product => p !== undefined);
  }, [ids, products]);

  const loading = authLoading || (session !== null && (!ready || isLoading));

  return (
    <div className="viewer-shell detail-shell wish-page">
      <span className="wish-page__wash wish-page__wash--1" aria-hidden="true" />
      <span className="wish-page__wash wish-page__wash--2" aria-hidden="true" />
      <span className="wish-page__wash wish-page__wash--3" aria-hidden="true" />
      <header className="wish-head">
        <BackButton />
        <h1 className="wish-head__title">Wishlist</h1>
        {saved.length > 0 && (
          <span className="wish-head__count" data-testid="wish-count">
            {saved.length} saved
          </span>
        )}
      </header>

      <main className="wish-main">
        {loading ? (
          <ul className="wish-list" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <li key={i} className="wish-card wish-card--loading" />
            ))}
          </ul>
        ) : saved.length === 0 ? (
          <div className="wish-empty" data-testid="wish-empty">
            <span className="wish-empty__icon" aria-hidden="true">
              <HeartIcon filled={false} />
            </span>
            <p className="wish-empty__title">No favourites yet</p>
            <p className="wish-empty__text">Tap the heart on any product to keep it here.</p>
            {!session && (
              <Link to="/account" state={{ from: '/wishlist' }} className="wish-empty__login">
                Log in
              </Link>
            )}
          </div>
        ) : (
          <ul className="wish-list" data-testid="wish-list">
            {saved.map((product) => (
              <WishCard key={product.id} product={product} />
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
