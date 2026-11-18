import { useState } from 'react';
import { useToast } from '../../hooks/useToast';
import { shoppingRowName, shoppingTotals, type ShoppingLoad } from '../../lib/shoppingList';
import { AdminPageHeader, EmptyState, SkeletonRows } from './ui/AdminUi';
import { AdminIcon } from './ui/AdminIcon';

interface ShoppingListTabProps {
  /** Loaded by the admin page (the same list drives the badge). */
  list: ShoppingLoad | null;
  onReload: () => void;
  onOpenOrder: (orderNumber: string) => void;
}

/**
 * Admin → Shopping list (Batch 51 Part 3): one row per product option still
 * to buy for open orders — how many, and for which orders. A lot that
 * covers an item takes it off (partly covered: the rest stays); cancelled,
 * returned and delivered orders drop out by themselves.
 */
export function ShoppingListTab({ list, onReload, onOpenOrder }: ShoppingListTabProps) {
  const { showToast } = useToast();
  const [isMaking, setIsMaking] = useState(false);
  const rows = list?.kind === 'ready' ? list.rows : [];
  const totals = shoppingTotals(rows);

  const download = async () => {
    setIsMaking(true);
    try {
      const { downloadShoppingListPdf } = await import('../../lib/shoppingListPdf');
      await downloadShoppingListPdf(rows);
    } catch {
      showToast('Could not make the PDF. Please try again.', 'error');
    } finally {
      setIsMaking(false);
    }
  };

  const pdfButton =
    rows.length > 0 ? (
      <button type="button" className="adm-btn" onClick={() => void download()} disabled={isMaking} data-testid="shopping-pdf">
        {isMaking ? <span className="spinner" aria-hidden="true" /> : 'Download PDF'}
      </button>
    ) : undefined;

  return (
    <section aria-label="Shopping list" className="adm-shop">
      <AdminPageHeader title="Shopping list" primary={pdfButton} />

      {list === null ? (
        <SkeletonRows rows={4} thumb={false} />
      ) : list.kind === 'no-db' ? (
        <EmptyState
          icon="shopping"
          title="The Shopping list is not set up yet"
          hint="Run the Batch 51 database step (in the batch report), then come back."
        />
      ) : list.kind === 'error' ? (
        <EmptyState
          icon="alert"
          title="Could not load the Shopping list"
          hint={list.message}
          action={
            <button type="button" className="adm-btn adm-btn--ghost" onClick={onReload}>
              Try again
            </button>
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState icon="check" title="Nothing to buy right now." />
      ) : (
        <>
          <div className="adm-ocard adm-shop__totals" data-testid="shopping-totals">
            <div>
              <p className="adm-shop__big">{totals.items}</p>
              <p className="adm-ocard__muted">item{totals.items === 1 ? '' : 's'} to buy</p>
            </div>
            <div>
              <p className="adm-shop__big">{totals.units}</p>
              <p className="adm-ocard__muted">unit{totals.units === 1 ? '' : 's'} in all</p>
            </div>
          </div>

          <ul className="adm-shop__list" data-testid="shopping-list">
            {rows.map((row) => (
              <li key={`${row.productId}:${row.variantId ?? ''}`} className="adm-shop__row" data-testid="shopping-row">
                <AdminIcon name="shopping" className="adm-shop__icon" />
                <div className="adm-shop__main">
                  <p className="adm-shop__name">{shoppingRowName(row)}</p>
                  <p className="adm-shop__orders">
                    For{' '}
                    {row.orders.map((o, i) => (
                      <span key={o.id}>
                        {i > 0 && ', '}
                        <button type="button" className="adm-shop__order" onClick={() => onOpenOrder(o.number)}>
                          {o.number}
                        </button>
                      </span>
                    ))}
                  </p>
                </div>
                <p className="adm-shop__qty" data-testid="shopping-qty">
                  <span className="adm-shop__qty-num">{row.qty}</span>
                  {row.unit && <span className="adm-shop__qty-unit">× {row.unit}</span>}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
