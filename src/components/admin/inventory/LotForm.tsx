import { useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '../../../hooks/useToast';
import { useProducts } from '../../../contexts/ProductContext';
import { normalizeText } from '../../../lib/format';
import { takaExact } from '../../../lib/payouts';
import { allocateLot, rowUnits } from '../../../lib/inventory/allocation';
import {
  dhakaToday,
  fetchLot,
  fetchStockUnits,
  fetchSupplierNames,
  fetchSuppliers,
  renameSupplier,
  saveLot,
  saveSupplier,
  unitName,
} from '../../../lib/inventory/api';
import { buildLotTemplate, parseLotSheet, readLotFile, type LotImportProblem } from '../../../lib/inventory/lotExcel';
import { saveBlob } from '../../../lib/inventory/xlsx';
import { fetchLotPayments, saveLotPayments } from '../../../lib/money/api';
import { LotPaymentRows, newPayDraft, payRowsFrom, usePayAccounts, type PayDraft } from '../money/LotPayments';
import { LOT_CURRENCIES, type EntryUnit, type LotCurrency, type LotSavePayload, type LotSourceType, type StockUnit, type StockUnitWord, type Supplier } from '../../../lib/inventory/types';
import { AdminPageHeader, EmptyState, SkeletonRows } from '../ui/AdminUi';
import { AdminIcon } from '../ui/AdminIcon';
import { COUNTRIES, OTHER_COUNTRY, matchCountry } from './countries';
import { LotReceipts } from './LotReceipts';
import { taka2 } from './invFormat';

interface ItemDraft {
  key: string;
  id?: string;
  productId: string;
  variantId: string | null;
  label: string;
  /** Packs or loose units, as typed. */
  qty: string;
  entryUnit: EntryUnit;
  packSize: number;
  stockUnit: StockUnitWord;
  /** Buy price per pack or per unit (as typed), in the lot's currency. */
  price: string;
  /** "MM/YYYY" as typed, or "". */
  expiry: string;
}

interface CostDraft {
  key: string;
  id?: string;
  amount: string;
  date: string;
  note: string;
}

let draftKey = 0;
const nextKey = () => `d${(draftKey += 1)}`;

/** "2027-03" → "03/2027". */
export function expiryToText(yyyyMm: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(yyyyMm);
  return m ? `${m[2]}/${m[1]}` : '';
}

/** "3/2027", "03-2027", "2027-03" → "2027-03"; "" → ""; anything else → null. */
export function expiryFromText(text: string): string | null {
  const t = text.trim();
  if (t === '') return '';
  let m = /^(\d{1,2})\s*[/\-.]\s*(\d{4})$/.exec(t);
  if (m) {
    const month = Number(m[1]);
    return month >= 1 && month <= 12 ? `${m[2]}-${String(month).padStart(2, '0')}` : null;
  }
  m = /^(\d{4})\s*[/\-.]\s*(\d{1,2})$/.exec(t);
  if (m) {
    const month = Number(m[2]);
    return month >= 1 && month <= 12 ? `${m[1]}-${String(month).padStart(2, '0')}` : null;
  }
  return null;
}

function draftFromUnit(unit: StockUnit, qty = '1', price = '', expiry = ''): ItemDraft {
  return {
    key: nextKey(),
    productId: unit.product_id,
    variantId: unit.variant_id,
    label: unitName(unit),
    qty,
    entryUnit: 'pack',
    packSize: unit.pack_size,
    stockUnit: unit.stock_unit,
    price,
    expiry,
  };
}

/**
 * New / edit lot (Batch 38; Batch 45: compact layout). Top card: Supplier |
 * Country, Date | Currency · rate. Each product is one block — name and ×,
 * then Qty · Buying price · Expiry (MM/YYYY). Rows can come from Excel
 * (nothing is saved until Save lot). Other costs, notes, packs, costs
 * pending, payments and receipts sit below, folded away. Save lot is the
 * only orange element. The same form edits every lot, the opening lot
 * (L-000) too — the fields that make no sense for it are hidden.
 */
export function LotForm({ lotId, onBack, onSaved }: { lotId: string | null; onBack: () => void; onSaved: (id: string) => void }) {
  const { showToast } = useToast();
  const { refetch: refetchProducts } = useProducts();
  const [units, setUnits] = useState<StockUnit[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [isOpening, setIsOpening] = useState(false);
  const [source, setSource] = useState<LotSourceType>('import');
  const [country, setCountry] = useState('Australia');
  const [isOtherCountry, setIsOtherCountry] = useState(false);
  const [isCountryOpen, setIsCountryOpen] = useState(false);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierNames, setSupplierNames] = useState<string[]>([]);
  const [supplier, setSupplier] = useState('');
  const [renameFrom, setRenameFrom] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState('');
  const [isRenaming, setIsRenaming] = useState(false);
  const [lotDate, setLotDate] = useState(dhakaToday());
  const [currency, setCurrency] = useState<LotCurrency>('BDT');
  const [rate, setRate] = useState('1');
  const [notes, setNotes] = useState('');
  const [costsPending, setCostsPending] = useState(false);
  const [items, setItems] = useState<ItemDraft[]>([]);
  const [costs, setCosts] = useState<CostDraft[]>([]);
  const [query, setQuery] = useState('');
  const [importProblems, setImportProblems] = useState<LotImportProblem[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const payAccounts = usePayAccounts();
  const [payDrafts, setPayDrafts] = useState<PayDraft[]>([]);
  const [payLoaded, setPayLoaded] = useState('[]');
  const loaded = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void (async () => {
      const [stock, supplierList, names] = await Promise.all([fetchStockUnits(), fetchSuppliers(), fetchSupplierNames()]);
      if (stock.kind !== 'ready') {
        setLoadError(stock.kind === 'error' ? stock.message : 'The inventory database step has not been run.');
        return;
      }
      setSuppliers(supplierList);
      setSupplierNames(names);
      const byKey = new Map(stock.data.map((u) => [`${u.product_id}:${u.variant_id ?? ''}`, u]));
      if (lotId) {
        const lot = await fetchLot(lotId);
        if (lot.kind !== 'ready' || !lot.data) {
          setLoadError(lot.kind === 'error' ? lot.message : 'Lot not found.');
          return;
        }
        const d = lot.data;
        setCode(d.code);
        setIsOpening(d.kind === 'opening');
        if (d.kind !== 'opening') {
          const pays = await fetchLotPayments(d.id);
          if (pays.kind === 'ready') {
            const drafts = pays.data.rows.map((r) => ({ ...newPayDraft(r.account_id, r.date), amount: String(r.amount) }));
            setPayDrafts(drafts);
            setPayLoaded(JSON.stringify(payRowsFrom(drafts).rows));
          }
        }
        setSource(d.source_type ?? 'import');
        setCountry(d.country);
        setIsOtherCountry(d.country.trim() !== '' && matchCountry(d.country) === null);
        setSupplier(d.supplier);
        setLotDate(d.lot_date);
        setCurrency(d.currency);
        setRate(String(d.exchange_rate));
        setNotes(d.notes);
        setCostsPending(d.costs_pending);
        setItems(
          d.lot_items.map((i) => {
            const unit = byKey.get(`${i.product_id}:${i.variant_id ?? ''}`);
            const packSize = Math.max(1, Number(i.pack_size) || 1);
            const entryUnit: EntryUnit = packSize > 1 && i.entry_unit === 'unit' ? 'unit' : 'pack';
            return {
              key: nextKey(),
              id: i.id,
              productId: i.product_id,
              variantId: i.variant_id,
              label: unit ? unitName(unit) : 'Unknown product',
              qty: String(entryUnit === 'pack' ? i.qty / packSize : i.qty),
              entryUnit,
              packSize,
              stockUnit: unit?.stock_unit ?? 'pcs',
              price: String(Number(i.unit_price_foreign)),
              expiry: i.expiry_date ? expiryToText(i.expiry_date.slice(0, 7)) : '',
            };
          })
        );
        setCosts(
          d.lot_costs
            .filter((c) => c.cost_type === 'other')
            .map((c) => ({ key: nextKey(), id: c.id, amount: String(c.amount_bdt), date: c.cost_date ?? '', note: c.note }))
        );
      }
      setUnits(stock.data);
    })();
  }, [lotId]);

  const results = useMemo(() => {
    const term = normalizeText(query.trim());
    if (!units || term === '') return [];
    return units.filter((u) => normalizeText(`${unitName(u)} ${u.sku}`).includes(term)).slice(0, 20);
  }, [query, units]);

  const effectiveRate = currency === 'BDT' ? '1' : rate;
  const preview = useMemo(
    () =>
      items.length === 0
        ? null
        : allocateLot(
            items.map((i) => ({
              qty: Number(i.qty),
              entryUnit: i.entryUnit,
              packSize: i.packSize,
              unitPriceForeign: i.price.replace(/,/g, '').trim() === '' ? '0' : i.price.replace(/,/g, '').trim(),
              label: i.label,
            })),
            costs.map((c) => ({ costType: 'other' as const, amountBdt: c.amount.trim() === '' ? '0' : c.amount.replace(/,/g, '') })),
            effectiveRate
          ),
    [items, costs, effectiveRate]
  );
  const totalUnits = useMemo(
    () => items.reduce((a, i) => a + (Number.isInteger(Number(i.qty)) && Number(i.qty) > 0 ? rowUnits(Number(i.qty), i.entryUnit, i.packSize) : 0), 0),
    [items]
  );

  const addItem = (unit: StockUnit) => {
    setItems((list) => [...list, draftFromUnit(unit)]);
    setQuery('');
  };
  const patchItem = (key: string, patch: Partial<ItemDraft>) =>
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  const patchCost = (key: string, patch: Partial<CostDraft>) =>
    setCosts((list) => list.map((c) => (c.key === key ? { ...c, ...patch } : c)));

  const handleTemplate = async () => {
    if (!units) return;
    try {
      saveBlob(await buildLotTemplate(units), `lot-template-${dhakaToday()}.xlsx`);
    } catch {
      showToast('Could not make the template.', 'error');
    }
  };

  const handleImport = async (file: File | undefined) => {
    if (!file || !units) return;
    setIsImporting(true);
    try {
      const sheet = await readLotFile(file);
      const answer = parseLotSheet(sheet, units);
      setItems((list) => [...list, ...answer.rows.map((r) => draftFromUnit(r.unit, String(r.qty), r.price, r.expiry ? expiryToText(r.expiry) : ''))]);
      setImportProblems(answer.problems);
      showToast(
        `${answer.rows.length} row${answer.rows.length === 1 ? '' : 's'} added from the file${answer.problems.length ? `, ${answer.problems.length} to check` : ''}. Nothing is saved until Save lot.`
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not read the file.', 'error');
    }
    setIsImporting(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const handleRename = async () => {
    if (!renameFrom) return;
    const next = renameTo.trim();
    if (!next) return;
    setIsRenaming(true);
    const answer = await renameSupplier(renameFrom, next);
    setIsRenaming(false);
    if (!answer.ok) {
      showToast(answer.error ?? 'Could not rename the supplier.', 'error');
      return;
    }
    showToast(`Renamed on ${answer.data ?? 0} lot${answer.data === 1 ? '' : 's'}`);
    setSupplier(next);
    setRenameFrom(null);
    const [list, names] = await Promise.all([fetchSuppliers(), fetchSupplierNames()]);
    setSuppliers(list);
    setSupplierNames(names);
  };

  const handleSave = async () => {
    setSaveError(null);
    if (items.length === 0) {
      setSaveError('Add at least one product to the lot.');
      return;
    }
    const badExpiry = items.find((i) => expiryFromText(i.expiry) === null);
    if (badExpiry) {
      setSaveError(`Expiry of ${badExpiry.label}: write the month as MM/YYYY, e.g. 03/2027.`);
      return;
    }
    const noPrice = items.find((i) => i.price.trim() === '');
    if (noPrice) {
      setSaveError(`Enter the buying price for ${noPrice.label}.`);
      return;
    }
    if (preview && !preview.ok) {
      setSaveError(preview.error);
      return;
    }
    const payments = payRowsFrom(payDrafts);
    if (!isOpening && payments.error) {
      setSaveError(payments.error);
      return;
    }
    setIsSaving(true);
    // A typed supplier name joins the supplier list (Money uses it for
    // "Pay what I owe"); an existing name is reused.
    let supplierId: string | null = null;
    const supplierName = isOpening ? '' : supplier.trim();
    if (supplierName) {
      const known = suppliers.find((s) => s.name.trim().toLowerCase() === supplierName.toLowerCase());
      if (known) supplierId = known.id;
      else {
        const added = await saveSupplier(supplierName, country.trim());
        if (added.ok && added.data) supplierId = added.data;
      }
    }
    const payload: LotSavePayload = {
      ...(lotId ? { id: lotId } : {}),
      source_type: source,
      country: isOpening ? '' : country.trim(),
      supplier: supplierName,
      supplier_id: supplierId,
      lot_date: lotDate,
      currency,
      exchange_rate: effectiveRate,
      costs_pending: costsPending,
      notes,
      items: items.map((i) => {
        const month = expiryFromText(i.expiry);
        return {
          ...(i.id ? { id: i.id } : {}),
          product_id: i.productId,
          variant_id: i.variantId,
          qty: Number(i.qty),
          entry_unit: i.entryUnit,
          unit_price_foreign: i.price.replace(/,/g, '').trim(),
          expiry_date: month ? `${month}-01` : null,
        };
      }),
      costs: costs
        .filter((c) => c.amount.trim() !== '')
        .map((c) => ({
          ...(c.id ? { id: c.id } : {}),
          cost_type: 'other' as const,
          amount_bdt: c.amount.replace(/,/g, '').trim(),
          cost_date: c.date || null,
          note: c.note.trim(),
        })),
    };
    const answer = await saveLot(payload);
    if (!answer.ok || !answer.data) {
      setIsSaving(false);
      setSaveError(answer.error ?? 'Could not save the lot.');
      return;
    }
    if (!isOpening && JSON.stringify(payments.rows) !== payLoaded) {
      const paid = await saveLotPayments(answer.data, payments.rows);
      if (!paid.ok) showToast(`The lot was saved, but not its payments: ${paid.error ?? 'try again on the lot page'}`, 'error');
    }
    // Stock follows the lots: the admin screens get the new numbers.
    await refetchProducts();
    setIsSaving(false);
    showToast(lotId ? 'Lot saved' : 'Lot created');
    onSaved(answer.data);
  };

  const title = lotId ? `Edit lot ${code ?? ''}`.trim() : 'New lot';

  if (loadError) {
    return (
      <section className="inv" aria-label={title}>
        <AdminPageHeader title={title} onBack={onBack} />
        <EmptyState icon="alert" title="Can’t open this lot" hint={loadError} />
      </section>
    );
  }
  if (!units) {
    return (
      <section className="inv" aria-label={title}>
        <AdminPageHeader title={title} onBack={onBack} />
        <SkeletonRows rows={5} thumb={false} />
      </section>
    );
  }

  const money = currency === 'BDT' ? '৳' : currency;
  const chosenCountry = matchCountry(country);
  const landedPaisa = preview && preview.ok ? Number(preview.buyTotalPaisa + preview.allocatedOtherPaisa) : null;
  const hasOtherCosts = costs.some((c) => Number(c.amount) > 0);

  return (
    <section className="inv inv-lotform" aria-label={title}>
      <AdminPageHeader title={title} onBack={onBack} />

      <div className="adm-ocard inv-top" data-testid="inv-lot-top">
        {isOpening ? (
          <p className="inv-muted inv-top__wide">Opening stock: what you had on {lotDate}. Edit quantities, buying prices and expiry like any lot.</p>
        ) : (
          <>
            <div className="inv-cf">
              <span className="inv-cf__label" id="inv-supplier-label">
                Supplier
              </span>
              <span className="inv-cf__with-btn">
                <input
                  className="inv-cf__input"
                  value={supplier}
                  onChange={(e) => setSupplier(e.target.value)}
                  list="inv-supplier-names"
                  aria-labelledby="inv-supplier-label"
                  placeholder="Type or pick"
                  autoComplete="off"
                  data-testid="inv-supplier"
                />
                {supplierNames.some((n) => n.toLowerCase() === supplier.trim().toLowerCase()) && (
                  <button
                    type="button"
                    className="inv-cf__icon"
                    aria-label={`Rename supplier ${supplier.trim()}`}
                    onClick={() => {
                      setRenameFrom(supplier.trim());
                      setRenameTo(supplier.trim());
                    }}
                    data-testid="inv-supplier-rename"
                  >
                    <AdminIcon name="edit" className="adm-icon--sm" />
                  </button>
                )}
              </span>
              <datalist id="inv-supplier-names">
                {supplierNames.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </div>
            <div className="inv-cf">
              <span className="inv-cf__label" id="inv-country-label">
                Country
              </span>
              {isOtherCountry ? (
                <span className="inv-cf__with-btn">
                  <input
                    className="inv-cf__input"
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                    aria-labelledby="inv-country-label"
                    placeholder="Country name"
                    data-testid="inv-country-other"
                  />
                  <button
                    type="button"
                    className="inv-cf__icon"
                    aria-label="Pick a country from the list"
                    onClick={() => {
                      setIsOtherCountry(false);
                      setIsCountryOpen(true);
                    }}
                  >
                    <AdminIcon name="chevron-down" className="adm-icon--sm" />
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="inv-cf__input inv-cf__select"
                  aria-haspopup="listbox"
                  aria-expanded={isCountryOpen}
                  aria-labelledby="inv-country-label"
                  onClick={() => setIsCountryOpen((v) => !v)}
                  data-testid="inv-country"
                >
                  {chosenCountry ? (
                    <span className="inv-country">
                      {chosenCountry.flag}
                      {chosenCountry.name}
                    </span>
                  ) : (
                    <span className="inv-muted">{country || 'Pick'}</span>
                  )}
                  <AdminIcon name="chevron-down" className="adm-icon--sm" />
                </button>
              )}
            </div>
            {isCountryOpen && (
              <ul className="inv-country-list inv-top__wide" role="listbox" aria-label="Country" data-testid="inv-country-list">
                {COUNTRIES.map((c) => (
                  <li key={c.name} role="option" aria-selected={chosenCountry?.name === c.name}>
                    <button
                      type="button"
                      onClick={() => {
                        setCountry(c.name);
                        setIsCountryOpen(false);
                      }}
                    >
                      <span className="inv-country">
                        {c.flag}
                        {c.name}
                      </span>
                    </button>
                  </li>
                ))}
                <li role="option" aria-selected={false}>
                  <button
                    type="button"
                    onClick={() => {
                      setIsOtherCountry(true);
                      setIsCountryOpen(false);
                      if (matchCountry(country)) setCountry('');
                    }}
                  >
                    {OTHER_COUNTRY} (type a name)
                  </button>
                </li>
              </ul>
            )}
            {renameFrom !== null && (
              <div className="inv-rename inv-top__wide" data-testid="inv-rename-box">
                <span className="inv-muted">Rename “{renameFrom}” on every lot to</span>
                <span className="inv-cf__with-btn">
                  <input className="inv-cf__input" value={renameTo} onChange={(e) => setRenameTo(e.target.value)} aria-label="New supplier name" />
                  <button type="button" className="adm-btn adm-btn--sm" onClick={() => void handleRename()} disabled={isRenaming || renameTo.trim() === ''} data-testid="inv-rename-save">
                    {isRenaming ? <span className="spinner" aria-hidden="true" /> : 'Rename'}
                  </button>
                  <button type="button" className="adm-btn adm-btn--sm adm-btn--ghost" onClick={() => setRenameFrom(null)}>
                    Cancel
                  </button>
                </span>
              </div>
            )}
          </>
        )}
        <label className="inv-cf">
          <span className="inv-cf__label">Date</span>
          <input className="inv-cf__input" type="date" value={lotDate} onChange={(e) => setLotDate(e.target.value)} aria-label="Lot date" />
        </label>
        {!isOpening && (
          <div className="inv-cf">
            <span className="inv-cf__label">Currency · rate</span>
            <span className="inv-cf__pair">
              <select className="inv-cf__input" value={currency} onChange={(e) => setCurrency(e.target.value as LotCurrency)} aria-label="Currency">
                {LOT_CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <input
                className="inv-cf__input"
                inputMode="decimal"
                value={currency === 'BDT' ? '1' : rate}
                onChange={(e) => setRate(e.target.value)}
                disabled={currency === 'BDT'}
                aria-label={`Taka for 1 ${currency}`}
              />
            </span>
          </div>
        )}
      </div>

      <div className="adm-ocard inv-prod" data-testid="inv-products">
        <div className="inv-prod__head">
          <h2 className="inv-prod__title">Products ({items.length})</h2>
          <span className="inv-muted">Qty · Buying price · Expiry</span>
        </div>
        {items.map((item) => {
          const inUnits = item.packSize > 1 && item.entryUnit === 'unit';
          const per = inUnits ? item.stockUnit : item.packSize > 1 ? 'pack' : 'pc';
          const badExpiry = expiryFromText(item.expiry) === null;
          const index = items.indexOf(item);
          const row = hasOtherCosts && preview?.ok ? preview.rows[index] : null;
          return (
            <div key={item.key} className="inv-prow" data-testid="inv-item">
              <div className="inv-prow__name">
                <span>{item.label}</span>
                <button type="button" className="inv-prow__x" aria-label={`Remove ${item.label}`} onClick={() => setItems((l) => l.filter((x) => x.key !== item.key))}>
                  <AdminIcon name="close" className="adm-icon--sm" />
                </button>
              </div>
              <div className="inv-prow__fields">
                <input
                  className="inv-cf__input"
                  inputMode="numeric"
                  value={item.qty}
                  onChange={(e) => patchItem(item.key, { qty: e.target.value })}
                  aria-label={`Qty of ${item.label}`}
                  placeholder="Qty"
                />
                <input
                  className="inv-cf__input"
                  inputMode="decimal"
                  value={item.price}
                  onChange={(e) => patchItem(item.key, { price: e.target.value })}
                  aria-label={`Buying price per ${per} of ${item.label} (${money})`}
                  placeholder={`${money} / ${per}`}
                />
                <input
                  className={`inv-cf__input${badExpiry ? ' inv-cf__input--bad' : ''}`}
                  inputMode="numeric"
                  value={item.expiry}
                  onChange={(e) => patchItem(item.key, { expiry: e.target.value })}
                  aria-label={`Expiry of ${item.label} (MM/YYYY)`}
                  aria-invalid={badExpiry}
                  placeholder="MM/YYYY"
                />
              </div>
              {(item.packSize > 1 || row) && (
                <p className="inv-prow__sub inv-muted">
                  {item.packSize > 1 && (
                    <select
                      className="inv-prow__unit"
                      value={item.entryUnit}
                      onChange={(e) => patchItem(item.key, { entryUnit: e.target.value as EntryUnit })}
                      aria-label={`Enter ${item.label} in`}
                      data-testid="inv-entry-unit"
                    >
                      <option value="pack">in packs of {item.packSize} {item.stockUnit}</option>
                      <option value="unit">in loose {item.stockUnit}</option>
                    </select>
                  )}
                  {row && (
                    <span data-testid="inv-item-calc">
                      {taka2(row.buyUnitBdt)} + other {taka2(row.otherUnitBdt)} = <b>{taka2(row.landedUnitBdt)}</b> per {item.packSize > 1 ? item.stockUnit : 'pc'}
                    </span>
                  )}
                </p>
              )}
            </div>
          );
        })}

        <div className="search-bar inv-prod__search">
          <AdminIcon name="search" className="search-bar__icon" />
          <input
            type="search"
            className="search-bar__input"
            placeholder="Search product to add…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            aria-label="Search product to add"
          />
        </div>
        {results.length > 0 && (
          <ul className="picker-sheet__list" data-testid="inv-picker">
            {results.map((u) => (
              <li key={`${u.product_id}:${u.variant_id ?? ''}`}>
                <button type="button" className="picker-sheet__row" onClick={() => addItem(u)}>
                  <span className="picker-sheet__row-label">
                    {unitName(u)}
                    <span className="picker-sheet__row-sub">
                      {u.sku}
                      {u.pack_size > 1 ? ` · pack of ${u.pack_size} ${u.stock_unit}` : ''}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <input ref={fileRef} type="file" accept=".xlsx,.csv,text/csv" hidden onChange={(e) => void handleImport(e.target.files?.[0])} data-testid="inv-import-input" />
        <button type="button" className="adm-btn adm-btn--ghost inv-prod__import" onClick={() => fileRef.current?.click()} disabled={isImporting} data-testid="inv-import">
          {isImporting ? <span className="spinner" aria-hidden="true" /> : <AdminIcon name="import" className="adm-icon--sm" />} Import from Excel
        </button>
        <p className="inv-muted inv-prod__help">
          <button type="button" className="inv-link" onClick={() => void handleTemplate()} data-testid="inv-template">
            Download the template
          </button>
          , fill Qty, Buying price and Expiry for what you bought, upload it (.xlsx or .csv).
        </p>
        {importProblems.length > 0 && (
          <div className="inv-issues inv-issues--bad" data-testid="inv-import-problems" role="alert">
            <p>
              <b>
                {importProblems.length} row{importProblems.length === 1 ? '' : 's'} not added
              </b>
            </p>
            <ul>
              {importProblems.map((p) => (
                <li key={`${p.row}-${p.name}`}>
                  Row {p.row} · {p.name}: {p.reason}
                </li>
              ))}
            </ul>
            <button type="button" className="inv-link" onClick={() => setImportProblems([])}>
              Hide
            </button>
          </div>
        )}
      </div>

      <div className="inv-total" data-testid="inv-lot-total">
        <span>Lot total · {totalUnits} pcs</span>
        <b>{preview === null ? '—' : preview.ok && landedPaisa !== null ? takaExact(landedPaisa) : '—'}</b>
      </div>
      {preview && !preview.ok && (
        <p className="inv-error" role="alert">
          {preview.error}
        </p>
      )}

      <details className="adm-ocard inv-more" data-testid="inv-more">
        <summary>
          More: {isOpening ? 'notes' : 'other costs, source, notes, payments'}
          {!isOpening && costs.length > 0 ? ` · ${costs.length} cost${costs.length === 1 ? '' : 's'}` : ''}
        </summary>
        <div className="inv-stack">
          {!isOpening && (
            <>
              <h3 className="inv-more__title">Other costs (shared by buy price)</h3>
              {costs.map((c) => (
                <div key={c.key} className="inv-prow__fields inv-cost" data-testid="inv-cost-other">
                  <input className="inv-cf__input" inputMode="decimal" value={c.amount} onChange={(e) => patchCost(c.key, { amount: e.target.value })} aria-label="Other cost amount" placeholder="৳ amount" />
                  <input className="inv-cf__input" type="date" value={c.date} onChange={(e) => patchCost(c.key, { date: e.target.value })} aria-label="Cost date" />
                  <span className="inv-cf__with-btn">
                    <input className="inv-cf__input" value={c.note} onChange={(e) => patchCost(c.key, { note: e.target.value })} placeholder="Customs…" aria-label="Cost note" />
                    <button type="button" className="inv-cf__icon" aria-label="Remove cost" onClick={() => setCosts((l) => l.filter((x) => x.key !== c.key))}>
                      <AdminIcon name="close" className="adm-icon--sm" />
                    </button>
                  </span>
                </div>
              ))}
              <button
                type="button"
                className="adm-btn adm-btn--ghost adm-btn--sm"
                onClick={() => setCosts((l) => [...l, { key: nextKey(), amount: '', date: dhakaToday(), note: '' }])}
                data-testid="inv-add-other-cost"
              >
                <AdminIcon name="plus" className="adm-icon--sm" /> Add other cost
              </button>
              <label className="inv-cf">
                <span className="inv-cf__label">Source</span>
                <select className="inv-cf__input" value={source} onChange={(e) => setSource(e.target.value as LotSourceType)} aria-label="Source">
                  <option value="import">Import (brought from abroad)</option>
                  <option value="wholesale">Wholesale (bought here)</option>
                  <option value="local">Local</option>
                </select>
              </label>
              <label className="inv-check">
                <input type="checkbox" checked={costsPending} onChange={(e) => setCostsPending(e.target.checked)} />
                Costs pending (some bills have not arrived yet)
              </label>
            </>
          )}
          <label className="inv-cf">
            <span className="inv-cf__label">Notes</span>
            <textarea className="inv-cf__input inv-cf__area" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Notes" />
          </label>
          {!isOpening && (
            <div data-testid="inv-lot-paid">
              <h3 className="inv-more__title">Paid for this lot</h3>
              <LotPaymentRows drafts={payDrafts} accounts={payAccounts} onChange={setPayDrafts} landed={landedPaisa !== null ? landedPaisa / 100 : null} />
            </div>
          )}
          <h3 className="inv-more__title">Receipts</h3>
          {lotId ? <LotReceipts lotId={lotId} /> : <p className="inv-muted">Add receipts after the lot is saved (on the lot page).</p>}
        </div>
      </details>

      {saveError && (
        <p className="inv-error" role="alert" data-testid="inv-save-error">
          {saveError}
        </p>
      )}
      <div className="inv-actions">
        <button type="button" className="adm-btn adm-btn--primary adm-btn--lg" onClick={() => void handleSave()} disabled={isSaving} data-testid="inv-save-lot">
          {isSaving ? <span className="spinner" aria-hidden="true" /> : 'Save lot'}
        </button>
        <button type="button" className="adm-btn adm-btn--ghost adm-btn--lg" onClick={onBack}>
          Cancel
        </button>
      </div>
    </section>
  );
}
