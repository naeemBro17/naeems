import { useEffect, useState } from 'react';
import { dayText, moneyText } from '../../../lib/money/format';
import { fetchOldPurchases, type OldPurchase } from '../../../lib/money/oldPurchases';
import { AdminIcon } from '../ui/AdminIcon';
import '../../../styles/adminInventory.css';
import '../../../styles/adminMoney.css';

/**
 * Batch 50: on the customer page, under the orders — the customer's old
 * Kaarbar bills. History only: they are not in the order count, the total
 * spent or the due. Hidden when there are none.
 */
export function OldPurchasesCard({ customerKey, phone }: { customerKey: string; phone: string }) {
  const [bills, setBills] = useState<OldPurchase[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchOldPurchases(customerKey, phone).then((rows) => {
      if (alive) setBills(rows);
    });
    return () => {
      alive = false;
    };
  }, [customerKey, phone]);

  if (!bills || bills.length === 0) return null;
  return (
    <section aria-label="Old purchases (Kaarbar)" data-testid="customer-old-purchases">
      <h3 className="adm-group__title adm-customer__heading">OLD PURCHASES (KAARBAR)</h3>
      <div className="adm-group__box adm-group__box--inset">
        {bills.map((b) => {
          const isOpen = open === b.id;
          const sign = b.kind === 'return' ? '−' : '';
          return (
            <div key={b.id} className="old-bill">
              <button
                type="button"
                className="adm-row"
                onClick={() => setOpen(isOpen ? null : b.id)}
                aria-expanded={isOpen}
                data-testid="customer-old-bill"
              >
                <span className="adm-row__label">
                  <b>{b.kind === 'return' ? `Return ${b.bill_no}` : b.bill_no}</b>
                  <span className="adm-row__sub">
                    {dayText(b.date)} · {b.lines.length} item{b.lines.length === 1 ? '' : 's'}
                  </span>
                </span>
                <span className="adm-price">
                  {sign}
                  {moneyText(b.bill_total)}
                </span>
                <AdminIcon name="chevron-right" className={`adm-row__chevron adm-row__chevron--tight old-bill__chev${isOpen ? ' old-bill__chev--open' : ''}`} />
              </button>
              {isOpen && (
                <div className="old-bill__body" data-testid="customer-old-bill-lines">
                  {b.lines.map((l, i) => (
                    <div key={i} className="inv-line">
                      <span className="old-bill__item">
                        {l.name}
                        <span className="adm-row__sub">
                          {' '}
                          · {l.unit ? `${l.quantity} ${l.unit.toUpperCase()}` : l.quantity} × {moneyText(l.rate)}
                          {l.line_discount > 0 ? ` − ${moneyText(l.line_discount)}` : ''}
                        </span>
                      </span>
                      <span>{moneyText(l.line_total)}</span>
                    </div>
                  ))}
                  {b.delivery !== 0 && (
                    <div className="inv-line">
                      <span>Delivery charge</span>
                      <span>{moneyText(b.delivery)}</span>
                    </div>
                  )}
                  {b.bill_discount !== 0 && (
                    <div className="inv-line">
                      <span>Bill discount</span>
                      <span>−{moneyText(b.bill_discount)}</span>
                    </div>
                  )}
                  <div className="inv-line inv-line--total">
                    <span>Bill total</span>
                    <b>
                      {sign}
                      {moneyText(b.bill_total)}
                    </b>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="admin-panel__description">From Kaarbar, before the site. Not counted in the orders, total spent or due above.</p>
    </section>
  );
}
