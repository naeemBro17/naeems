import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { AdminFormPage } from '../AdminFormPage';
import { useLeaveGuard } from '../LeaveGuard';
import { BottleIcon, ProductResults } from '../ManualOptionPicker';
import { AdminIcon } from '../ui/AdminIcon';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { CampaignCardPreview } from '../../campaign/CampaignCard';
import { countdownLeft } from '../../campaign/useCountdown';
import { useProducts } from '../../../contexts/ProductContext';
import { useAuth } from '../../../contexts/AuthContext';
import { useToast } from '../../../hooks/useToast';
import { useBelowCost } from '../../../lib/smart/useBelowCost';
import type { BelowCostInput } from '../../../lib/smart/belowCost';
import { moneyText } from '../../../lib/money/format';
import { productSearchGroups, searchProductGroups, type SellableOption, type SellableProduct } from '../../../lib/manualOrderSearch';
import { dropBlock, floorPercent, moveBlock, type CampaignMode, type CampaignStyle } from '../../../lib/campaigns';
import {
  blockFor,
  blocksProblem,
  blocksToItems,
  campaignStatus,
  defaultCampaignDates,
  deleteCampaign,
  dhakaShort,
  fetchAdminCampaigns,
  fromDhakaParts,
  itemsToBlocks,
  plainPercent,
  rowSalePrice,
  saveCampaign,
  toDhakaParts,
  type EditorBlock,
} from '../../../lib/campaignsAdmin';

const NAME_MAX = 40;

interface Props {
  /** null = a new campaign. */
  campaignId: string | null;
  onBack: () => void;
  /** After saving or deleting: back to the list. */
  onDone: () => void;
}

/** "Same %" headline from the editor's rows (the shop's rule, frozen). */
function editorHeadline(blocks: readonly EditorBlock[], mode: CampaignMode, percent: number | null): string {
  const pct: number[] = [];
  for (const b of blocks) {
    for (const r of b.rows) {
      const sale = rowSalePrice(r, mode, percent);
      if (sale !== null && r.retail > 0) pct.push(floorPercent(r.retail, sale));
    }
  }
  if (pct.length === 0) return '';
  const max = Math.max(...pct);
  return pct.every((x) => x === max) ? `${max}% off every item` : `Up to ${max}% off`;
}

/**
 * Batch 66: /admin/campaigns/new and /admin/campaigns/:id/edit. Details
 * (name, dates in Dhaka time, Plain / Glitter with the real Home card as a
 * preview, Same % / Own price) and the products in the order the shop
 * shows them (drag the handle, or ↑ ↓). Below cost never blocks saving.
 */
