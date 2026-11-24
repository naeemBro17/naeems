import { useEffect, useMemo, useState } from 'react';
import { BottomSheet } from '../shared/BottomSheet';
import { useToast } from '../../hooks/useToast';
import { useComboLines, type LiveComboLine } from '../../hooks/useComboLines';
import { formatTaka } from '../../lib/format';
import { drawComboCollage } from '../../lib/comboCollage';
import {
  COMBO_NAME_MAX,
  COMBO_NOTE_MAX,
  comboTotals,
  comboUrl,
  createCombo,
  isPhone,
  messengerShareUrl,
  saveComboPreview,
  whatsAppShareUrl,
  type ComboItem,
} from '../../lib/combos';
import { ComboItemsEditor } from './ComboItemsEditor';

/* ---------------------------------------------------------------- icons */

export function LinkIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
      <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function TickIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function WhatsAppIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 20.5l1.3-4.2A8.5 8.5 0 1 1 8 19.4z" />
      <path d="M9 8.6c.2 2.9 2.6 5.5 5.6 6l1-1.2-1.7-.9-.8.8c-1-.4-2-1.4-2.4-2.4l.8-.8-.9-1.7z" />
    </svg>
  );
}

function MessengerIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3C7 3 3 6.7 3 11.4c0 2.6 1.2 4.9 3.2 6.4V21l3-1.6c.9.2 1.8.4 2.8.4 5 0 9-3.7 9-8.4S17 3 12 3z" />
      <path d="M7.5 13.5l3-3.2 2.2 2.1 3.8-2.4-3 3.2-2.2-2.1z" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 15V3M7.5 7.5L12 3l4.5 4.5" />
      <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    </svg>
  );
}

/* --------------------------------------------------------------- pieces */

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Small round product photos in a row (the first 6). */
export function ComboThumbs({ lines, size = 'md' }: { lines: readonly LiveComboLine[]; size?: 'sm' | 'md' }) {
  const shown = lines.slice(0, 6);
  return (
    <span className={`combo-thumbs combo-thumbs--${size}`} data-testid="combo-thumbs">
      {shown.map((line) => (
        <span key={line.key} className="combo-thumbs__item">
          {line.thumb ? <img src={line.thumb} alt="" width={56} height={56} loading="lazy" decoding="async" /> : null}
        </span>
      ))}
      {lines.length > shown.length && <span className="combo-thumbs__more">+{lines.length - shown.length}</span>}
    </span>
  );
}

/**
 * The cart's dark card (Batch 52 mockup frame 1). Rendered only for the
 * admin — the cart checks the real session role (useAuth().isAdmin).
 */
export function ShareComboCard({ onOpen }: { onOpen: () => void }) {
  return (
    <section className="combo-card" aria-label="Share as a combo" data-testid="combo-card">
      <p className="combo-card__kicker">
        <LockIcon />
        ONLY YOU SEE THIS
      </p>
      <h2 className="combo-card__title">Picked these for a customer?</h2>
      <p className="combo-card__text">Turn this cart into a link. Your customer opens it and adds everything in one tap.</p>
      <button type="button" className="combo-card__button" onClick={onOpen} data-testid="combo-open">
        <LinkIcon />
        Share as a combo
      </button>
    </section>
  );
}

export interface ReadyCombo {
  code: string;
  name: string;
  total: number;
  productCount: number;
  /** The collage (a local picture right after making it, or the saved one). */
  previewSrc: string | null;
}

/** "Your combo link is ready" — link, Copy, the four share buttons and
 *  what the customer sees in the chat (mockup frame 3). */
