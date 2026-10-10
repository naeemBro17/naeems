import { useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '../../../hooks/useToast';
import { normalizeText } from '../../../lib/format';
import { takaExact } from '../../../lib/payouts';
import { allocateLot, rowUnits } from '../../../lib/inventory/allocation';
import { dhakaToday, fetchLot, fetchStockUnits, fetchSuppliers, saveLot, saveSupplier, unitName } from '../../../lib/inventory/api';
import type { CostType, EntryUnit, LotCurrency, LotSavePayload, LotSourceType, StockUnit, StockUnitWord, Supplier } from '../../../lib/inventory/types';
import { AdminPageHeader, ChipRow, EmptyState, SkeletonRows } from '../ui/AdminUi';
import { AdminIcon } from '../ui/AdminIcon';
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
  /** Buy price per pack or per unit (as typed), in taka. */
  price: string;
  /** "YYYY-MM" or "". */
  expiry: string;
  /** Weight of one pack in grams. */
  weight: string;
  /** The product's saved weight (to know whether this one differs). */
  productWeight: number | null;
  saveWeight: boolean;
}

interface CostDraft {
  key: string;
  id?: string;
  costType: CostType;
  amount: string;
  date: string;
  note: string;
}

let draftKey = 0;
const nextKey = () => `d${(draftKey += 1)}`;

function weightDiffers(item: ItemDraft): boolean {
  const typed = item.weight.trim() === '' ? null : Number(item.weight);
  return typed !== null && Number.isFinite(typed) && typed !== item.productWeight;
}

const NEW_SUPPLIER = '__new__';

/**
 * New / edit lot (Batch 38; Batch 39: units, supplier list, no currency).
 * Details, products, bills, and a preview of the landed cost per unit
 * (worked out exactly like the database will) before Save. Every price is
 * typed in taka. A product kept in units (pack size above 1, e.g. a 400
 * pcs fish-oil bottle) can be entered in packs or in loose units. A
 * product with no weight no longer blocks saving: its weight is guessed
 * from its price. Fields stack on a phone — no sideways scrolling.
 */
