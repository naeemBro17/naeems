import { useState, type CSSProperties, type ReactNode } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { BackButton } from '../components/shared/BackButton';
import { AddMoneySheet } from '../components/wallet/AddMoneySheet';
import { useAuth } from '../contexts/AuthContext';
import { useProducts } from '../contexts/ProductContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useMyStoreWallet } from '../hooks/useMyStoreWallet';
import { formatTaka } from '../lib/format';
import { takaTight } from '../lib/advanceDiscount';
import { openExternal } from '../lib/expertLinks';
import {
  STORE_WALLET_METHOD_NAMES,
  storeWalletDay,
  storeWalletEntryLabel,
  storeWalletSigned,
  storeWalletWhatsAppUrl,
  type StoreWalletEntry,
} from '../lib/storeWallet';

const icon = (children: ReactNode) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

const BENEFITS: { title: string; text: string; icon: ReactNode }[] = [
  {
    title: 'Pay less on delivery',
    text: 'Your balance is used first, the rest on delivery.',
    icon: icon(
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M9.5 8h2.5a2.5 2.5 0 010 5H9.5M9.5 8v8M9.5 13l4 3" />
      </>
    ),
  },
  {
    title: 'It never expires',
    text: 'Your balance waits for you, always.',
    icon: icon(
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
  },
  {
    title: 'Your pace, your choice',
    text: 'Add a little or a lot, whenever it suits you.',
    icon: icon(<path d="M12 20s-7-4.35-7-10a4 4 0 017-2.65A4 4 0 0119 10c0 5.65-7 10-7 10z" />),
  },
];

const step = (i: number) => ({ '--mw-i': Math.min(i, 6) }) as CSSProperties;

function timeText(iso: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Asia/Dhaka',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function HistoryRow({ entry }: { entry: StoreWalletEntry }) {
  const label = storeWalletEntryLabel(entry);
  const linked = entry.orderId && entry.orderNumber && label.endsWith(entry.orderNumber);
  return (
    <div className="mw-history__row" data-testid="wallet-history-row">
      <span className="mw-history__what">
        {linked ? (
          <>
            {label.slice(0, label.length - (entry.orderNumber ?? '').length)}
            <Link to={`/orders/${entry.orderId}`}>{entry.orderNumber}</Link>
          </>
        ) : (
          label
        )}
        <span className="mw-history__when">{storeWalletDay(entry.date)}</span>
      </span>
      <span className={`mw-history__amount${entry.amount > 0 ? ' mw-history__amount--in' : ''}`}>{storeWalletSigned(entry.amount)}</span>
    </div>
  );
}

/**
 * Batch 60: My Wallet (/wallet). First visit (nothing in it yet): the story,
 * lines fading in one after another, then Add money. Once there is a
 * balance or history: the balance, any waiting request, Add money and the
 * history, newest first.
 */
export function WalletPage() {
  useDocumentTitle("My Wallet | NAEEM'S");
  const { session, profile, isLoading } = useAuth();
  const { settings } = useProducts();
  const { wallet, loaded, reload, dismiss } = useMyStoreWallet();
  const [adding, setAdding] = useState(false);

  if (isLoading) {
    return (
      <div className="full-screen-center" aria-label="Loading your wallet">
        <span className="spinner spinner--large" aria-hidden="true" />
      </div>
    );
  }
  // Signed out: sign in on the account page, then come back here.
  if (!session || !profile) return <Navigate to="/account" replace state={{ from: '/wallet' }} />;
  if (profile.role !== 'customer') return <Navigate to="/account" replace />;
  if (!loaded) {
    return (
      <div className="full-screen-center" aria-label="Loading your wallet">
        <span className="spinner spinner--large" aria-hidden="true" />
      </div>
    );
  }

  const shopNumber = settings.shop_bkash_number.trim();
  const nagadAvailable = shopNumber !== '' && settings.advance_discount_type.trim() !== '';
  const rejected = wallet.results.filter((r) => r.status === 'rejected');
  const helpUrl = storeWalletWhatsAppUrl(settings.shop_whatsapp_number, 'Hi, I have a question about my wallet');
  const story = wallet.balance === 0 && wallet.history.length === 0 && wallet.waiting.length === 0 && rejected.length === 0;
  const openAdd = () => setAdding(true);

  const sheet = (
    <AddMoneySheet
      isOpen={adding}
      onClose={() => setAdding(false)}
      onSent={() => void reload()}
      shopNumber={shopNumber}
      nagadAvailable={nagadAvailable}
      shopWhatsApp={settings.shop_whatsapp_number}
      customerName={profile.full_name ?? ''}
    />
  );

  if (story) {
    // The sheet sits outside .mw-page: ".mw-page > *" would make it part of the page flow.
    return (
      <>
      <div className="mw-page" data-testid="wallet-page" data-view="story">
        <div className="mw-wash" aria-hidden="true">
          <span />
          <span />
        </div>
        <BackButton />
        <p className="mw-eyebrow mw-in" style={step(0)}>
          MY WALLET
        </p>
        <h1 className="mw-head mw-in" style={step(1)}>
          Save a little now.
          <br />
          Glow a lot later.
        </h1>
        <p className="mw-lead mw-in" style={step(2)}>
          Put money aside for the skincare you love, at your own pace. When you're ready to order, your wallet pays first.
        </p>
        {BENEFITS.map((b, i) => (
          <div key={b.title} className="mw-ben mw-in" style={step(3 + i)}>
            <span className="mw-ben__icon" aria-hidden="true">
              {b.icon}
            </span>
            <span>
              <span className="mw-ben__title">{b.title}</span>
              <span className="mw-ben__text">{b.text}</span>
            </span>
          </div>
        ))}
        <div className="mw-cta mw-in" style={step(6)}>
          <button type="button" className="mw-btn mw-btn--primary" onClick={openAdd} data-testid="wallet-add">
            Add money
          </button>
          <p className="mw-fine">Wallet balance is for shopping with us and can't be refunded as cash.</p>
        </div>
      </div>
      {sheet}
      </>
    );
  }

  let i = 0;
  return (
    <>
    <div className="mw-page" data-testid="wallet-page" data-view="balance">
      <div className="mw-wash" aria-hidden="true">
        <span />
        <span />
      </div>
      <BackButton />
      <p className="mw-eyebrow mw-in" style={step(i++)}>
        MY WALLET
      </p>
      <div className="mw-balance mw-in" style={step(i++)} data-testid="wallet-balance">
        <span className="mw-balance__label">Balance</span>
        <p className="mw-balance__value">{formatTaka(wallet.balance)}</p>
        {wallet.due > 0 && (
          <div className="mw-due" data-testid="wallet-due">
            <span>Due</span>
            <b>{formatTaka(wallet.due)}</b>
          </div>
        )}
        {wallet.waiting.map((w) => (
          <div key={w.id} className="mw-wait" data-testid="wallet-waiting">
            <span className="mw-wait__text">
              <b>{formatTaka(w.amount)} waiting for confirmation</b>
              <span className="mw-wait__sub">
                {STORE_WALLET_METHOD_NAMES[w.method]} · {w.trxId} · {timeText(w.createdAt)}
              </span>
            </span>
          </div>
        ))}
        {rejected.map((r) => (
          <div key={r.id} className="mw-wait" data-testid="wallet-rejected">
            <span className="mw-wait__text">
              <b>We couldn't confirm {takaTight(r.amount)}. Please message us on WhatsApp.</b>
              <span className="mw-wait__actions">
                {helpUrl && (
                  <button type="button" className="mw-link" onClick={() => openExternal(helpUrl)}>
                    WhatsApp
                  </button>
                )}
                <button type="button" className="mw-link" onClick={() => void dismiss(r.id)} data-testid="wallet-rejected-dismiss">
                  Dismiss
                </button>
              </span>
            </span>
          </div>
        ))}
      </div>
      <div className="mw-page-actions mw-in" style={step(i++)}>
        <button type="button" className="mw-btn mw-btn--primary" onClick={openAdd} data-testid="wallet-add">
          Add money
        </button>
        <p className="mw-fine">Use your balance on any order, anytime. It never expires and can't be refunded as cash.</p>
      </div>
      {wallet.history.length > 0 && (
        <div className="mw-history mw-in" style={step(i++)} data-testid="wallet-history">
          {wallet.history.map((entry) => (
            <HistoryRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}
      <p className="mw-head mw-head--small mw-in" style={step(i++)}>
        Save a little now. Glow a lot later.
      </p>
    </div>
    {sheet}
    </>
  );
}