export function ComboReadyView({ combo, onClearCart }: { combo: ReadyCombo; onClearCart?: () => void }) {
  const { showToast } = useToast();
  const [copied, setCopied] = useState(false);
  const link = comboUrl(combo.code);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    if (await copyText(link)) setCopied(true);
    else showToast('Could not copy the link');
  };

  const messenger = async () => {
    if (isPhone()) {
      window.location.href = messengerShareUrl(link);
      return;
    }
    const ok = await copyText(link);
    showToast(ok ? 'Link copied — paste it in Messenger' : 'Could not copy the link');
  };

  const more = async () => {
    if (canShare) {
      try {
        await navigator.share({ title: combo.name, url: link });
      } catch {
        // Closed without sharing.
      }
      return;
    }
    await copy();
  };

  const n = combo.productCount;
  return (
    <div className="combo-ready" data-testid="combo-ready">
      <span className="combo-ready__tick" aria-hidden="true">
        <TickIcon />
      </span>
      <h2 className="combo-ready__title">Your combo link is ready</h2>
      <p className="combo-ready__sub">
        {combo.name} · <span className="combo-price">{formatTaka(combo.total)}</span>
      </p>

      <div className="combo-ready__link">
        <span className="combo-ready__url" data-testid="combo-link">
          {link.replace(/^https?:\/\//, '')}
        </span>
        <button type="button" className="combo-ready__copy" onClick={() => void copy()} data-testid="combo-copy">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <div className="combo-ready__share">
        <a className="combo-share" href={whatsAppShareUrl(link)} target="_blank" rel="noopener noreferrer" data-testid="combo-share-whatsapp">
          <span className="combo-share__icon">
            <WhatsAppIcon />
          </span>
          WhatsApp
        </a>
        <button type="button" className="combo-share" onClick={() => void messenger()} data-testid="combo-share-messenger">
          <span className="combo-share__icon">
            <MessengerIcon />
          </span>
          Messenger
        </button>
        <button type="button" className="combo-share" onClick={() => void copy()} data-testid="combo-share-copy">
          <span className="combo-share__icon">
            <CopyIcon />
          </span>
          Copy
        </button>
        <button type="button" className="combo-share" onClick={() => void more()} data-testid="combo-share-more">
          <span className="combo-share__icon">
            <ShareIcon />
          </span>
          More
        </button>
      </div>

      <p className="combo-ready__label">Your customer will see this in the chat:</p>
      <div className="combo-preview" data-testid="combo-chat-preview">
        <div className="combo-preview__image">
          {combo.previewSrc ? <img src={combo.previewSrc} alt="" width={1200} height={630} /> : <span className="combo-preview__blank" />}
        </div>
        <div className="combo-preview__body">
          <p className="combo-preview__title">{combo.name} — picked for you by NAEEM&apos;S</p>
          <p className="combo-preview__desc">
            {n} product{n === 1 ? '' : 's'}, hand-picked by Naeem. 100% authentic.
          </p>
          <p className="combo-preview__site">{window.location.host}</p>
        </div>
      </div>

      {onClearCart && (
        <button type="button" className="combo-ready__clear" onClick={onClearCart} data-testid="combo-clear-cart">
          Clear my cart
        </button>
      )}
    </div>
  );
}

/** Share sheet for a combo that already exists (Admin → Combos). */
export function ShareComboSheet({ combo, onClose }: { combo: ReadyCombo | null; onClose: () => void }) {
  return (
    <BottomSheet isOpen={combo !== null} onClose={onClose} title="Share combo" panelClassName="combo-sheet">
      {combo && <ComboReadyView combo={combo} />}
    </BottomSheet>
  );
}

/**
 * "Share as a combo" (mockup frame 2, without a combo price): name, note,
 * Create link → the link-ready view. Saves the lines (product, option,
 * quantity); prices are never saved. Batch 62: starts from the cart (or
 * empty, from Admin → Combos) and "Add products" adds any active product.
 */
export function MakeComboSheet({
  isOpen,
  onClose,
  items,
  onClearCart,
  onCreated,
}: {
  isOpen: boolean;
  onClose: () => void;
  items: readonly ComboItem[];
  /** The cart's "Clear cart" (none when the combo was not made from it). */
  onClearCart?: () => void;
  /** Batch 62: called once the link is made. */
  onCreated?: () => void;
}) {
  const { showToast } = useToast();
  const [list, setList] = useState<ComboItem[]>(() => [...items]);
  const lines = useComboLines(list);
  const totals = useMemo(() => comboTotals(lines), [lines]);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState<ReadyCombo | null>(null);

  // A fresh form each time the sheet opens; the local picture is let go.
  useEffect(() => {
    if (!isOpen) return;
    setList([...items]);
    setName('');
    setNote('');
    setError(null);
    setReady(null);
  }, [isOpen]);
  useEffect(() => {
    const src = ready?.previewSrc;
    return () => {
      if (src && src.startsWith('blob:')) URL.revokeObjectURL(src);
    };
  }, [ready]);

  const create = async () => {
    if (name.trim() === '') {
      setError('Give the combo a name.');
      return;
    }
    setBusy(true);
    setError(null);
    // Batch 62: only lines the shop still has (the list shown), in its order.
    const result = await createCombo({ name, note, items: lines.map((l) => ({ product_id: l.product.id, variant_id: l.variantId, quantity: l.quantity })) });
    if (!result.ok) {
      setBusy(false);
      setError(result.message);
      return;
    }
    // The link-preview picture: drawn once here, saved once.
    const picture = await drawComboCollage(lines.map((l) => l.photo ?? '').filter((u) => u !== ''));
    if (picture) await saveComboPreview(result.id, result.code, picture);
    setBusy(false);
    onCreated?.();
    setReady({
      code: result.code,
      name: name.trim(),
      total: totals.total,
      productCount: lines.length,
      previewSrc: picture ? URL.createObjectURL(picture) : null,
    });
  };

  const n = lines.length;
  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title={ready ? 'Your combo link is ready' : 'Share as a combo'} panelClassName="combo-sheet">
      {ready ? (
        <ComboReadyView
          combo={ready}
          onClearCart={
            onClearCart
              ? () => {
                  onClearCart();
                  showToast('Cart cleared');
                  onClose();
                }
              : undefined
          }
        />
      ) : (
        <form
          className="combo-make"
          data-testid="combo-make"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <h2 className="combo-make__title">Share as a combo</h2>
          <p className="combo-make__sub">
            {n} product{n === 1 ? '' : 's'} · total <span className="combo-price">{formatTaka(totals.total)}</span>
          </p>
          <ComboThumbs lines={lines} />
          <ComboItemsEditor items={list} lines={lines} onChange={setList} />

          <label className="combo-field">
            <span className="combo-field__label">Combo name</span>
            <input
              className="combo-field__input"
              value={name}
              maxLength={COMBO_NAME_MAX}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Sadia's glow routine"
              required
              data-testid="combo-name"
            />
          </label>
          <label className="combo-field">
            <span className="combo-field__label">
              Note for the customer <span className="combo-field__optional">(optional)</span>
            </span>
            <textarea
              className="combo-field__input combo-field__input--area"
              value={note}
              maxLength={COMBO_NOTE_MAX}
              rows={3}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Cleanser morning & night. Serum only at night."
              data-testid="combo-note"
            />
            <span className="combo-field__count">
              {note.length}/{COMBO_NOTE_MAX}
            </span>
          </label>

          {error && (
            <p className="combo-make__error" role="alert" data-testid="combo-error">
              {error}
            </p>
          )}
          <button type="submit" className="button button--primary button--full" disabled={busy || n === 0} data-testid="combo-create">
            {busy ? 'Making the link…' : 'Create link'}
          </button>
        </form>
      )}
    </BottomSheet>
  );
}
