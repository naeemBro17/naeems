import { useEffect, useState } from 'react';
import { BottomSheet } from '../shared/BottomSheet';
import { findCustomers, moveOrderToCustomer, type CustomerSearchResult } from '../../lib/customers';

interface MoveOrderSheetProps {
  isOpen: boolean;
  orderId: string;
  orderNumber: string;
  /** The account the order belongs to now (null = none). */
  currentOwnerId: string | null;
  onClose: () => void;
  onMoved: (to: string) => Promise<void> | void;
}

/**
 * Batch 47 Task 6b: "Move order to another customer" — for an order that
 * sits in the wrong account (placed while logged in as someone else). Only
 * customers with an account can be picked: the order then shows in their
 * My Orders and leaves the old account's. Its money, payments, stock,
 * lots, Steadfast and payout rows are not touched.
 */
export function MoveOrderSheet({ isOpen, orderId, orderNumber, currentOwnerId, onClose, onMoved }: MoveOrderSheetProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CustomerSearchResult[]>([]);
  const [picked, setPicked] = useState<CustomerSearchResult | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setResults([]);
    setPicked(null);
    setError(null);
  }, [isOpen]);

  useEffect(() => {
    const term = query.trim();
    if (picked !== null || term.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void findCustomers(term).then((rows) => {
        if (!cancelled) setResults((rows ?? []).filter((r) => r.profileId !== null && r.profileId !== currentOwnerId));
      });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, picked, currentOwnerId]);

  const name = (c: CustomerSearchResult) => c.fullName || c.phone;

  const move = async () => {
    if (!picked?.profileId || working) return;
    setWorking(true);
    setError(null);
    const result = await moveOrderToCustomer(orderId, picked.profileId);
    setWorking(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    await onMoved(name(picked));
  };

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title={`Move ${orderNumber} to another customer`} panelClassName="adm-csheet">
      <div className="adm-csheet__body" data-testid="move-order-sheet">
        {picked === null ? (
          <>
            <p className="adm-ocard__muted">
              Find the customer by phone or name. Only customers with an account are listed — the order will show in their My
              Orders.
            </p>
            <input
              type="search"
              className="form-input"
              placeholder="Phone or name"
              aria-label="Find customer"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
              data-testid="move-order-search"
            />
            {results.length > 0 && (
              <ul className="picker-sheet__list">
                {results.map((c) => (
                  <li key={c.key}>
                    <button type="button" className="picker-sheet__row" onClick={() => setPicked(c)} data-testid="move-order-result">
                      <span className="picker-sheet__row-label">
                        {name(c)}
                        <span className="picker-sheet__row-sub">
                          {c.phone}
                          {c.orderCount > 0 ? ` · ${c.orderCount} order${c.orderCount === 1 ? '' : 's'}` : ''}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <>
            <p className="adm-csheet__text" data-testid="move-order-confirm-text">
              Move {orderNumber} to <strong>{name(picked)}</strong> ({picked.phone})? It will show in their My Orders and leave the
              account it is in now. Its money, payments, stock and Steadfast stay exactly as they are.
            </p>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="adm-csheet__actions">
              <button type="button" className="adm-btn adm-btn--ghost" onClick={() => setPicked(null)} disabled={working}>
                Pick another
              </button>
              <button type="button" className="adm-btn adm-btn--primary" onClick={() => void move()} disabled={working} data-testid="move-order-yes">
                {working ? <span className="spinner" aria-hidden="true" /> : 'Move order'}
              </button>
            </div>
          </>
        )}
      </div>
    </BottomSheet>
  );
}
