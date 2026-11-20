import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from '../../../../contexts/AuthContext';
import { useToast } from '../../../../hooks/useToast';
import { fetchCustomersV3 } from '../../../../lib/adminData';
import {
  currentEdit,
  itemsByKey,
  lineMatch,
  paidChip,
  qtyText,
  receiptCheck,
  receiptsUsing,
  receiptTitle,
  receiptTotals,
  suggestedUnitCost,
  typedNumber,
  type DraftLine,
  type ItemEdit,
  type MatchContext,
  type MatchTag,
  type MergeItemRow,
  type PaidDue,
} from '../../../../lib/kaarbar/merge';
import { useMergeDraft } from '../../../../lib/kaarbar/mergeStore';
import { choiceLabel, unitWord, type SavedItem, type SiteChoice } from '../../../../lib/kaarbar/oldSales';
import { fetchOldSalesStatus, saveItems, type OldSalesStatus } from '../../../../lib/kaarbar/oldSalesApi';
import { dayText, moneyText } from '../../../../lib/money/format';
import { fetchOldPurchases, type OldPurchase } from '../../../../lib/money/oldPurchases';
import { AdminFormPage } from '../../AdminFormPage';
import { SkeletonRows } from '../../ui/AdminUi';
import { AdminIcon } from '../../ui/AdminIcon';
import { ChoicePicker } from '../KaarbarProductsCard';
import { PasswordSheet } from '../KaarbarImportTab';
import { AddProductSheet, LineSheet, type LineValues } from './MergeSheets';
import '../../../../styles/kaarbarMerge.css';

/* ------------------------------------------------------- shared parts */

interface MatchBox {
  matched: boolean;
  label: string;
  tag: MatchTag | null;
}

interface UnitBox {
  unit: string;
  value: string;
  placeholder: string;
  note: string | null;
  onChange: (text: string) => void;
}

/** One line of a receipt: Kaarbar name and amount, the maths, and the
 *  site product it counts as (or "Not on the site"). */
function LineBlock({
  name,
  amount,
  maths,
  onTapNumbers,
  onRemove,
  match,
  onPick,
  onAddNew,
  unitBox,
}: {
  name: string;
  amount: number;
  maths: string;
  onTapNumbers?: () => void;
  onRemove?: () => void;
  match: MatchBox;
  onPick?: () => void;
  onAddNew?: () => void;
  unitBox?: UnitBox | null;
}) {
  return (
    <div className="km-line" data-testid="merge-line">
      <div className="km-row">
        <span className="km-line__name">{name}</span>
        <span className="km-row__end">
          {onTapNumbers ? (
            <button type="button" className="km-tap km-line__amount" onClick={onTapNumbers} aria-label={`Correct ${name}`}>
              {moneyText(amount)}
            </button>
          ) : (
            <b className="km-line__amount">{moneyText(amount)}</b>
          )}
          {onRemove && (
            <button type="button" className="km-x" onClick={onRemove} aria-label={`Remove ${name || 'this line'}`} data-testid="merge-line-remove">
              <AdminIcon name="close" className="adm-icon--sm" />
            </button>
          )}
        </span>
      </div>
      {onTapNumbers ? (
        <button type="button" className="km-tap km-line__maths" onClick={onTapNumbers} data-testid="merge-line-maths">
          {maths}
        </button>
      ) : (
        <span className="km-line__maths">{maths}</span>
      )}
      {match.matched ? (
        onPick ? (
          <button type="button" className="km-match" onClick={onPick} data-testid="merge-match">
            <span>{match.label}</span>
            {match.tag && <span className="km-chip km-chip--neutral">{match.tag}</span>}
          </button>
        ) : (
          <div className="km-match" data-testid="merge-match">
            <span>{match.label}</span>
            {match.tag && <span className="km-chip km-chip--neutral">{match.tag}</span>}
          </div>
        )
      ) : (
        <>
          <div className="km-match km-match--none" data-testid="merge-match-none">
            Not on the site
          </div>
          {onPick && onAddNew && (
            <div className="km-two">
              <button type="button" className="km-btn km-btn--mini" onClick={onPick} data-testid="merge-pick">
                Pick a product
              </button>
              <button type="button" className="km-btn km-btn--mini km-btn--dark" onClick={onAddNew} data-testid="merge-add-new">
                Add as new
              </button>
            </div>
          )}
        </>
      )}
      {unitBox && (
        <label className="form-field">
          <span className="form-label">Buying price of one {unitWord(unitBox.unit)}</span>
          <input
            className="form-input km-price-input"
            inputMode="decimal"
            placeholder={unitBox.placeholder}
            value={unitBox.value}
            onChange={(e) => unitBox.onChange(e.target.value)}
            data-testid="merge-unit-price"
          />
          {unitBox.note && <span className="km-note">{unitBox.note}</span>}
        </label>
      )}
    </div>
  );
}