export function LotForm({ lotId, onBack, onSaved }: { lotId: string | null; onBack: () => void; onSaved: (id: string) => void }) {
  const { showToast } = useToast();
  const [units, setUnits] = useState<StockUnit[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [source, setSource] = useState<LotSourceType>('import');
  const [country, setCountry] = useState('Australia');
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [legacySupplier, setLegacySupplier] = useState('');
  const [isNewSupplierOpen, setIsNewSupplierOpen] = useState(false);
  const [newSupplier, setNewSupplier] = useState('');
  const [newSupplierCountry, setNewSupplierCountry] = useState('');
  const [isAddingSupplier, setIsAddingSupplier] = useState(false);
  const [lotDate, setLotDate] = useState(dhakaToday());
  // Batch 39: prices are typed in taka. An older lot keeps its own currency
  // and rate (sent back unchanged).
  const [currency, setCurrency] = useState<LotCurrency>('BDT');
  const [rate, setRate] = useState('1');
  const [notes, setNotes] = useState('');
  const [costsPending, setCostsPending] = useState(false);
  const [items, setItems] = useState<ItemDraft[]>([]);
  const [costs, setCosts] = useState<CostDraft[]>([]);
  const [query, setQuery] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void (async () => {
      const [stock, supplierList] = await Promise.all([fetchStockUnits(), fetchSuppliers()]);
      if (stock.kind !== 'ready') {
        setLoadError(stock.kind === 'error' ? stock.message : 'The inventory database step has not been run.');
        return;
      }
      setSuppliers(supplierList);
      const byKey = new Map(stock.data.map((u) => [`${u.product_id}:${u.variant_id ?? ''}`, u]));
      if (lotId) {
        const lot = await fetchLot(lotId);
        if (lot.kind !== 'ready' || !lot.data) {
          setLoadError(lot.kind === 'error' ? lot.message : 'Lot not found.');
          return;
        }
        const d = lot.data;
        if (d.kind === 'opening') {
          setLoadError('The opening lot can’t be edited. Undo the opening stock and upload it again.');
          return;
        }
        setCode(d.code);
        setSource(d.source_type ?? 'import');
        setCountry(d.country);
        setSupplierId(d.supplier_id ?? '');
        setLegacySupplier(d.supplier_id ? '' : d.supplier);
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
              price: String(i.unit_price_foreign),
              expiry: i.expiry_date ? i.expiry_date.slice(0, 7) : '',
              weight: i.weight_grams_used === null ? '' : String(i.weight_grams_used),
              productWeight: unit?.weight_grams ?? null,
              saveWeight: false,
            };
          })
        );
        setCosts(
          d.lot_costs.map((c) => ({
            key: nextKey(),
            id: c.id,
            costType: c.cost_type,
            amount: String(c.amount_bdt),
            date: c.cost_date ?? '',
            note: c.note,
          }))
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
              unitPriceForeign: i.price,
              weightGrams: i.weight.trim() === '' ? null : i.weight,
              label: i.label,
            })),
            costs.map((c) => ({ costType: c.costType, amountBdt: c.amount.trim() === '' ? '0' : c.amount })),
            effectiveRate
          ),
    [items, costs, effectiveRate]
  );

  const addItem = (unit: StockUnit) => {
    setItems((list) => [
      ...list,
      {
        key: nextKey(),
        productId: unit.product_id,
        variantId: unit.variant_id,
        label: unitName(unit),
        qty: '1',
        entryUnit: 'pack',
        packSize: unit.pack_size,
        stockUnit: unit.stock_unit,
        price: '',
        expiry: '',
        weight: unit.weight_grams === null ? '' : String(unit.weight_grams),
        productWeight: unit.weight_grams,
        saveWeight: false,
      },
    ]);
    setQuery('');
  };

  const patchItem = (key: string, patch: Partial<ItemDraft>) =>
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  const patchCost = (key: string, patch: Partial<CostDraft>) =>
    setCosts((list) => list.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  const addCost = (costType: CostType) =>
    setCosts((list) => [...list, { key: nextKey(), costType, amount: '', date: dhakaToday(), note: '' }]);

  const handleAddSupplier = async () => {
    const name = newSupplier.trim();
    if (!name) return;
    setIsAddingSupplier(true);
    const answer = await saveSupplier(name, newSupplierCountry.trim() || country.trim());
    setIsAddingSupplier(false);
    if (!answer.ok || !answer.data) {
      showToast(answer.error ?? 'Could not add the supplier.', 'error');
      return;
    }
    setSuppliers(await fetchSuppliers());
    setSupplierId(answer.data);
    setLegacySupplier('');
    setIsNewSupplierOpen(false);
    setNewSupplier('');
    setNewSupplierCountry('');
  };

  const handleSave = async () => {
    setSaveError(null);
    if (items.length === 0) {
      setSaveError('Add at least one product to the lot.');
      return;
    }
    if (preview && !preview.ok) {
      setSaveError(preview.error);
      return;
    }
    const chosen = suppliers.find((s) => s.id === supplierId) ?? null;
    const payload: LotSavePayload = {
      ...(lotId ? { id: lotId } : {}),
      source_type: source,
      country: country.trim(),
      supplier: chosen ? chosen.name : legacySupplier.trim(),
      supplier_id: chosen ? chosen.id : null,
      lot_date: lotDate,
      currency,
      exchange_rate: effectiveRate,
      costs_pending: costsPending,
      notes,
      items: items.map((i) => ({
        ...(i.id ? { id: i.id } : {}),
        product_id: i.productId,
        variant_id: i.variantId,
        qty: Number(i.qty),
        entry_unit: i.entryUnit,
        unit_price_foreign: i.price.replace(/,/g, '').trim(),
        weight_grams: i.weight.trim() === '' ? null : i.weight.trim(),
        expiry_date: i.expiry ? `${i.expiry}-01` : null,
        save_weight_to_product: i.saveWeight && weightDiffers(i),
      })),
      costs: costs
        .filter((c) => c.amount.trim() !== '')
        .map((c) => ({
          ...(c.id ? { id: c.id } : {}),
          cost_type: c.costType,
          amount_bdt: c.amount.replace(/,/g, '').trim(),
          cost_date: c.date || null,
          note: c.note.trim(),
        })),
    };
    setIsSaving(true);
    const answer = await saveLot(payload);
    setIsSaving(false);
    if (!answer.ok || !answer.data) {
      setSaveError(answer.error ?? 'Could not save the lot.');
      return;
    }
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

  const weightCosts = costs.filter((c) => c.costType === 'weight');
  const otherCosts = costs.filter((c) => c.costType === 'other');
  const money = currency === 'BDT' ? '৳' : currency;
  const anyGuessed = preview?.ok === true && preview.rows.some((r) => r.weightGuessed);

  const costRows = (list: CostDraft[], type: CostType) => (
    <div className="inv-stack">
      {list.map((c) => (
        <div key={c.key} className="inv-item inv-cost" data-testid={`inv-cost-${type}`}>
          <div className="inv-fields">
            <label className="form-field">
              <span className="form-label">Amount (৳)</span>
              <input className="form-input" inputMode="decimal" value={c.amount} onChange={(e) => patchCost(c.key, { amount: e.target.value })} aria-label={`${type === 'weight' ? 'Weight' : 'Other'} cost amount`} />
            </label>
            <label className="form-field">
              <span className="form-label">Date</span>
              <input className="form-input" type="date" value={c.date} onChange={(e) => patchCost(c.key, { date: e.target.value })} />
            </label>
          </div>
          <label className="form-field">
            <span className="form-label">Note</span>
            <input className="form-input" value={c.note} onChange={(e) => patchCost(c.key, { note: e.target.value })} placeholder={type === 'weight' ? 'e.g. Luggage 23 kg' : 'e.g. Customs, courier'} />
          </label>
          <button type="button" className="adm-btn adm-btn--ghost adm-btn--sm adm-btn--danger-text inv-remove" onClick={() => setCosts((l) => l.filter((x) => x.key !== c.key))}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="adm-btn adm-btn--ghost" onClick={() => addCost(type)} data-testid={`inv-add-${type}-cost`}>
        <AdminIcon name="plus" className="adm-icon--sm" /> {type === 'weight' ? 'Add weight cost' : 'Add other cost'}
      </button>
    </div>
  );

  return (
    <section className="inv" aria-label={title}>
      <AdminPageHeader title={title} onBack={onBack} />

      <div className="adm-ocard inv-stack">
        <h2 className="adm-ocard__title">Details</h2>
        <div className="inv-fields">
          <label className="form-field">
            <span className="form-label">Source</span>
            <select className="form-input form-select" value={source} onChange={(e) => setSource(e.target.value as LotSourceType)} aria-label="Source">
              <option value="import">Import (I brought it from abroad)</option>
              <option value="wholesale">Wholesale (bought here)</option>
              <option value="local">Local</option>
            </select>
          </label>
          <label className="form-field">
            <span className="form-label">Date</span>
            <input className="form-input" type="date" value={lotDate} onChange={(e) => setLotDate(e.target.value)} aria-label="Lot date" />
          </label>
          <label className="form-field">
            <span className="form-label">Country</span>
            <input className="form-input" value={country} onChange={(e) => setCountry(e.target.value)} aria-label="Country" />
          </label>
          <label className="form-field">
            <span className="form-label">Supplier</span>
            <select
              className="form-input form-select"
              value={isNewSupplierOpen ? NEW_SUPPLIER : supplierId}
              onChange={(e) => {
                const value = e.target.value;
                setIsNewSupplierOpen(value === NEW_SUPPLIER);
                if (value !== NEW_SUPPLIER) setSupplierId(value);
              }}
              aria-label="Supplier"
              data-testid="inv-supplier"
            >
              <option value="">{legacySupplier ? `${legacySupplier} (typed before)` : 'No supplier'}</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.country ? ` · ${s.country}` : ''}
                </option>
              ))}
              <option value={NEW_SUPPLIER}>+ Add new</option>
            </select>
          </label>
        </div>
        {isNewSupplierOpen && (
          <div className="inv-item inv-stack" data-testid="inv-new-supplier">
            <div className="inv-fields">
              <label className="form-field">
                <span className="form-label">New supplier&apos;s name</span>
                <input className="form-input" value={newSupplier} onChange={(e) => setNewSupplier(e.target.value)} aria-label="New supplier name" />
              </label>
              <label className="form-field">
                <span className="form-label">Country</span>
                <input className="form-input" value={newSupplierCountry} onChange={(e) => setNewSupplierCountry(e.target.value)} placeholder={country} aria-label="New supplier country" />
              </label>
            </div>
            <div className="inv-actions">
              <button type="button" className="adm-btn" onClick={() => void handleAddSupplier()} disabled={isAddingSupplier || newSupplier.trim() === ''} data-testid="inv-add-supplier">
                {isAddingSupplier ? <span className="spinner" aria-hidden="true" /> : 'Add supplier'}
              </button>
              <button type="button" className="adm-btn adm-btn--ghost" onClick={() => setIsNewSupplierOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {currency !== 'BDT' && (
          <p className="inv-muted" data-testid="inv-old-currency">
            This older lot was priced in {currency} at ৳{rate} for 1 {currency}; its buy prices below stay in {currency}.
          </p>
        )}
        <label className="form-field">
          <span className="form-label">Notes</span>
          <textarea className="form-input form-textarea" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Notes" />
        </label>
        <div className="form-field form-field--toggle settings-switch-row">
          <span className="settings-switch-row__text">
            <span className="toggle-label" id="inv-costs-pending">
              Costs pending
            </span>
            <span className="admin-panel__description settings-switch-row__hint">Some bills have not arrived yet. Add them later; the cost per unit updates.</span>
          </span>
          <button
            type="button"
            className={`toggle${costsPending ? ' toggle--on' : ''}`}
            role="switch"
            aria-checked={costsPending}
            aria-labelledby="inv-costs-pending"
            onClick={() => setCostsPending((v) => !v)}
          >
            <span className="toggle__thumb" />
          </button>
        </div>
      </div>

      <div className="adm-ocard inv-stack">
        <h2 className="adm-ocard__title">Products ({items.length})</h2>
        <div className="search-bar">
          <AdminIcon name="search" className="search-bar__icon" />
          <input
            type="search"
            className="search-bar__input"
            placeholder="Search product name or SKU..."
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
                      {u.sku} · {u.weight_grams === null ? 'no weight' : `${u.weight_grams} g`}
                      {u.pack_size > 1 ? ` · pack of ${u.pack_size} ${u.stock_unit}` : ''}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {items.map((item, index) => {
          const row = preview?.ok ? preview.rows[index] : null;
          const inUnits = item.packSize > 1 && item.entryUnit === 'unit';
          const typed = Number(item.qty);
          const unitsTotal = Number.isInteger(typed) && typed > 0 ? rowUnits(typed, item.entryUnit, item.packSize) : null;
          return (
            <div key={item.key} className="inv-item" data-testid="inv-item">
              <div className="inv-item__head">
                <span className="inv-item__name">{item.label}</span>
                <button
                  type="button"
                  className="adm-icon-btn adm-icon-btn--plain"
                  aria-label={`Remove ${item.label}`}
                  onClick={() => setItems((l) => l.filter((x) => x.key !== item.key))}
                >
                  <AdminIcon name="close" />
                </button>
              </div>
              {item.packSize > 1 && (
                <div data-testid="inv-entry-unit">
                  <ChipRow
                    label={`Enter ${item.label} in`}
                    active={item.entryUnit}
                    onSelect={(id) => patchItem(item.key, { entryUnit: id as EntryUnit })}
                    chips={[
                      { id: 'pack', label: `Packs (${item.packSize} ${item.stockUnit})` },
                      { id: 'unit', label: `Units (${item.stockUnit})` },
                    ]}
                  />
                </div>
              )}
              <div className="inv-fields">
                <label className="form-field">
                  <span className="form-label">{inUnits ? `Units (${item.stockUnit})` : item.packSize > 1 ? 'Packs' : 'Pieces'}</span>
                  <input className="form-input" inputMode="numeric" value={item.qty} onChange={(e) => patchItem(item.key, { qty: e.target.value })} aria-label={`Pieces of ${item.label}`} />
                </label>
                <label className="form-field">
                  <span className="form-label">
                    Buy price per {inUnits ? item.stockUnit : item.packSize > 1 ? 'pack' : 'piece'} ({money})
                  </span>
                  <input className="form-input" inputMode="decimal" value={item.price} onChange={(e) => patchItem(item.key, { price: e.target.value })} aria-label={`Buy price of ${item.label}`} />
                </label>
                <label className="form-field">
                  <span className="form-label">Expiry (month)</span>
                  <input className="form-input" type="month" placeholder="2027-03" value={item.expiry} onChange={(e) => patchItem(item.key, { expiry: e.target.value })} aria-label={`Expiry of ${item.label}`} />
                </label>
                <label className="form-field">
                  <span className="form-label">Weight per {item.packSize > 1 ? 'pack' : 'piece'} (g)</span>
                  <input className="form-input" inputMode="decimal" value={item.weight} onChange={(e) => patchItem(item.key, { weight: e.target.value })} aria-label={`Weight of ${item.label}`} placeholder="Optional" />
                </label>
              </div>
              {item.packSize > 1 && unitsTotal !== null && (
                <p className="inv-muted" data-testid="inv-item-units">
                  = {unitsTotal} {item.stockUnit} in stock
                </p>
              )}
              {weightDiffers(item) && (
                <label className="inv-check">
                  <input type="checkbox" checked={item.saveWeight} onChange={(e) => patchItem(item.key, { saveWeight: e.target.checked })} />
                  Save this weight to the product
                </label>
              )}
              {row && (
                <p className="inv-muted inv-calc" data-testid="inv-item-calc">
                  Buy {taka2(row.buyUnitBdt)} + weight {taka2(row.weightUnitBdt)} + other {taka2(row.otherUnitBdt)} ={' '}
                  <b>{taka2(row.landedUnitBdt)}</b> per {item.packSize > 1 ? item.stockUnit : 'piece'}
                  {row.weightGuessed && (
                    <>
                      {' '}
                      <span className="inv-badge inv-badge--grey" data-testid="inv-weight-guessed">
                        weight guessed from price
                      </span>
                    </>
                  )}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="adm-ocard inv-stack">
        <h2 className="adm-ocard__title">Weight cost (shared by grams)</h2>
        <p className="inv-muted">Products without a weight share it by their buy price.</p>
        {costRows(weightCosts, 'weight')}
      </div>
      <div className="adm-ocard inv-stack">
        <h2 className="adm-ocard__title">Other costs (shared by buy price)</h2>
        {costRows(otherCosts, 'other')}
      </div>

      <div className="adm-ocard inv-stack" data-testid="inv-preview">
        <h2 className="adm-ocard__title">Preview</h2>
        {preview === null ? (
          <p className="inv-muted">Add products to see the cost per unit.</p>
        ) : !preview.ok ? (
          <p className="inv-error" role="alert">
            {preview.error}
          </p>
        ) : (
          <>
            <div className="inv-line">
              <span>Buy price (all units)</span>
              <span>{takaExact(Number(preview.buyTotalPaisa))}</span>
            </div>
            <div className="inv-line">
              <span>Weight cost shared</span>
              <span>
                {takaExact(Number(preview.allocatedWeightPaisa))} of {takaExact(Number(preview.weightTotalPaisa))}
              </span>
            </div>
            <div className="inv-line">
              <span>Other costs shared</span>
              <span>
                {takaExact(Number(preview.allocatedOtherPaisa))} of {takaExact(Number(preview.otherTotalPaisa))}
              </span>
            </div>
            <div className="inv-line inv-line--total">
              <span>Landed cost of the lot</span>
              <span>{takaExact(Number(preview.buyTotalPaisa + preview.allocatedWeightPaisa + preview.allocatedOtherPaisa))}</span>
            </div>
            {anyGuessed && (
              <p className="inv-muted" data-testid="inv-guessed-note">
                {preview.weightRule === 'value'
                  ? 'No product has a weight: the weight cost is shared by buy price.'
                  : 'Products without a weight got a weight guessed from their price.'}
              </p>
            )}
            {preview.allocatedWeightPaisa === preview.weightTotalPaisa && preview.allocatedOtherPaisa === preview.otherTotalPaisa ? (
              <p className="inv-ok" data-testid="inv-allocated-ok">
                Allocated total = lot total ✓
              </p>
            ) : (
              <p className="inv-error">Allocated total does not match the lot total.</p>
            )}
          </>
        )}
      </div>

      {saveError && (
        <p className="inv-error" role="alert" data-testid="inv-save-error">
          {saveError}
        </p>
      )}
      <div className="inv-actions">
        <button type="button" className="adm-btn adm-btn--primary adm-btn--lg" onClick={() => void handleSave()} disabled={isSaving} data-testid="inv-save-lot">
          {isSaving ? <span className="spinner" aria-hidden="true" /> : lotId ? 'Save lot' : 'Create lot'}
        </button>
        <button type="button" className="adm-btn adm-btn--ghost adm-btn--lg" onClick={onBack}>
          Cancel
        </button>
      </div>
    </section>
  );
}