export function CampaignEditorPage({ campaignId, onBack, onDone }: Props) {
  const { products, variantsFor } = useProducts();
  const { can } = useAuth();
  const seeCost = can('view_profit_costs');
  const { showToast } = useToast();
  const { markDirty, markClean, leave } = useLeaveGuard();

  const defaults = useMemo(() => defaultCampaignDates(), []);
  const [loaded, setLoaded] = useState(campaignId === null);
  const [notFound, setNotFound] = useState(false);
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState(defaults.startDate);
  const [startTime, setStartTime] = useState(defaults.startTime);
  const [endDate, setEndDate] = useState(defaults.endDate);
  const [endTime, setEndTime] = useState(defaults.endTime);
  const [style, setStyle] = useState<CampaignStyle>('plain');
  const [mode, setMode] = useState<CampaignMode>('percent');
  const [percentInput, setPercentInput] = useState('');
  const [isEnabled, setIsEnabled] = useState(true);
  const [hasOrders, setHasOrders] = useState(false);
  const [blocks, setBlocks] = useState<EditorBlock[]>([]);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dragging, setDragging] = useState<number | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const dragRef = useRef<{ index: number; pointerId: number } | null>(null);

  const groups = useMemo(() => productSearchGroups(products, variantsFor), [products, variantsFor]);
  const thumbOf = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const g of groups) map.set(g.productId, g.options[0]?.thumbUrl ?? null);
    return map;
  }, [groups]);
  // One row per product: the whole product is added (sizes come with it).
  const results = useMemo((): SellableProduct[] => {
    if (query.trim() === '') return [];
    return searchProductGroups(groups, query)
      .filter((g) => !blocks.some((b) => b.productId === g.productId))
      .map((g) => ({ ...g, options: [{ ...g.options[0], label: g.name, variantLabel: null }] }));
  }, [groups, query, blocks]);

  const makeBlock = (productId: string): EditorBlock | null => {
    const p = products.find((x) => x.id === productId);
    return p ? blockFor(p, variantsFor(p.id), thumbOf.get(p.id) ?? null) : null;
  };

  // Edit: load the campaign once the products are here.
  useEffect(() => {
    if (campaignId === null || loaded || products.length === 0) return;
    let alive = true;
    void fetchAdminCampaigns().then((result) => {
      if (!alive) return;
      const c = result.campaigns.find((x) => x.id === campaignId);
      if (!c) {
        setNotFound(true);
        setLoaded(true);
        return;
      }
      const s = toDhakaParts(c.starts_at);
      const e = toDhakaParts(c.ends_at);
      setName(c.name);
      setStartDate(s.date);
      setStartTime(s.time);
      setEndDate(e.date);
      setEndTime(e.time);
      setStyle(c.style);
      setMode(c.discount_mode);
      setPercentInput(c.percent === null ? '' : plainPercent(c.percent));
      setIsEnabled(c.is_enabled);
      setHasOrders(c.orders > 0);
      setBlocks(itemsToBlocks(c, makeBlock));
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
    // makeBlock reads the products, which this waits for (once).
  }, [campaignId, loaded, products.length]);

  const percent = percentInput.trim() === '' ? null : Number(percentInput);
  const startsAt = fromDhakaParts(startDate, startTime);
  const endsAt = fromDhakaParts(endDate, endTime);
  const headline = editorHeadline(blocks, mode, percent);
  const now = Date.now();
  const previewLeft = countdownLeft(
    endsAt ? new Date(endsAt).getTime() : now,
    startsAt ? Math.max(now, new Date(startsAt).getTime()) : now
  );
  const productCount = blocks.length;
  const summary = `${productCount} product${productCount === 1 ? '' : 's'}${
    mode === 'percent' ? (percent !== null && percent > 0 ? ` · ${plainPercent(percent)}% off` : '') : ' · Own prices'
  }`;
  const when =
    startsAt && endsAt
      ? campaignStatus({ is_enabled: true, starts_at: startsAt, ends_at: endsAt }, now) === 'live'
        ? 'Live now'
        : campaignStatus({ is_enabled: true, starts_at: startsAt, ends_at: endsAt }, now) === 'ended'
          ? 'Ended'
          : `Goes live ${dhakaShort(startsAt)}`
      : 'Choose the dates';

  /* ------------------------------------------------------------ below cost */
  const belowInputs = useMemo((): BelowCostInput[] => {
    if (!seeCost) return [];
    return blocks.flatMap((b) =>
      b.rows.flatMap((r) => {
        const price = rowSalePrice(r, mode, percent);
        return price === null
          ? []
          : [{ key: `${b.productId}::${r.variantId ?? ''}`, product_id: b.productId, variant_id: r.variantId, sold_unit: null, price, quantity: 1 }];
      })
    );
  }, [blocks, mode, percent, seeCost]);
  const costs = useBelowCost(belowInputs, seeCost);

  /* ------------------------------------------------------------ changes */
  const changeBlocks = (next: EditorBlock[]) => {
    setBlocks(next);
    markDirty();
  };
  const addProduct = (option: SellableOption) => {
    const block = makeBlock(option.productId);
    if (block) changeBlocks([...blocks, block]);
    setQuery('');
    setAdding(false);
  };
  const setRowPrice = (bi: number, ri: number, value: string) =>
    changeBlocks(blocks.map((b, i) => (i === bi ? { ...b, rows: b.rows.map((r, j) => (j === ri ? { ...r, price: value } : r)) } : b)));

  const onHandleDown = (e: ReactPointerEvent<HTMLSpanElement>, index: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { index, pointerId: e.pointerId };
    setDragging(index);
  };
  const onHandleMove = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const drag = dragRef.current;
    const list = listRef.current;
    if (!drag || drag.pointerId !== e.pointerId || !list) return;
    const rows = Array.from(list.children) as HTMLElement[];
    let target = rows.length - 1;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) {
        target = i;
        break;
      }
    }
    if (target !== drag.index) {
      const from = drag.index;
      setBlocks((current) => dropBlock(current, from, target));
      drag.index = target;
      setDragging(target);
      markDirty();
    }
  };
  const onHandleUp = (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (dragRef.current?.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setDragging(null);
  };

  /* ------------------------------------------------------------ save */
  const save = async () => {
    if (saving) return;
    setError(null);
    const problem =
      name.trim() === ''
        ? 'Give the campaign a name.'
        : !startsAt || !endsAt
          ? 'Choose when the campaign starts and ends.'
          : new Date(endsAt) <= new Date(startsAt)
            ? 'The end must be after the start.'
            : mode === 'percent' && !(percent !== null && percent > 0 && percent < 100)
              ? 'Enter a % above 0 and below 100.'
              : blocksProblem(blocks, mode);
    if (problem) {
      setError(problem);
      showToast(problem);
      return;
    }
    setSaving(true);
    const result = await saveCampaign({
      ...(campaignId ? { id: campaignId } : {}),
      name: name.trim(),
      style,
      discount_mode: mode,
      percent: mode === 'percent' ? percent : null,
      starts_at: startsAt as string,
      ends_at: endsAt as string,
      is_enabled: isEnabled,
      items: blocksToItems(blocks, mode),
    });
    setSaving(false);
    if (result.error) {
      setError(result.error);
      showToast(result.error);
      return;
    }
    markClean();
    showToast('Campaign saved');
    leave(onDone);
  };

  const remove = async () => {
    if (!campaignId) return;
    const message = await deleteCampaign(campaignId);
    if (message) {
      showToast(message);
      setConfirmDelete(false);
      return;
    }
    showToast('Campaign deleted');
    leave(onDone);
  };

  const title = campaignId ? 'Edit campaign' : 'New campaign';
  if (!loaded || notFound) {
    return (
      <AdminFormPage title={title} backLabel="Back to campaigns" onBack={onBack} testId="campaign-editor" guard={false}>
        {notFound ? <p className="cmpa-muted">This campaign no longer exists.</p> : <span className="spinner" aria-label="Loading" />}
      </AdminFormPage>
    );
  }

  const dockLead = (
    <span className="cmpa-dock-lead">
      <span data-testid="campaign-when">{when}</span>
      <b>{summary}</b>
    </span>
  );

  return (
    <AdminFormPage
      title={title}
      backLabel="Back to campaigns"
      onBack={onBack}
      testId="campaign-editor"
      className="cmpa-page"
      headerPrimary={false}
      dockLead={dockLead}
      primary={{ label: 'Save campaign', onClick: () => void save(), busy: saving }}
    >
      <div className="cmpa-grid">
        <section className="cmpa-box" aria-label="Details">
          <label className="cmpa-field">
            <span className="cmpa-label">
              Name <small>{name.length}/{NAME_MAX}</small>
            </span>
            <input
              className="cmpa-input"
              value={name}
              maxLength={NAME_MAX}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Summer Fest"
              data-testid="campaign-name"
            />
          </label>
          <div className="cmpa-field">
            <span className="cmpa-label">Starts</span>
            <span className="cmpa-when">
              <input type="date" className="cmpa-input" value={startDate} onChange={(e) => setStartDate(e.target.value)} aria-label="Start date" data-testid="campaign-start-date" />
              <input type="time" className="cmpa-input" value={startTime} onChange={(e) => setStartTime(e.target.value)} aria-label="Start time" data-testid="campaign-start-time" />
            </span>
          </div>
          <div className="cmpa-field">
            <span className="cmpa-label">Ends</span>
            <span className="cmpa-when">
              <input type="date" className="cmpa-input" value={endDate} onChange={(e) => setEndDate(e.target.value)} aria-label="End date" data-testid="campaign-end-date" />
              <input type="time" className="cmpa-input" value={endTime} onChange={(e) => setEndTime(e.target.value)} aria-label="End time" data-testid="campaign-end-time" />
            </span>
            <small className="cmpa-hint">Dhaka time</small>
          </div>

          <div className="cmpa-field">
            <span className="cmpa-label">Style</span>
            <span className="cmpa-chips" role="radiogroup" aria-label="Style">
              {(['plain', 'glitter'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={style === s}
                  className={`cmpa-chip${style === s ? ' cmpa-chip--on' : ''}`}
                  onClick={() => {
                    setStyle(s);
                    markDirty();
                  }}
                  data-testid={`campaign-style-${s}`}
                >
                  {s === 'plain' ? 'Plain' : 'Glitter'}
                </button>
              ))}
            </span>
          </div>
          <div className="cmpa-preview">
            <CampaignCardPreview
              campaign={{ id: campaignId ?? 'new', name: name.trim() || 'Campaign name', slug: '', style, ends_at: endsAt ?? new Date(now).toISOString() }}
              headline={headline}
              left={previewLeft}
            />
          </div>

          <div className="cmpa-field">
            <span className="cmpa-label">How do you want to discount?</span>
            <span className="cmpa-seg" role="radiogroup" aria-label="How do you want to discount?">
              {(['percent', 'own_price'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  className={`cmpa-seg__btn${mode === m ? ' cmpa-seg__btn--on' : ''}`}
                  onClick={() => {
                    setMode(m);
                    markDirty();
                  }}
                  data-testid={`campaign-mode-${m}`}
                >
                  {m === 'percent' ? 'Same % for all' : 'Own price each'}
                </button>
              ))}
            </span>
          </div>
          {mode === 'percent' && (
            <label className="cmpa-field">
              <span className="cmpa-label">% off</span>
              <span className="cmpa-pct">
                <input
                  className="cmpa-input"
                  inputMode="decimal"
                  value={percentInput}
                  onChange={(e) => setPercentInput(e.target.value.replace(/[^\d.]/g, ''))}
                  placeholder="15"
                  data-testid="campaign-percent"
                />
                <span>%</span>
              </span>
              <small className="cmpa-hint">Off the shop&apos;s normal price</small>
            </label>
          )}
        </section>

        <div className="cmpa-side">
          <section className="cmpa-box" aria-label="Products">
            <div className="cmpa-box__head">
              <h2>Products</h2>
              <button type="button" className="adm-btn adm-btn--ghost cmpa-add" onClick={() => setAdding((a) => !a)} aria-expanded={adding} data-testid="campaign-add">
                <AdminIcon name="plus" className="adm-icon--sm" />
                Add products
              </button>
            </div>
            {adding && (
              <div className="nord-search cmpa-search">
                <div className="search-bar">
                  <svg className="search-bar__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="11" cy="11" r="8" />
                    <path d="M21 21l-4.35-4.35" />
                  </svg>
                  <input
                    type="search"
                    className="search-bar__input"
                    placeholder="Search product name..."
                    aria-label="Search products"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    autoComplete="off"
                    autoFocus
                    data-testid="campaign-search"
                  />
                </div>
                <ProductResults results={results} onAdd={(o) => addProduct(o)} className="nord-drop" photos label="Products" />
              </div>
            )}

            {blocks.length === 0 ? (
              <p className="cmpa-muted cmpa-empty">No products yet. Add the products that are on sale.</p>
            ) : (
              <ol className="cmpa-items" ref={listRef} data-testid="campaign-items">
                {blocks.map((b, bi) => (
                  <li key={b.productId} className={`cmpa-item${dragging === bi ? ' cmpa-item--drag' : ''}`} data-testid="campaign-item">
                    <span
                      className="cmpa-handle"
                      onPointerDown={(e) => onHandleDown(e, bi)}
                      onPointerMove={onHandleMove}
                      onPointerUp={onHandleUp}
                      onPointerCancel={onHandleUp}
                      aria-hidden="true"
                      title="Drag to move"
                      data-testid="campaign-handle"
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <path d="M5 8h14M5 12h14M5 16h14" />
                      </svg>
                    </span>
                    <span className="nord-thumb nord-thumb--sm">
                      {b.thumb ? <img src={b.thumb} alt="" width={44} height={44} loading="lazy" decoding="async" /> : <BottleIcon />}
                    </span>
                    <span className="cmpa-item__main">
                      <span className="cmpa-item__name" data-testid="campaign-item-name">
                        {b.name}
                      </span>
                      {b.rows.map((r, ri) => {
                        const sale = rowSalePrice(r, mode, percent);
                        const answer = costs.get(`${b.productId}::${r.variantId ?? ''}`);
                        return (
                          <span key={r.variantId ?? 'own'} className="cmpa-row">
                            <span className="cmpa-row__line">
                              <span className="cmpa-row__size">{r.label ?? (mode === 'own_price' ? 'Sale price' : '')}</span>
                              {mode === 'own_price' && (
                                <input
                                  className="cmpa-input cmpa-row__price"
                                  inputMode="decimal"
                                  value={r.price}
                                  onChange={(e) => setRowPrice(bi, ri, e.target.value.replace(/[^\d.]/g, ''))}
                                  placeholder={b.rows.length > 1 ? 'Not on sale' : 'Price'}
                                  aria-label={`Sale price for ${b.name}${r.label ? ` ${r.label}` : ''}`}
                                  data-testid="campaign-row-price"
                                />
                              )}
                              {sale !== null ? (
                                <span className="cmpa-row__prices">
                                  <b>{moneyText(sale)}</b>
                                  <s>{moneyText(r.retail)}</s>
                                </span>
                              ) : (
                                <span className="cmpa-row__prices cmpa-row__prices--none">{moneyText(r.retail)}</span>
                              )}
                            </span>
                            {seeCost && sale !== null && answer && answer.cost !== null && (
                              <span className={`cmpa-cost${answer.below ? ' cmpa-cost--below' : ''}`} data-testid="campaign-cost">
                                {answer.below
                                  ? `Below cost: cost ${moneyText(answer.cost)}, loss ${moneyText(answer.loss ?? answer.cost - sale)}`
                                  : `Cost ${moneyText(answer.cost)} · profit ${moneyText(sale - answer.cost)}`}
                              </span>
                            )}
                          </span>
                        );
                      })}
                    </span>
                    <span className="cmpa-move">
                      <button type="button" aria-label={`Move ${b.name} up`} onClick={() => changeBlocks(moveBlock(blocks, bi, -1))} disabled={bi === 0} data-testid="campaign-up">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M6 15l6-6 6 6" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${b.name} down`}
                        onClick={() => changeBlocks(moveBlock(blocks, bi, 1))}
                        disabled={bi === blocks.length - 1}
                        data-testid="campaign-down"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M6 9l6 6 6-6" />
                        </svg>
                      </button>
                      <button type="button" aria-label={`Remove ${b.name}`} onClick={() => changeBlocks(blocks.filter((_, i) => i !== bi))} data-testid="campaign-remove">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                          <path d="M6 6l12 12M18 6L6 18" />
                        </svg>
                      </button>
                    </span>
                  </li>
                ))}
              </ol>
            )}
            {error && (
              <p className="form-error" role="alert" data-testid="campaign-error">
                {error}
              </p>
            )}
            <footer className="cmpa-foot adm-only-desktop">
              {dockLead}
              <button type="button" className="adm-btn adm-btn--primary" onClick={() => void save()} disabled={saving} data-testid="campaign-save">
                {saving ? <span className="spinner" aria-hidden="true" /> : 'Save campaign'}
              </button>
            </footer>
          </section>

          {campaignId && (
            <button type="button" className="cmpa-delete" onClick={() => setConfirmDelete(true)} data-testid="campaign-delete">
              Delete campaign
            </button>
          )}
        </div>
      </div>

      <ConfirmDialog
        isOpen={confirmDelete}
        title="Delete this campaign?"
        message={
          hasOrders
            ? 'This campaign has orders, so it cannot be deleted. Switch it off instead.'
            : 'It disappears from the shop at once. This cannot be undone.'
        }
        confirmLabel="Delete"
        onConfirm={remove}
        onClose={() => setConfirmDelete(false)}
      />
    </AdminFormPage>
  );
}