function mathsText(l: { quantity: number; unit: string | null; rate: number; discount: number }): string {
  return `${qtyText(l.quantity, l.unit)} × ${moneyText(l.rate)}${l.discount > 0 ? ` · discount ${moneyText(l.discount)}` : ''}`;
}

function PaidHeader({ paid }: { paid: PaidDue | null }) {
  if (!paid) return null;
  const chip = paidChip(paid);
  return (
    <span className={`km-chip km-chip--${chip.tone}`} data-testid="merge-receipt-paid">
      {chip.text}
    </span>
  );
}

function Totals({ itemsPlusDelivery, billDiscount, total, kaarbarTotal, check }: { itemsPlusDelivery: number; billDiscount: number; total: number; kaarbarTotal: number; check: { ok: boolean; text: string } }) {
  return (
    <>
      <div className="km-card km-card--tight" data-testid="merge-totals">
        <div className="km-total">
          <span>Items + delivery</span>
          <span>{moneyText(itemsPlusDelivery)}</span>
        </div>
        <div className="km-total">
          <span>Bill discount</span>
          <span>−{moneyText(billDiscount)}</span>
        </div>
        <div className="km-total km-total--big">
          <span>Total</span>
          <span>{moneyText(total)}</span>
        </div>
        <div className="km-total km-total--muted">
          <span>Kaarbar&apos;s total</span>
          <span>{moneyText(kaarbarTotal)}</span>
        </div>
      </div>
      <p className={`km-check km-check--${check.ok ? 'ok' : 'bad'}`} role={check.ok ? undefined : 'alert'} data-testid="merge-check">
        {check.ok && <AdminIcon name="check" className="km-icon" />} {check.text}
      </p>
    </>
  );
}

function DoneBar({ onDone }: { onDone: () => void }) {
  return (
    <div className="km-bar">
      <button type="button" className="km-btn km-btn--dark" onClick={onDone} data-testid="merge-done">
        Done
      </button>
    </div>
  );
}

type AddSheetState = { key: string; name: string; mode: 'new' | 'price'; choice: SiteChoice | null } | null;

/* ------------------------------------------------- before the merge */

/**
 * Batch 54, mockup screen 3 (draft): /admin/customers/:key/merge/:bill —
 * every line with its match. A match is per Kaarbar item (it changes the
 * item in every old receipt). Numbers read from the PDF can be corrected;
 * a line the PDF lost can be added. Nothing is saved until Merge.
 */
