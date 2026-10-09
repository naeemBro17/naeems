// Customer "My Orders" list (/orders) — the account page's My Orders card
// links here. Route itself isn't role-gated: RLS already means a signed-in
// customer's fetchMyOrders() can only ever return their own rows (and a
// signed-out visitor sees an empty list, not an error, same as any other
// empty state).
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BackButton } from '../components/shared/BackButton';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useAuth } from '../contexts/AuthContext';
import { fetchMyOrders } from '../lib/orders';
import { formatTaka } from '../lib/format';
import { TRACK_STATUS, fetchLatestSteps, savedTrack, type TrackStatus } from '../lib/orderTracking';
import type { Order } from '../types';

function OrdersSkeleton() {
  return (
    <div className="orders-list" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="skeleton orders-list__skeleton-row" />
      ))}
    </div>
  );
}

export function OrdersListPage() {
  useDocumentTitle("My Orders — NAEEM'S");
  const { session, isLoading: authLoading } = useAuth();
  const [orders, setOrders] = useState<Order[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // Batch 35: the newest stored courier step (Out for delivery), when known.
  const [steps, setSteps] = useState<Map<string, TrackStatus>>(() => new Map());

  useEffect(() => {
    if (authLoading) return;
    if (!session) {
      setOrders([]);
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    void fetchMyOrders().then((data) => {
      if (cancelled) return;
      setOrders(data);
      setIsLoading(false);
    });
    void fetchLatestSteps().then((map) => {
      if (!cancelled) setSteps(map);
    });
    return () => {
      cancelled = true;
    };
  }, [session, authLoading]);

  return (
    <div className="viewer-shell detail-shell">
      <header className="detail-header">
        <BackButton />
        <h1 className="detail-header__title">My Orders</h1>
        <div className="detail-header__actions" />
      </header>

      <main className="detail-main">
        {isLoading || authLoading ? (
          <OrdersSkeleton />
        ) : orders.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 8l-9-5-9 5v8l9 5 9-5V8z" />
                <path d="M3 8l9 5 9-5" />
                <path d="M12 13v8" />
              </svg>
            </div>
            <p className="empty-state__message">No orders yet</p>
            <Link to="/" className="button button--primary">
              Start shopping
            </Link>
          </div>
        ) : (
          <ul className="orders-list">
            {orders.map((order) => (
              <li key={order.id}>
                <Link to={`/orders/${order.id}`} className="orders-list__row">
                  <div className="orders-list__row-main">
                    <span className="orders-list__number">{order.order_number}</span>
                    <span className="orders-list__date">
                      {new Date(order.created_at).toLocaleDateString('en-GB', {
                        timeZone: 'Asia/Dhaka',
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </span>
                  </div>
                  <div className="orders-list__row-end">
                    <span className="orders-list__total">{formatTaka(order.total)}</span>
                    {(() => {
                      const info = TRACK_STATUS[savedTrack(order, { storedStep: steps.get(order.id) ?? null }).status];
                      return (
                        <span className={`track-pill track-pill--${info.tone}`} data-testid="order-status-pill">
                          {info.customer}
                        </span>
                      );
                    })()}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
