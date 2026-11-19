import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAppNavigate } from '../hooks/useAppNavigate';
import { BackButton } from '../components/shared/BackButton';
import { useCart } from '../contexts/CartContext';
import { useProducts } from '../contexts/ProductContext';
import { useComboLines, type LiveComboLine } from '../hooks/useComboLines';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useSellLimit } from '../hooks/useSellLimit';
import { useToast } from '../hooks/useToast';
import { trackAddToCart } from '../lib/analytics';
import { addedToastText, comboChatMessage, comboTotals, fetchCombo, unitsToAdd, type ComboLoad } from '../lib/combos';
import { shopWhatsAppMessageUrl } from '../lib/expertLinks';
import { formatTaka } from '../lib/format';
import { productPath } from '../lib/slugify';
import '../styles/wishlist.css';

function StarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 3.2l2.6 5.5 6 .7-4.5 4.1 1.2 5.9L12 16.5l-5.3 2.9 1.2-5.9-4.5-4.1 6-.7z" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z" />
    </svg>
  );
}

/** The products' photos, each shown whole (1–4 tiles). */
function ComboCollage({ lines }: { lines: readonly LiveComboLine[] }) {
  const shown = lines.filter((l) => l.thumb).slice(0, 4);
  if (shown.length === 0) return null;
  return (
    <div className={`combo-collage combo-collage--${shown.length}`} data-testid="combo-collage">
      {shown.map((line) => (
        <span key={line.key} className="combo-collage__tile">
          <img src={line.thumb ?? ''} alt="" width={480} height={480} decoding="async" />
        </span>
      ))}
    </div>
  );
}

function stockText(line: LiveComboLine): string {
  if (!line.available) return 'Sold out';
  return line.lowText ?? 'In Stock';
}

/**
 * /c/{code} (Batch 52 Part 3.4, mockup frame 4): a combo Naeem picked for
 * a customer — today's prices and stock, "Add all to cart". Works for
 * logged-out visitors; not listed anywhere in the shop.
 */