export function MergeReceiptPage({ customerKey, bill, onBack }: { customerKey: string; bill: string; onBack: () => void }) {
  const [draft, update] = useMergeDraft(customerKey);
  const [status, setStatus] = useState<OldSalesStatus | null>(null);
  const [picker, setPicker] = useState<{ key: string; name: string } | null>(null);
  const [addSheet, setAddSheet] = useState<AddSheetState>(null);
  const [lineSheet, setLineSheet] = useState<{ mode: 'add' | 'correct-hand' | 'correct-pdf'; id: string | null; start: LineValues | null } | null>(null);
  const [typed, setTyped] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    void fetchOldSalesStatus().then((st) => {
      if (alive && st.ok) setStatus(st.data);
    });
    return () => {
      alive = false;
    };
  }, []);

  // The statement is only in this tab: a reload would lose it.
  useEffect(() => {
    if (!draft) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [draft]);

  const ctx: MatchContext | null = useMemo(
    () => (status && draft ? { items: itemsByKey(status.items), edits: draft.edits, choices: status.choices } : null),
    [status, draft]
  );
  const receipt = draft?.receipts.find((r) => r.key === bill) ?? null;

  const setEdit = useCallback((key: string, edit: ItemEdit) => update((d) => ({ ...d, edits: { ...d.edits, [key]: edit } })), [update]);
  const changeLines = useCallback(
    (change: (lines: DraftLine[]) => DraftLine[]) =>
      update((d) => ({ ...d, receipts: d.receipts.map((r) => (r.key === bill ? { ...r, lines: change(r.lines) } : r)) })),
    [update, bill]
  );

  if (!draft || !receipt) {
    return (
      <AdminFormPage title="Receipt" backLabel="Back to the receipts" onBack={onBack} testId="merge-receipt-page" guard={false}>
        <p className="adm-fpage__notice">The statement is not open any more. Go back to the customer and upload the PDF again.</p>
      </AdminFormPage>
    );
  }

  const totals = receiptTotals(receipt);
  const products = receipt.lines.filter((l) => !l.isDelivery);
  const paid = receipt.paid !== null && receipt.due !== null ? { paid: receipt.paid, due: receipt.due } : null;

  const choose = (c: SiteChoice | 'hidden') => {
    const p = picker;
    setPicker(null);
    if (!p || !ctx) return;
    if (c === 'hidden') {
      setAddSheet({ key: p.key, name: p.name, mode: 'new', choice: null });
      return;
    }
    const base = currentEdit(p.key, p.name, ctx);
    // A typed or saved buying price wins; else the picked product's (as Step 1).
    const cost = base.costPerPack ?? c.costPerPack;
    if (cost === null) {
      setAddSheet({ key: p.key, name: p.name, mode: 'price', choice: c });
      return;
    }
    setEdit(p.key, { ...base, how: 'hand', choice: c, productName: c.name, costPerPack: cost });
  };

  const addDone = (name: string, price: number) => {
    const s = addSheet;
    setAddSheet(null);
    if (!s || !ctx) return;
    const base = currentEdit(s.key, s.name, ctx);
    if (s.mode === 'new') setEdit(s.key, { ...base, how: 'hidden', choice: null, productName: name, costPerPack: price });
    else if (s.choice) setEdit(s.key, { ...base, how: 'hand', choice: s.choice, productName: s.choice.name, costPerPack: price });
  };

  const unitChange = (key: string, name: string, unit: string, text: string) => {
    if (!ctx) return;
    setTyped((t) => ({ ...t, [`${key}:${unit}`]: text }));
    const base = currentEdit(key, name, ctx);
    const n = typedNumber(text);
    const unitCosts = { ...base.unitCosts };
    if (n !== null && n > 0) unitCosts[unit] = n;
    else delete unitCosts[unit];
    setEdit(key, { ...base, unitCosts });
  };

  const lineDone = (values: LineValues) => {
    const s = lineSheet;
    setLineSheet(null);
    if (!s) return;
    if (s.mode === 'add') {
      const id = `${bill}+${draft.nextLine}`;
      update((d) => ({
        ...d,
        nextLine: d.nextLine + 1,
        receipts: d.receipts.map((r) => {
          if (r.key !== bill) return r;
          const at = r.lines.findIndex((l) => l.isDelivery);
          const line: DraftLine = { id, fromPdf: false, unit: null, isDelivery: false, ...values };
          const lines = at < 0 ? [...r.lines, line] : [...r.lines.slice(0, at), line, ...r.lines.slice(at)];
          return { ...r, lines };
        }),
      }));
      return;
    }
    changeLines((lines) => lines.map((l) => (l.id === s.id ? { ...l, ...values, name: l.fromPdf ? l.name : values.name } : l)));
  };

  const pickedKey = picker?.key ?? '';
  const pickedNow = picker && ctx ? currentEdit(pickedKey, picker.name, ctx) : null;
  const usedIn = picker && ctx ? receiptsUsing(pickedKey, draft.receipts, ctx.items.get(pickedKey) ?? null) : 0;

  return (
    <AdminFormPage
      title={receiptTitle(receipt.kind, receipt.billNo)}
      backLabel="Back to the receipts"
      onBack={onBack}
      testId="merge-receipt-page"
      guard={false}
      headerExtra={<PaidHeader paid={paid} />}
    >
      <div className="km-page">
        <p className="km-sub">{dayText(receipt.date)} · from Kaarbar</p>
        {!ctx ? (
          <SkeletonRows rows={4} thumb={false} />
        ) : (
          <div className="km-card km-lines">
            {products.map((l) => {
              const m = lineMatch(l, ctx);
              const typedKey = `${m.key}:${l.unit ?? ''}`;
              const showUnit = l.unit !== null && (m.needsUnit !== null || typed[typedKey] !== undefined);
              const suggestion = showUnit ? suggestedUnitCost(m, ctx, l.rate) : null;
              return (
                <LineBlock
                  key={l.id}
                  name={l.name}
                  amount={l.total}
                  maths={mathsText(l)}
                  onTapNumbers={() =>
                    setLineSheet({ mode: l.fromPdf ? 'correct-pdf' : 'correct-hand', id: l.id, start: { name: l.name, quantity: l.quantity, rate: l.rate, discount: l.discount, total: l.total } })
                  }
                  onRemove={l.fromPdf ? undefined : () => changeLines((lines) => lines.filter((x) => x.id !== l.id))}
                  match={m}
                  onPick={m.key === '' ? undefined : () => setPicker({ key: m.key, name: l.name })}
                  onAddNew={m.key === '' ? undefined : () => setAddSheet({ key: m.key, name: l.name, mode: 'new', choice: null })}
                  unitBox={
                    showUnit && l.unit
                      ? {
                          unit: l.unit,
                          value: typed[typedKey] ?? '',
                          placeholder: '৳',
                          note: suggestion !== null ? `Worked out from the pack size on the site: ${moneyText(suggestion)}.` : `Sold for ${moneyText(l.rate)} per ${unitWord(l.unit)}.`,
                          onChange: (text) => unitChange(m.key, l.name, l.unit ?? '', text),
                        }
                      : null
                  }
                />
              );
            })}
            {totals.delivery !== 0 && (
              <div className="km-line">
                <div className="km-row">
                  <span className="km-line__maths">Delivery charge</span>
                  <b className="km-line__amount">{moneyText(totals.delivery)}</b>
                </div>
              </div>
            )}
            <div className="km-line">
              <button type="button" className="km-link km-link--small" onClick={() => setLineSheet({ mode: 'add', id: null, start: null })} data-testid="merge-add-line">
                + Add a missing item
              </button>
            </div>
          </div>
        )}
        <Totals
          itemsPlusDelivery={totals.itemsPlusDelivery}
          billDiscount={totals.billDiscount}
          total={totals.total}
          kaarbarTotal={receipt.kaarbarTotal}
          check={receiptCheck(totals)}
        />
      </div>
      <DoneBar onDone={onBack} />

      {ctx && (
        <ChoicePicker
          draft={picker && pickedNow ? { name: picker.name, choice: pickedNow.choice } : null}
          choices={ctx.choices}
          note={usedIn > 1 ? `Changes this item in every old receipt (${usedIn}).` : null}
          onClose={() => setPicker(null)}
          onChoose={choose}
        />
      )}
      <AddProductSheet
        isOpen={addSheet !== null}
        mode={addSheet?.mode ?? 'new'}
        initialName={addSheet?.name ?? ''}
        productLabel={addSheet?.choice ? choiceLabel(addSheet.choice) : undefined}
        onClose={() => setAddSheet(null)}
        onDone={addDone}
      />
      <LineSheet isOpen={lineSheet !== null} mode={lineSheet?.mode ?? 'add'} start={lineSheet?.start ?? null} onClose={() => setLineSheet(null)} onDone={lineDone} />
    </AdminFormPage>
  );
}

