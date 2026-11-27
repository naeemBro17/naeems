import { useMemo, type MouseEvent } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useCart } from '../../contexts/CartContext';
import { useProducts } from '../../contexts/ProductContext';
import { useRoutineSettings } from '../../hooks/useRoutineSettings';
import { useSellLimit } from '../../hooks/useSellLimit';
import { trackAddToCart } from '../../lib/analytics';
import { concernPath } from '../../lib/categoryFilter';
import { formatTaka } from '../../lib/format';
import { getDisplayPrice } from '../../lib/pricing';
import { cardImage } from '../../lib/productImages';
import { pickQuestion, routineSuggestions, shouldAsk, skinProfileOf } from '../../lib/routine';
import { lineKey, showAddedInPanel } from '../../lib/sideCart';
import { productPath } from '../../lib/slugify';
import type { CartItem } from '../../features/checkout/types';
import type { Product } from '../../types';

const OPENS_KEY = 'naeems.cartOpens';

/** Adds one to this browser's side-cart open count and returns it. Storage
 *  blocked: 0, so the question card never shows. */
export function countCartOpen(): number {
  try {
    const before = Number.parseInt(window.localStorage.getItem(OPENS_KEY) ?? '0', 10);
    const next = (Number.isFinite(before) && before > 0 ? before : 0) + 1;
    window.localStorage.setItem(OPENS_KEY, String(next));
    return next;
  } catch {
    return 0;
  }
}

function PlaceholderIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 8l-9-5-9 5v8l9 5 9-5V8z" />
      <path d="M3 8l9 5 9-5" />
      <path d="M12 13v8" />
    </svg>
  );
}

/** A plain tap leaves through the panel; Ctrl/Cmd-click works like a link. */
function isPlainClick(e: MouseEvent<HTMLAnchorElement>): boolean {
  return !(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0);
}

/**
 * Batch 72: the side cart's "Complete your routine" row and, on every 4th
 * open, one of Naeem's questions (approved mockup, screen 3). Under the
 * cart lines; hidden when there is nothing to suggest.
 */
export function SideCartRoutine({
  lines,
  anchorKey,
  openCount,
  onLeave,
}: {
  lines: CartItem[];
  /** The line just added (the panel opened by an add), else null. */
  anchorKey: string | null;
  openCount: number;
  /** Closes the panel, then opens this path. */
  onLeave: (path: string) => void;
}) {
  const { products, categories, variantsFor } = useProducts();
  const { profile, isCustomer } = useAuth();
  const { addItem, items } = useCart();
  const sell = useSellLimit();
  const { rules, fallback, questions } = useRoutineSettings();
  const skin = useMemo(() => (isCustomer ? skinProfileOf(profile) : null), [isCustomer, profile]);

  const anchor =
    (anchorKey !== null ? lines.find((l) => lineKey(l.product.id, l.variantId) === anchorKey) : undefined) ??
    lines[lines.length - 1];
  const cartIds = useMemo(() => new Set(lines.map((l) => l.product.id)), [lines]);

  const routine = useMemo(
    () =>
      anchor
        ? routineSuggestions({ anchor: anchor.product, catalogue: products, categories, rules, fallback, exclude: cartIds, profile: skin })
        : { picks: [], forCategory: null },
    [anchor, products, categories, rules, fallback, cartIds, skin]
  );

  const question = useMemo(() => {
    if (!shouldAsk(openCount)) return null;
    const skip = [...(skin?.concerns ?? []), ...lines.flatMap((l) => l.product.skin_conditions ?? [])];
    return pickQuestion(questions, openCount, skip);
  }, [openCount, questions, skin, lines]);

  const openPick = (e: MouseEvent<HTMLAnchorElement>, product: Product) => {
    if (!isPlainClick(e)) return;
    e.preventDefault();
    onLeave(productPath(product));
  };

  const openConcern = (e: MouseEvent<HTMLAnchorElement>, concern: string) => {
    if (!isPlainClick(e)) return;
    e.preventDefault();
    onLeave(concernPath(concern));
  };

  // The same add as the Wishlist's card for a product with no options; a
  // product with options opens its page to pick the size.
  const addPick = (product: Product) => {
    if (variantsFor(product.id).length > 0) {
      onLeave(productPath(product));
      return;
    }
    const facts = sell.factsFor(product, null);
    const inCart = items.find((i) => i.productId === product.id && i.variantId === null)?.quantity ?? 0;
    if (inCart + 1 > sell.maxFor(facts)) return;
    const { mainPrice } = getDisplayPrice(product);
    addItem(product.id, mainPrice);
    trackAddToCart({ id: product.id, name: product.name, price: mainPrice }, 1);
    showAddedInPanel(product.id, null);
  };

  return (
    <>
      {routine.picks.length > 0 && (
        <section className="b72-rt" aria-label="Complete your routine" data-testid="side-cart-routine">
          <h5>
            Complete your routine
            {routine.forCategory && <small>for your {routine.forCategory.toLowerCase()}</small>}
          </h5>
          <div className="b72-rcards">
            {routine.picks.map(({ product, label }) => {
              const image = cardImage(product);
              return (
                <div key={product.id} className="b72-rc" data-testid="side-cart-routine-card">
                  <a href={productPath(product)} className="b72-rc__img" onClick={(e) => openPick(e, product)} tabIndex={-1} aria-hidden="true">
                    {image ? <img src={image} alt="" width={44} height={44} loading="lazy" decoding="async" /> : <PlaceholderIcon />}
                  </a>
                  <p>
                    <em>{label}</em>
                    <a href={productPath(product)} className="b72-rc__n" onClick={(e) => openPick(e, product)}>
                      {product.name}
                    </a>
                    <b>
                      {formatTaka(getDisplayPrice(product).mainPrice)}
                      <button
                        type="button"
                        className="b72-rc__add"
                        onClick={() => addPick(product)}
                        aria-label={`Add ${product.name}`}
                        data-testid="side-cart-routine-add"
                      >
                        +
                      </button>
                    </b>
                  </p>
                </div>
              );
            })}
          </div>
        </section>
      )}
      {question && (
        <div className="b72-ask" data-testid="side-cart-ask">
          <p>
            {question.text}
            <small>See what Naeem recommends</small>
          </p>
          <a href={concernPath(question.concern)} className="b72-ask__go" onClick={(e) => openConcern(e, question.concern)} data-testid="side-cart-ask-go">
            Show me
          </a>
        </div>
      )}
    </>
  );
}
