import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useToast } from '../../../hooks/useToast';
import { readKaarbarFile } from '../../../lib/kaarbar/api';
import {
  buildDrafts,
  choiceId,
  choiceLabel,
  itemCounts,
  itemKeysInView,
  itemsKeptInView,
  itemSaveRows,
  needsMatch,
  needsPrice,
  pickChoice,
  pickHidden,
  readItemList,
  searchChoices,
  type ItemDraft,
  type ItemFilter,
  type ItemRow,
  type SiteChoice,
} from '../../../lib/kaarbar/oldSales';
import { removeHiddenProducts, saveItems, type KeptProduct, type OldSalesStatus } from '../../../lib/kaarbar/oldSalesApi';
import { moneyText } from '../../../lib/money/format';
import { BottomSheet } from '../../shared/BottomSheet';
import { AdminSearch, ChipRow } from '../ui/AdminUi';
import { importWhen, PasswordSheet } from './KaarbarImportTab';

const PAGE = 60;

const TAGS: Record<ItemDraft['how'], string> = { auto: 'Auto', hand: 'By hand', hidden: 'Hidden', none: '' };

/**
 * Batch 50 Step 1: Kaarbar's Item List → every item matched to a site
 * product (or to a new hidden product) once, with the buying price the
 * old bills use. Saved with the password; can be opened and changed later.
 */