/* --------------------------------------------------- after the merge */

const HOW_TAG: Record<'auto' | 'hand' | 'hidden', MatchTag> = { auto: 'Auto', hand: 'By hand', hidden: 'Hidden' };

/**
 * Batch 54, mockup screen 3 (saved): /admin/customers/:key/old/:id — a
 * merged receipt. Numbers are read-only; the Super Admin can change an
 * item's match (and so the old profit), saved at once with the password.
 */
export function OldReceiptPage({ customerKey, billId, onBack }: { customerKey: string; billId: string; onBack: () => void }) {
  const { isAdmin } = useAuth();
  const { showToast } = useToast();
  const [bill, setBill] = useState<OldPurchase | null | 'missing'>(null);
  const [status, setStatus] = useState<OldSalesStatus | null>(null);
  const [picker, setPicker] = useState<SavedItem | null>(null);
  const [addSheet, setAddSheet] = useState<AddSheetState>(null);
  const [pending, setPending] = useState<{ row: MergeItemRow; uses: number } | null>(null);

  const load = useCallback(async () => {
    const customers = await fetchCustomersV3();
    const c = customers.rows.find((r) => r.key === customerKey) ?? null;
    const bills = await fetchOldPurchases(customerKey, c?.phone ?? '');
    setBill(bills.find((b) => b.id === billId) ?? 'missing');
    if (isAdmin) {
      const st = await fetchOldSalesStatus();
      if (st.ok) setStatus(st.data);
    }
  }, [customerKey, billId, isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  const items = useMemo(() => new Map((status?.items ?? []).map((i) => [i.id, i])), [status]);

  if (bill === null || bill === 'missing') {
    return (
      <AdminFormPage title="Receipt" backLabel="Back to the customer" onBack={onBack} testId="old-receipt-page" guard={false}>
        {bill === null ? <SkeletonRows rows={4} thumb={false} /> : <p className="adm-fpage__notice">This receipt was not found.</p>}
      </AdminFormPage>
    );
  }

  const paid = bill.kind === 'sale' && bill.paid_amount !== null && bill.due_amount !== null ? { paid: bill.paid_amount, due: bill.due_amount } : null;
  const itemsPlusDelivery = Math.round((bill.items_total + bill.delivery) * 100) / 100;
  const total = Math.round((itemsPlusDelivery - bill.bill_discount) * 100) / 100;
  const addsUp = Math.abs(total - bill.bill_total) <= 1;

  const matchOf = (l: OldPurchase['lines'][number]): MatchBox => {
    const saved = l.item_id ? (items.get(l.item_id) ?? null) : null;
    if (saved && status) {
      const choice = status.choices.find((c) => c.productId === saved.productId && c.variantId === saved.variantId) ?? null;
      return { matched: true, label: choice ? choiceLabel(choice) : (l.product_name ?? saved.name), tag: HOW_TAG[saved.how] };
    }
    const label = l.product_name ? (l.option ? `${l.product_name} — ${l.option}` : l.product_name) : l.name;
    return { matched: true, label, tag: l.match_how ? HOW_TAG[l.match_how] : null };
  };

  const ask = (row: MergeItemRow, saved: SavedItem) => setPending({ row, uses: saved.billLines });

  const choose = (c: SiteChoice | 'hidden') => {
    const s = picker;
    setPicker(null);
    if (!s) return;
    if (c === 'hidden') {
      setAddSheet({ key: s.key, name: s.name, mode: 'new', choice: null });
      return;
    }
    ask(
      { name_key: s.key, kaarbar_name: s.name, kaarbar_price: s.kaarbarPrice, choice: 'hand', product_id: c.productId, variant_id: c.variantId, cost_per_pack: s.costPerPack, unit_costs: {}, product_name: null },
      s
    );
  };

  const addDone = (name: string, price: number) => {
    const sheet = addSheet;
    setAddSheet(null);
    const saved = sheet ? (status?.items.find((i) => i.key === sheet.key) ?? null) : null;
    if (!sheet || !saved) return;
    ask(
      { name_key: saved.key, kaarbar_name: saved.name, kaarbar_price: saved.kaarbarPrice, choice: 'hidden', product_id: null, variant_id: null, cost_per_pack: price, unit_costs: {}, product_name: name },
      saved
    );
  };

  const save = async (): Promise<string | null> => {
    if (!pending) return null;
    const answer = await saveItems([pending.row]);
    if (!answer.ok) return answer.error;
    setPending(null);
    showToast('Match saved');
    await load();
    return null;
  };

  const lines: ReactNode[] = bill.lines.map((l, i) => {
    const saved = l.item_id ? (items.get(l.item_id) ?? null) : null;
    return (
      <LineBlock
        key={`${l.item_id ?? ''}-${i}`}
        name={l.name}
        amount={l.line_total}
        maths={mathsText({ quantity: l.quantity, unit: l.unit, rate: l.rate, discount: l.line_discount })}
        match={matchOf(l)}
        onPick={isAdmin && saved ? () => setPicker(saved) : undefined}
      />
    );
  });

  const pickerChoice = picker && status ? (status.choices.find((c) => c.productId === picker.productId && c.variantId === picker.variantId) ?? null) : null;

  return (
    <AdminFormPage
      title={receiptTitle(bill.kind, bill.bill_no)}
      backLabel="Back to the customer"
      onBack={onBack}
      testId="old-receipt-page"
      guard={false}
      headerExtra={<PaidHeader paid={paid} />}
    >
      <div className="km-page">
        <p className="km-sub">{dayText(bill.date)} · from Kaarbar</p>
        <div className="km-card km-lines">
          {lines}
          {bill.delivery !== 0 && (
            <div className="km-line">
              <div className="km-row">
                <span className="km-line__maths">Delivery charge</span>
                <b className="km-line__amount">{moneyText(bill.delivery)}</b>
              </div>
            </div>
          )}
        </div>
        <Totals
          itemsPlusDelivery={itemsPlusDelivery}
          billDiscount={bill.bill_discount}
          total={total}
          kaarbarTotal={bill.bill_total}
          check={addsUp ? { ok: true, text: "Adds up to Kaarbar's total" } : { ok: false, text: `Doesn't add up: ${moneyText(Math.abs(bill.bill_total - total))} ${total < bill.bill_total ? 'less' : 'more'} than Kaarbar's total.` }}
        />
      </div>
      <DoneBar onDone={onBack} />

      {status && (
        <ChoicePicker
          draft={picker ? { name: picker.name, choice: picker.how === 'hidden' ? null : pickerChoice } : null}
          choices={status.choices}
          note={picker && picker.billLines > 1 ? `Changes this item in every old receipt (${picker.billLines}).` : null}
          onClose={() => setPicker(null)}
          onChoose={choose}
        />
      )}
      <AddProductSheet
        isOpen={addSheet !== null}
        mode="new"
        initialName={addSheet?.name ?? ''}
        onClose={() => setAddSheet(null)}
        onDone={addDone}
      />
      <PasswordSheet
        isOpen={pending !== null}
        title="Change this match?"
        text={`${pending && pending.uses > 1 ? `Changes this item in every old receipt (${pending.uses}). ` : ''}The old profit follows the new product and buying price.`}
        confirmLabel="Save"
        onConfirm={save}
        onClose={() => setPending(null)}
      />
    </AdminFormPage>
  );
}