export function ComboPage() {
  const { code = '' } = useParams<{ code: string }>();
  const navigate = useAppNavigate();
  const { isLoading: catalogLoading, settings } = useProducts();
  const { items: cartItems, addItem } = useCart();
  const sell = useSellLimit();
  const { showToast } = useToast();
  const [load, setLoad] = useState<ComboLoad | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoad(null);
    void fetchCombo(code).then((result) => {
      if (alive) setLoad(result);
    });
    return () => {
      alive = false;
    };
  }, [code, attempt]);

  const combo = load?.kind === 'ready' ? load.combo : null;
  const lines = useComboLines(combo?.items ?? []);
  const totals = useMemo(() => comboTotals(lines), [lines]);
  useDocumentTitle(combo ? `${combo.name} — NAEEM'S` : "Combo — NAEEM'S");

  const chatHref = combo ? shopWhatsAppMessageUrl(settings, comboChatMessage(combo.name)) : null;

  const addAll = () => {
    let added = 0;
    for (const line of lines) {
      if (!line.available) continue;
      const inCart =
        cartItems.find((i) => i.productId === line.product.id && i.variantId === line.variantId)?.quantity ?? 0;
      const units = unitsToAdd(line.quantity, inCart, sell.maxFor(line.facts));
      if (units === 0) continue;
      const variant = line.variantId === null ? null : { id: line.variantId, label: line.optionLabel ?? line.product.name };
      addItem(line.product.id, line.price, variant, units);
      trackAddToCart({ id: line.product.id, name: line.product.name, price: line.price }, units);
      added += 1;
    }
    showToast(addedToastText(added, totals.soldOutCount), 'success');
    navigate('/cart');
  };

  const loading = load === null || (load.kind === 'ready' && catalogLoading && lines.length === 0);

  return (
    <div className="viewer-shell detail-shell wish-page combo-page">
      <span className="wish-page__wash wish-page__wash--1" aria-hidden="true" />
      <span className="wish-page__wash wish-page__wash--2" aria-hidden="true" />
      <span className="wish-page__wash wish-page__wash--3" aria-hidden="true" />
      <header className="wish-head">
        <BackButton />
      </header>

      <main className="wish-main combo-main">
        {loading ? (
          <div className="combo-loading" aria-label="Loading" data-testid="combo-loading">
            <span className="combo-loading__collage" />
            <span className="combo-loading__line" />
            <span className="combo-loading__line combo-loading__line--short" />
          </div>
        ) : load.kind === 'error' ? (
          <div className="combo-gone" data-testid="combo-error">
            <p className="combo-gone__title">Could not load this combo.</p>
            <p className="combo-gone__text">Check your connection and try again.</p>
            <button type="button" className="button button--primary" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        ) : load.kind === 'gone' || (combo !== null && lines.length === 0) ? (
          <div className="combo-gone" data-testid="combo-gone">
            <p className="combo-gone__title">This combo isn&apos;t available anymore.</p>
            <Link to="/" className="button button--primary" data-testid="combo-browse">
              Browse the shop
            </Link>
          </div>
        ) : combo ? (
          <>
            <ComboCollage lines={lines} />
            <p className="combo-kicker">
              <StarIcon />
              PICKED FOR YOU BY NAEEM
            </p>
            <h1 className="combo-title" data-testid="combo-title">
              {combo.name}
            </h1>

            {combo.note && (
              <section className="combo-note" data-testid="combo-note-card">
                <p className="combo-note__head">
                  <span className="combo-note__avatar" aria-hidden="true">
                    N
                  </span>
                  Naeem&apos;s note
                </p>
                <p className="combo-note__text">{combo.note}</p>
              </section>
            )}

            <ul className="combo-list" data-testid="combo-list">
              {lines.map((line) => (
                <li key={line.key} className={`combo-row${line.available ? '' : ' combo-row--out'}`} data-testid="combo-row">
                  <Link to={productPath(line.product)} className="combo-row__link">
                    <span className="combo-row__photo">
                      {line.thumb ? <img src={line.thumb} alt="" width={64} height={64} loading="lazy" decoding="async" /> : null}
                    </span>
                    <span className="combo-row__body">
                      <span className="combo-row__name">
                        {line.product.name}
                        {line.optionLabel && <span className="combo-row__option"> · {line.optionLabel}</span>}
                      </span>
                      <span className={`combo-row__stock combo-row__stock--${line.available ? (line.lowText ? 'low' : 'in') : 'out'}`} data-testid="combo-row-stock">
                        {stockText(line)}
                      </span>
                    </span>
                    <span className="combo-row__price">
                      {line.quantity > 1 && <span className="combo-row__qty">{line.quantity} × </span>}
                      <span className="combo-price">{formatTaka(line.price)}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>

            <div className="combo-total" data-testid="combo-total">
              <span className="combo-total__label">Total</span>
              <span className="combo-total__figures">
                <span className="combo-total__amount combo-price" data-testid="combo-total-amount">
                  {formatTaka(totals.total)}
                </span>
                {totals.retailTotal > totals.total && (
                  <span className="combo-total__strike">{formatTaka(totals.retailTotal)}</span>
                )}
              </span>
              {totals.savings > 0 && (
                <span className="combo-total__save" data-testid="combo-save">
                  You save {formatTaka(totals.savings)}
                </span>
              )}
            </div>

            {totals.availableCount > 0 ? (
              <button type="button" className="button button--primary button--full combo-add" onClick={addAll} data-testid="combo-add-all">
                Add all to cart
              </button>
            ) : (
              <button type="button" className="button button--full combo-add" disabled data-testid="combo-add-all">
                Sold out
              </button>
            )}

            {chatHref && (
              <a className="combo-chat" href={chatHref} target="_blank" rel="noopener noreferrer" data-testid="combo-chat">
                <ChatIcon />
                Want to change something? Chat with us
              </a>
            )}
          </>
        ) : null}
      </main>
    </div>
  );
}