export function KaarbarProductsCard({ status, onChanged }: { status: OldSalesStatus; onChanged: () => Promise<void> }) {
  const { showToast } = useToast();
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [twice, setTwice] = useState<string[]>([]);
  const rows = useRef<readonly ItemRow[]>([]);
  const [drafts, setDrafts] = useState<ItemDraft[]>(() => buildDrafts([], status.items, status.choices));
  const [filter, setFilter] = useState<ItemFilter>('all');
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [picking, setPicking] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'save' | 'remove' | null>(null);
  const [kept, setKept] = useState<KeptProduct[] | null>(null);
  const [dirty, setDirty] = useState(false);
  // Batch 53.1: bumped when the filter, the search or the whole list
  // changes; only then is the set of rows on screen taken again.
  const [viewNo, setViewNo] = useState(0);
  const [view, setView] = useState<{ no: number; keys: ReadonlySet<string> }>({ no: -1, keys: new Set() });

  // A fresh status (after saving) is the new starting point.
  useEffect(() => {
    setDrafts(buildDrafts(rows.current, status.items, status.choices));
    setDirty(false);
    setViewNo((n) => n + 1);
  }, [status]);

  const pick = async (file: File | null) => {
    if (!file) return;
    setFileName(file.name);
    setFileError(null);
    setKept(null);
    try {
      const sheets = await readKaarbarFile(file);
      let firstError: string | null = null;
      for (const cells of sheets) {
        const read = readItemList(cells);
        if (!read.error) {
          rows.current = read.rows;
          setTwice(read.twice);
          const next = buildDrafts(read.rows, status.items, status.choices);
          setDrafts(next);
          setDirty(true);
          setFilter(next.some((d) => needsMatch(d) || needsPrice(d)) ? 'needs' : 'all');
          setSearch('');
          setShown(PAGE);
          setViewNo((n) => n + 1);
          return;
        }
        firstError ??= read.error;
      }
      setFileError(firstError ?? 'The file is empty.');
    } catch (e) {
      setFileError(e instanceof Error ? e.message : 'Could not read the file.');
    }
  };

  const update = (key: string, change: (d: ItemDraft) => ItemDraft) => {
    setDrafts((list) => list.map((d) => (d.key === key ? change(d) : d)));
    setDirty(true);
  };

  const counts = useMemo(() => itemCounts(drafts), [drafts]);
  const needs = useMemo(() => drafts.filter((d) => needsMatch(d) || needsPrice(d)).length, [drafts]);
  const saveRows = useMemo(() => itemSaveRows(drafts), [drafts]);

  const inView = view.no === viewNo ? view.keys : itemKeysInView(drafts, filter, search);
  if (view.no !== viewNo) setView({ no: viewNo, keys: inView });
  const visible = useMemo(() => itemsKeptInView(drafts, inView), [drafts, inView]);

  const picked = drafts.find((d) => d.key === picking) ?? null;

  const doSave = async (): Promise<string | null> => {
    if (!saveRows) return 'Some items still need a product or a buying price.';
    const answer = await saveItems(saveRows);
    if (!answer.ok) return answer.error;
    setSheet(null);
    showToast(
      `Saved ${saveRows.length} item${saveRows.length === 1 ? '' : 's'}${answer.data.hiddenMade > 0 ? ` · ${answer.data.hiddenMade} hidden product${answer.data.hiddenMade === 1 ? '' : 's'} made` : ''}`
    );
    await onChanged();
    return null;
  };

  const doRemove = async (): Promise<string | null> => {
    const answer = await removeHiddenProducts();
    if (!answer.ok) return answer.error;
    setSheet(null);
    setKept(answer.data.kept);
    showToast(`Removed ${answer.data.removed} hidden product${answer.data.removed === 1 ? '' : 's'}`);
    await onChanged();
    return null;
  };

  const last = status.lastProducts;
  const madeCount = status.items.filter((i) => i.madeProductId).length;

  return (
    <section className="adm-ocard kb-card" aria-label="Step 1 · Old products" data-testid="kb-products">
      <h2 className="kb-card__title">Step 1 · Old products</h2>
      <p className="inv-muted">
        From Kaarbar: Reports → Item List Report → Excel. Match every Kaarbar item to a product on the site once. The old bills in Step 2 use
        this list and its buying prices.
      </p>
      <label className="adm-btn kb-file">
        {fileName ? 'Pick another file' : 'Pick the Item List Report'}
        <input type="file" accept=".xlsx" hidden onChange={(e) => void pick(e.target.files?.[0] ?? null)} data-testid="kb-products-file" />
      </label>
      {fileName && <p className="inv-muted kb-filename">{fileName}</p>}
      {!fileName && status.items.length > 0 && (
        <p className="inv-muted" data-testid="kb-products-saved">
          Saved list: {status.items.length} items{last ? ` (saved ${importWhen(last.at)})` : ''}. Change a match or a price below and save again,
          or pick the file again to add new items.
        </p>
      )}
      {fileError && (
        <p className="inv-error" role="alert" data-testid="kb-products-error">
          {fileError}
        </p>
      )}
      {twice.length > 0 && <p className="inv-muted">Twice in the file (kept once): {twice.join(', ')}</p>}

      {drafts.length > 0 && (
        <div className="inv-stack" data-testid="kb-products-preview">
          <ul className="kb-counts" aria-label="Items">
            <li className="kb-counts__item" data-testid="kb-pcount-matched">
              <span>Matched</span>
              <b>{counts.matched}</b>
            </li>
            <li className="kb-counts__item" data-testid="kb-pcount-hand">
              <span>Pick by hand</span>
              <b>{counts.byHand}</b>
            </li>
            <li className="kb-counts__item" data-testid="kb-pcount-hidden">
              <span>New hidden product</span>
              <b>{counts.hidden}</b>
            </li>
            <li className="kb-counts__item" data-testid="kb-pcount-price">
              <span>Buying price missing</span>
              <b>{counts.noPrice}</b>
            </li>
          </ul>

          <AdminSearch
            value={search}
            onChange={(q) => {
              setSearch(q);
              setViewNo((n) => n + 1);
            }}
            placeholder="Search an item"
            label="Search the items"
          />
          <ChipRow
            label="Show"
            active={filter}
            onSelect={(id) => {
              setFilter(id as ItemFilter);
              setShown(PAGE);
              setViewNo((n) => n + 1);
            }}
            chips={[
              { id: 'all', label: 'All', count: drafts.length },
              { id: 'needs', label: 'Needs you', count: needs },
              { id: 'matched', label: 'Matched', count: counts.matched },
              { id: 'hidden', label: 'New hidden', count: counts.hidden },
            ]}
          />

          <ul className="kb-list kb-list--items" data-testid="kb-items">
            {visible.slice(0, shown).map((d) => (
              <ItemRowView key={d.key} draft={d} onPick={() => setPicking(d.key)} onPrice={(price) => update(d.key, (x) => ({ ...x, price, priceFrom: 'typed' }))} />
            ))}
          </ul>
          {visible.length === 0 && <p className="inv-muted">{filter === 'needs' ? 'Nothing needs you.' : 'No item matches.'}</p>}
          {visible.length > shown && (
            <button type="button" className="adm-btn adm-btn--ghost" onClick={() => setShown((s) => s + PAGE)}>
              Show {Math.min(PAGE, visible.length - shown)} more
            </button>
          )}

          <div className="kb-savebar">
            <button
              type="button"
              className="adm-btn kb-go"
              disabled={!saveRows || !dirty}
              onClick={() => setSheet('save')}
              data-testid="kb-products-save"
            >
              Save product list
            </button>
            <span className="inv-muted" data-testid="kb-products-save-note">
              {!saveRows
                ? `${needs} item${needs === 1 ? '' : 's'} still need${needs === 1 ? 's' : ''} a product or a buying price.`
                : dirty
                  ? `${drafts.length} items ready.`
                  : 'Saved. Nothing changed.'}
            </span>
          </div>
        </div>
      )}

      {kept && kept.length > 0 && (
        <div className="kb-notice" data-testid="kb-products-kept">
          <b>Kept {kept.length} hidden product{kept.length === 1 ? '' : 's'}:</b>
          <ul>
            {kept.map((k) => (
              <li key={k.name}>
                {k.name} — {k.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <section className="adm-careful kb-careful" aria-label="Careful actions" data-testid="kb-products-careful">
        <h3 className="adm-careful__title">Careful actions</h3>
        <p className="adm-ocard__muted">You will be asked for your password.</p>
        <ul className="adm-careful__list">
          <li className="adm-careful__row">
            <span className="adm-careful__text">
              <span className="adm-careful__name">Remove hidden products made by the import</span>
              <span className="adm-careful__explain">
                {madeCount > 0
                  ? `${madeCount} made. Only those with no orders, no lots, no old bills and never shown in the shop are removed.`
                  : 'The import has not made any hidden product.'}
              </span>
            </span>
            <button
              type="button"
              className="adm-btn adm-btn--sm adm-careful__btn adm-careful__btn--red"
              disabled={madeCount === 0}
              onClick={() => setSheet('remove')}
              data-testid="kb-products-remove"
            >
              Remove…
            </button>
          </li>
        </ul>
      </section>

      <ChoicePicker
        draft={picked}
        choices={status.choices}
        onClose={() => setPicking(null)}
        onChoose={(c) => {
          if (picked) update(picked.key, (d) => (c === 'hidden' ? pickHidden(d) : pickChoice(d, c)));
          setPicking(null);
        }}
      />

      <PasswordSheet
        isOpen={sheet === 'save'}
        title="Save the product list?"
        text={`${drafts.length} items.${counts.hidden > 0 ? ` Items marked Hidden get a product of their own that is never shown in the shop.` : ''} Nothing in the shop changes, and no buying price of a product already on the site is changed.`}
        confirmLabel="Save"
        onConfirm={doSave}
        onClose={() => setSheet(null)}
      />
      <PasswordSheet
        isOpen={sheet === 'remove'}
        title="Remove the hidden products?"
        text="Removes the hidden products the import made, except any that has orders, is in a lot, is used by old bills or was ever shown in the shop. Items that pointed at a removed product need a product again."
        confirmLabel="Remove"
        danger
        onConfirm={doRemove}
        onClose={() => setSheet(null)}
      />
    </section>
  );
}

function ItemRowView({ draft: d, onPick, onPrice }: { draft: ItemDraft; onPick: () => void; onPrice: (price: string) => void }) {
  const missingPrice = needsPrice(d);
  const done = !needsMatch(d) && !missingPrice;
  const choiceText = d.how === 'hidden' ? (d.saved?.madeProductId ? `${d.name} (hidden product)` : 'New hidden product') : d.choice ? choiceLabel(d.choice) : null;
  const priceNote =
    d.priceFrom === 'site' ? 'From the site. Change it if you paid differently then.'
    : d.priceFrom === 'kaarbar' ? "Kaarbar's purchase price."
    : null;
  const billNote = d.saved && d.saved.billLines > 0 ? `Used by ${d.saved.billLines} old bill lines: a new price corrects their profit too.` : null;
  return (
    <li className="kb-item" data-testid="kb-item-row" data-how={d.how} data-done={done ? 'true' : 'false'}>
      <div className="kb-item__head">
        <span className="kb-item__label">KAARBAR</span>
        <span className="kb-item__name">{d.name}</span>
      </div>
      <button type="button" className={`kb-pick${choiceText ? '' : ' kb-pick--empty'}`} onClick={onPick} data-testid="kb-item-pick">
        <span className="kb-pick__text">{choiceText ?? 'Pick a site product'}</span>
        {d.how !== 'none' && <span className={`kb-tag kb-tag--${d.how}`}>{TAGS[d.how]}</span>}
      </button>
      <label className="kb-item__price">
        <span className="kb-item__price-label">Buying price (per pack)</span>
        <input
          className={`form-input kb-item__price-input${missingPrice ? ' kb-item__price-input--missing' : ''}`}
          inputMode="decimal"
          value={d.price}
          placeholder="৳"
          onChange={(e) => onPrice(e.target.value)}
          aria-label={`Buying price of ${d.name}`}
          aria-invalid={missingPrice}
          data-testid="kb-item-price"
        />
      </label>
      {(done || priceNote || billNote) && (
        <div className="kb-item__notes">
          {done && <span className="kb-item__done" data-testid="kb-item-done">Done</span>}
          {priceNote && <span className="kb-item__note">{priceNote}</span>}
          {billNote && <span className="kb-item__note">{billNote}</span>}
        </div>
      )}
    </li>
  );
}

/** Batch 54: also used by Merge old data (with a grey note under the item). */
export function ChoicePicker({
  draft,
  choices,
  note,
  onClose,
  onChoose,
}: {
  draft: Pick<ItemDraft, 'name' | 'choice'> | null;
  choices: readonly SiteChoice[];
  note?: string | null;
  onClose: () => void;
  onChoose: (choice: SiteChoice | 'hidden') => void;
}) {
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (draft) setQuery('');
  }, [draft]);
  const list = useMemo(() => (draft ? searchChoices(query, draft.name, choices).slice(0, 40) : []), [draft, query, choices]);
  // Arrow keys move between the rows (from the search box too); the
  // focused row scrolls into view.
  const listRef = useRef<HTMLUListElement>(null);
  const moveFocus = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('.kb-picker__row') ?? []);
    if (rows.length === 0) return;
    e.preventDefault();
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = at < 0 ? (e.key === 'ArrowDown' ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)));
    rows[next].focus();
    rows[next].scrollIntoView({ block: 'nearest' });
  };
  return (
    <BottomSheet isOpen={draft !== null} onClose={onClose} title="Pick the site product" panelClassName="kb-picker">
      <div className="kb-picker__body" data-testid="kb-picker">
        {draft && (
          <p className="kb-picker__for">
            <span className="kb-item__label">KAARBAR</span>
            <b>{draft.name}</b>
          </p>
        )}
        {note && (
          <p className="inv-muted" data-testid="kb-picker-note">
            {note}
          </p>
        )}
        <div onKeyDown={moveFocus}>
          <AdminSearch value={query} onChange={setQuery} placeholder="Search site products" label="Search site products" />
        </div>
        <ul ref={listRef} className="kb-picker__list" tabIndex={-1} onKeyDown={moveFocus} data-testid="kb-picker-list">
          <li>
            <button type="button" className="kb-picker__row kb-picker__row--hidden" onClick={() => onChoose('hidden')} data-testid="kb-picker-hidden">
              <span className="kb-picker__name">+ Add as new hidden product</span>
              <span className="kb-row__sub">Never shown in the shop. Only for old sales.</span>
            </button>
          </li>
          {list.map((c) => {
            const on = draft?.choice !== null && draft?.choice !== undefined && choiceId(draft.choice) === choiceId(c);
            return (
              <li key={choiceId(c)}>
                <button type="button" className={`kb-picker__row${on ? ' kb-picker__row--on' : ''}`} onClick={() => onChoose(c)} data-testid="kb-picker-choice">
                  <span className="kb-picker__name">{c.name}</span>
                  <span className="kb-row__sub">
                    {[c.option, !c.isActive ? 'Hidden' : null, c.costPerPack !== null ? `buying ${moneyText(c.costPerPack)}` : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </button>
              </li>
            );
          })}
          {list.length === 0 && <li className="inv-muted kb-picker__none">No site product matches.</li>}
        </ul>
      </div>
    </BottomSheet>
  );
}
