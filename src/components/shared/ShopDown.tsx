import { useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useBackendDown } from '../../lib/backendStatus';
import { fallbackMessengerUrl, fallbackWhatsAppUrl } from '../../lib/shopFallback';
import { MessengerIcon, WhatsAppIcon } from '../expert/SocialLinks';

/**
 * Batch 40 Part 3: the whole page while the shop can't reach its database
 * (lib/backendStatus.ts) — a calm message and two big buttons that work
 * without the database. It goes away by itself when the database answers
 * again (checked every 30 seconds).
 */
export function ShopDownPage() {
  return (
    <main className="shop-down" data-testid="shop-down">
      <div className="shop-down__card">
        <img className="shop-down__logo" src="/icons/icon-splash-192.png" alt="" width={72} height={72} />
        <h1 className="shop-down__title">Our online shop is being updated.</h1>
        <p className="shop-down__text">You can still order — message us:</p>
        <div className="shop-down__actions">
          <a
            className="button button--primary shop-down__button"
            href={fallbackWhatsAppUrl()}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="shop-down-whatsapp"
          >
            <span className="shop-down__icon">
              <WhatsAppIcon />
            </span>
            WhatsApp
          </a>
          <a
            className="button button--secondary shop-down__button"
            href={fallbackMessengerUrl()}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="shop-down-messenger"
          >
            <span className="shop-down__icon">
              <MessengerIcon />
            </span>
            Messenger
          </a>
        </div>
        <p className="shop-down__hint">This page comes back by itself when the shop is ready.</p>
      </div>
    </main>
  );
}

/** The admin sign-in page's note in the same case. */
export function BackendDownNote() {
  const down = useBackendDown();
  if (!down) return null;
  return (
    <p className="backend-down-note" role="status" data-testid="backend-down-note">
      Database not reachable right now. Your data is safe; try again later.
    </p>
  );
}

/** Admin pages (and their sign-in) keep their own screen with the note;
 *  every shop page is replaced by ShopDownPage while the database is down. */
export function ShopDownGate({ children }: { children: ReactNode }) {
  const down = useBackendDown();
  const { pathname } = useLocation();
  const adminArea = pathname.startsWith('/admin');
  if (down && !adminArea) return <ShopDownPage />;
  return (
    <>
      {adminArea && pathname !== '/admin-access' && <BackendDownNote />}
      {children}
    </>
  );
}
