import { useId, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
// Batch 62: the story headline's font, in the Wallet page's chunk only.
import '@fontsource/anton/latin-400.css';
import { BackButton } from '../components/shared/BackButton';
import { WhatsAppIcon } from '../components/expert/SocialLinks';
import { AddMoneySheet } from '../components/wallet/AddMoneySheet';
import { useAuth } from '../contexts/AuthContext';
import { useProducts } from '../contexts/ProductContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useMyStoreWallet } from '../hooks/useMyStoreWallet';
import { formatTaka } from '../lib/format';
import { takaTight } from '../lib/advanceDiscount';
import { navigateBack } from '../lib/viewTransition';
import { openExternal } from '../lib/expertLinks';
import {
  STORE_WALLET_METHOD_NAMES,
  storeWalletDay,
  storeWalletEntryLabel,
  storeWalletOpenMessage,
  storeWalletSigned,
  storeWalletWhatsAppUrl,
  type StoreWalletEntry,
} from '../lib/storeWallet';

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

const storyIcon = (children: ReactNode) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

const PROMISES: { title: string; text: string; icon: ReactNode }[] = [
  {
    title: 'Your wallet pays first',
    text: 'Put money aside at your own pace. When you order, your balance is used first and the rest is paid on delivery.',
    icon: storyIcon(
      <text x="12" y="17" textAnchor="middle" fontSize="15" fontWeight="700" fill="currentColor" stroke="none">
        ৳
      </text>
    ),
  },
  {
    title: 'It never expires',
    text: 'Your balance waits for you, always. Use it on any order, anytime.',
    icon: storyIcon(
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5V12l3 2" />
      </>
    ),
  },
  {
    title: 'Opened by our team',
    text: 'For your safety, we turn on each wallet ourselves. Just ask us.',
    icon: storyIcon(
      <>
        <rect x="5" y="11" width="14" height="9" rx="2" />
        <path d="M8 11V8a4 4 0 018 0v3" />
      </>
    ),
  },
];

const PROMISE_DELAYS = ['3.1s', '3.7s', '4.3s'];
const FINE_PRINT = "Wallet balance is for shopping with us and can't be refunded as cash.";

/** The hero: "Save for the glow you love", coins dropping into a jar that
 *  fills a step with each one. Only transform and opacity move. */
function JarHero() {
  const uid = useId().replace(/:/g, '');
  const clipId = `mwj-clip-${uid}`;
  const gradId = `mwj-grad-${uid}`;
  return (
    <div className="mwj-hero">
      <h1 className="mwj-title" aria-label="Save for the glow you love">
        <span className="ln">
          <span className="w" style={{ animationDelay: '.3s' }}>
            Save
          </span>{' '}
          <span className="w" style={{ animationDelay: '.65s' }}>
            for
          </span>
        </span>
        <span className="ln">
          <span className="w" style={{ animationDelay: '1s' }}>
            the
          </span>{' '}
          <span className="w gold" style={{ animationDelay: '1.35s' }}>
            glow
          </span>
        </span>
        <span className="ln">
          <span className="w" style={{ animationDelay: '1.7s' }}>
            you
          </span>{' '}
          <span className="w" style={{ animationDelay: '2.05s' }}>
            love
          </span>
        </span>
      </h1>
      <span className="mwj-coin c1" aria-hidden="true">
        ৳
      </span>
      <span className="mwj-coin c2" aria-hidden="true">
        ৳
      </span>
      <span className="mwj-coin c3" aria-hidden="true">
        ৳
      </span>
      <span className="mwj-coin float" aria-hidden="true">
        ৳
      </span>
      <svg className="mwj-jar" viewBox="0 0 150 190" aria-hidden="true">
        <defs>
          <clipPath id={clipId}>
            <path d="M30 46 Q22 54 22 70 L22 160 Q22 182 44 182 L106 182 Q128 182 128 160 L128 70 Q128 54 120 46 Z" />
          </clipPath>
          <linearGradient id={gradId} x1="0" x2="1">
            <stop offset="0" stopColor="#ffd27a" />
            <stop offset="1" stopColor="#f08a3c" />
          </linearGradient>
        </defs>
        <g clipPath={`url(#${clipId})`}>
          <rect className="mwj-fill" x="0" y="20" width="150" height="170" fill={`url(#${gradId})`} opacity=".92" />
          <g fill="#fff3d6" opacity=".45">
            <circle cx="50" cy="168" r="8" />
            <circle cx="78" cy="172" r="8" />
            <circle cx="104" cy="166" r="8" />
          </g>
        </g>
        <path
          d="M30 46 Q22 54 22 70 L22 160 Q22 182 44 182 L106 182 Q128 182 128 160 L128 70 Q128 54 120 46 Z"
          fill="rgba(255,255,255,.08)"
          stroke="rgba(255,255,255,.55)"
          strokeWidth="3"
        />
        <rect x="34" y="26" width="82" height="22" rx="7" fill="#e9e1d6" opacity=".9" />
        <rect x="52" y="34" width="46" height="5" rx="2.5" fill="#3b2f26" />
        <path d="M36 74 Q34 120 40 160" stroke="rgba(255,255,255,.45)" strokeWidth="5" strokeLinecap="round" fill="none" />
      </svg>
    </div>
  );
}

function StoryBack() {
  const navigate = useNavigate();
  return (
    <button type="button" className="mw-back" onClick={() => navigateBack(navigate)} aria-label="Go back">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M19 12H5" />
        <path d="M12 19l-7-7 7-7" />
      </svg>
    </button>
  );
}

/**
 * Batch 60: My Wallet (/wallet). Batch 62: wallets are by invitation.
 *  A. closed: the jar story, "INVITE ONLY", three promises and "Ask us to
 *     open my wallet" (WhatsApp to the shop).
 *  B. open, nothing in it yet: the jar story, "YOUR WALLET IS OPEN", two
 *     promises and Add money.
 *  C. open with a balance or history: Batch 60's balance view.
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
  const empty = wallet.balance === 0 && wallet.history.length === 0 && wallet.waiting.length === 0 && rejected.length === 0;
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

  if (!wallet.open || empty) {
    const closed = !wallet.open;
    const askUrl = storeWalletWhatsAppUrl(settings.shop_whatsapp_number, storeWalletOpenMessage(profile.full_name ?? ''));
    const promises = closed ? PROMISES : PROMISES.slice(0, 2);
    return (
      <>
        <div className="mw-story" data-testid="wallet-page" data-view={closed ? 'closed' : 'open'}>
          <StoryBack />
          <JarHero />
          <span className={`mwj-badge${closed ? '' : ' open'}`} style={{ animationDelay: '2.7s' }} data-testid="wallet-badge">
            {closed ? 'INVITE ONLY' : 'YOUR WALLET IS OPEN'}
          </span>
          {promises.map((p, i) => (
            <div key={p.title} className="mwj-ben" style={{ animationDelay: PROMISE_DELAYS[i] }} data-testid="wallet-promise">
              <span className="mwj-ic">{p.icon}</span>
              <span className="mwj-bt">
                <b>{p.title}</b>
                <span>{p.text}</span>
              </span>
            </div>
          ))}
          <div className="mwj-cta" style={{ animationDelay: closed ? '5s' : '4.4s' }}>
            {closed ? (
              <button
                type="button"
                className="mwj-btn wa"
                onClick={() => askUrl && openExternal(askUrl)}
                disabled={!askUrl}
                data-href={askUrl ?? undefined}
                data-testid="wallet-ask"
              >
                <span className="mw-wa-icon" aria-hidden="true">
                  <WhatsAppIcon />
                </span>
                Ask us to open my wallet
              </button>
            ) : (
              <button type="button" className="mwj-btn or" onClick={openAdd} data-testid="wallet-add">
                Add money
              </button>
            )}
            <p className="mwj-fine">{FINE_PRINT}</p>
          </div>
        </div>
        {!closed && sheet}
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
          <div key={r.id} className="mw-wait mw-wait--rejected" data-testid="wallet-rejected">
            <span className="mw-wait__text">
              <span>
                Your {takaTight(r.amount)} wasn&apos;t added. The payment didn&apos;t match our records. Message us on WhatsApp and we&apos;ll sort it out.
              </span>
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
        Save for the glow you love.
      </p>
    </div>
    {sheet}
    </>
  );
}
