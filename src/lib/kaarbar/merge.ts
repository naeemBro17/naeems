import { moneyText } from '../money/format';
import { cleanPhone } from './parse';
import {
  billKey,
  billProblems,
  billProblemText,
  choiceLabel,
  derivedUnitCost,
  itemKey,
  type BillProblem,
  type SavedItem,
  type SiteChoice,
  type Statement,
} from './oldSales';

/**
 * Batch 54: "Merge old data" on a customer's page — one Kaarbar party
 * statement, read in the browser, shown as Kaarbar shows it (receipt cards
 * with Paid / Unpaid / Balance), fixed where needed, then merged. Pure
 * functions: the screens and the unit tests use the same code. Old bills
 * stay history only: nothing here touches stock, money or dues.
 */

/** kaarbar_old_sales_cutoff() (migration-051): bills after it are site orders.
 *  Shown before the database is asked; the database's own date is used to merge. */
export const OLD_SALES_CUTOFF = '2026-09-30';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ------------------------------------------------------- paid / due */

export interface PaidDue {
  paid: number;
  due: number;
}

/**
 * Paid and due per bill, the way the Kaarbar app shows them: oldest first,
 * each sale starts with its own Rec/Paid amount; then every Payment In (and
 * every Sales Return) goes to the oldest sale that still has something
 * unpaid. Bills after the cut-off count too (an October payment can pay a
 * September bill). Keyed by billKey; a return is always fully settled.
 */
export function allocatePaid(s: Pick<Statement, 'bills' | 'payments'>): Map<string, PaidDue> {
  const order = s.bills.map((b, i) => ({ b, i })).sort((x, y) => x.b.date.localeCompare(y.b.date) || x.i - y.i);
  const sales = order
    .filter((x) => x.b.kind === 'sale')
    .map(({ b }) => {
      const paid = Math.min(b.total, Math.max(0, b.paid ?? 0));
      return { key: billKey(b), paid, due: round2(b.total - paid) };
    });
  const credits = [
    ...s.payments.map((p, i) => ({ date: p.date, amount: p.amount, i })),
    ...order
      .filter((x) => x.b.kind === 'return')
      .map(({ b, i }) => ({ date: b.date, amount: Math.max(0, b.total - Math.max(0, b.paid ?? 0)), i: s.payments.length + i })),
  ].sort((x, y) => x.date.localeCompare(y.date) || x.i - y.i);
  for (const c of credits) {
    let left = c.amount;
    for (const sale of sales) {
      if (left <= 0.005) break;
      if (sale.due <= 0.005) continue;
      const take = Math.min(sale.due, left);
      sale.due = round2(sale.due - take);
      sale.paid = round2(sale.paid + take);
      left = round2(left - take);
    }
  }
  const out = new Map<string, PaidDue>(sales.map((x) => [x.key, { paid: x.paid, due: x.due }]));
  for (const b of s.bills) if (b.kind === 'return') out.set(billKey(b), { paid: b.total, due: 0 });
  return out;
}

export type PaidTone = 'paid' | 'unpaid' | 'part';

export function paidChip(p: PaidDue): { tone: PaidTone; text: string } {
  if (p.due < 1) return { tone: 'paid', text: 'Paid' };
  if (p.paid < 1) return { tone: 'unpaid', text: 'Unpaid' };
  return { tone: 'part', text: 'Part paid' };
}

/** One grey line when Kaarbar's own receipts don't add up to its due. */
export function receivablesNote(s: Pick<Statement, 'bills' | 'totalReceivables'>, paid: ReadonlyMap<string, PaidDue>): string | null {
  if (s.totalReceivables === null) return null;
  const sum = round2(s.bills.filter((b) => b.kind === 'sale').reduce((t, b) => t + (paid.get(billKey(b))?.due ?? 0), 0));
  if (Math.abs(sum - s.totalReceivables) < 1) return null;
  return `Kaarbar's receipts add up to ${moneyText(sum)}; its due says ${moneyText(s.totalReceivables)}.`;
}

/* ------------------------------------------------------------ due box */

export interface DueBox {
  tone: 'ok' | 'bad' | 'warn';
  text: string;
  /** "Same": shown with a check icon. */
  same: boolean;
  /** Both have a due and they differ: the grey "Fix the receipts …" line shows. */
  differs: boolean;
}

/** Kaarbar's due on the statement day next to the site's Total due today. */
export function dueBox(kaarbar: number, site: number): DueBox {
  if (Math.abs(kaarbar - site) < 1) return { tone: 'ok', text: 'Same', same: true, differs: false };
  if (kaarbar >= 1 && site < 1) return { tone: 'warn', text: 'Site has ৳0', same: false, differs: false };
  if (site >= 1 && kaarbar < 1) return { tone: 'warn', text: 'Kaarbar has ৳0', same: false, differs: false };
  return { tone: 'bad', text: `${moneyText(Math.abs(round2(kaarbar - site)))} apart`, same: false, differs: true };
}

/** "Use this": the previous balance that makes the Total due equal to
 *  Kaarbar's due (null = it would be below 0, so the link is hidden). */
export function amountToMatchKaarbar(kaarbar: number, siteOrdersDue: number): number | null {
  const n = round2(kaarbar - siteOrdersDue);
  return n >= 0 ? n : null;
}

/* ------------------------------------------------------ wrong customer */

function nameKey(name: string): string {
  return itemKey(name);
}

/**
 * The notice when the PDF looks like another party's statement (null =
 * fine). Batch 55: the PDF's number may be any of the customer's numbers
 * (main or extra); a PDF with no number is matched by the name.
 */
export function wrongCustomer(
  s: Pick<Statement, 'partyName' | 'phone' | 'phoneKey'>,
  customer: { name: string; phone: string; numbers?: readonly string[] }
): string | null {
  const own = [customer.phone ?? '', ...(customer.numbers ?? [])].map(cleanPhone).filter((k): k is string => k !== null);
  const sameName = nameKey(s.partyName) !== '' && nameKey(s.partyName) === nameKey(customer.name);
  const same = own.length > 0 && s.phoneKey ? own.includes(s.phoneKey) : sameName;
  if (same) return null;
  const who = s.partyName || 'another party';
  return `This statement is for ${who}${s.phone ? ` (${s.phone})` : ''}, not this customer.`;
}

/* ------------------------------------------------------------ drafts */

export interface DraftLine {
  id: string;
  /** Read from the PDF (only its numbers can be corrected), or added by hand. */
  fromPdf: boolean;
  name: string;
  quantity: number;
  unit: string | null;
  rate: number;
  discount: number;
  total: number;
  isDelivery: boolean;
}

export interface DraftReceipt {
  key: string;
  kind: 'sale' | 'return';
  billNo: string;
  date: string;
  kaarbarTotal: number;
  note: string;
  paid: number | null;
  due: number | null;
  lines: DraftLine[];
}

export interface MergeDraft {
  fileName: string;
  statement: Statement;
  /** Bills up to the cut-off, newest first. */
  receipts: DraftReceipt[];
  /** Bills after the cut-off (already site orders). */
  later: number;
  receivablesNote: string | null;
  /** Changes to Kaarbar items, by name key (a match is per item). */
  edits: Record<string, ItemEdit>;
  nextLine: number;
}

export function buildDraft(fileName: string, s: Statement, cutoff: string): MergeDraft {
  const paid = allocatePaid(s);
  const kept = s.bills.map((b, i) => ({ b, i })).filter(({ b }) => b.date !== '' && b.date <= cutoff);
  const receipts = kept
    .sort((x, y) => y.b.date.localeCompare(x.b.date) || y.i - x.i)
    .map(({ b }): DraftReceipt => {
      const pd = paid.get(billKey(b)) ?? null;
      return {
        key: billKey(b),
        kind: b.kind,
        billNo: b.billNo,
        date: b.date,
        kaarbarTotal: b.total,
        note: b.note,
        paid: b.kind === 'sale' && pd ? pd.paid : null,
        due: b.kind === 'sale' && pd ? pd.due : null,
        lines: b.lines.map((l, n) => ({
          id: `${billKey(b)}#${n}`,
          fromPdf: true,
          name: l.name,
          quantity: l.quantity,
          unit: l.unit,
          rate: l.rate,
          discount: l.discount,
          total: l.total,
          isDelivery: l.isDelivery,
        })),
      };
    });
  return {
    fileName,
    statement: s,
    receipts,
    later: s.bills.length - kept.length,
    receivablesNote: receivablesNote(s, paid),
    edits: {},
    nextLine: 1,
  };
}

export interface ReceiptTotals {
  items: number;
  delivery: number;
  itemsPlusDelivery: number;
  /** The whole-bill discount shown (never below 0). */
  billDiscount: number;
  total: number;
  problems: BillProblem[];
}

export function receiptTotals(r: DraftReceipt): ReceiptTotals {
  const items = round2(r.lines.filter((l) => !l.isDelivery).reduce((s, l) => s + l.total, 0));
  const delivery = round2(r.lines.filter((l) => l.isDelivery).reduce((s, l) => s + l.total, 0));
  const itemsPlusDelivery = round2(items + delivery);
  const billDiscount = Math.max(0, round2(itemsPlusDelivery - r.kaarbarTotal));
  return {
    items,
    delivery,
    itemsPlusDelivery,
    billDiscount,
    total: round2(itemsPlusDelivery - billDiscount),
    problems: billProblems({ total: r.kaarbarTotal, lines: r.lines }),
  };
}

/** The check box under the totals: green, or the first problem in red. */
export function receiptCheck(t: ReceiptTotals): { ok: boolean; text: string } {
  const p = t.problems[0];
  if (!p) return { ok: true, text: "Adds up to Kaarbar's total" };
  return { ok: false, text: billProblemText(p, false) };
}

/* -------------------------------------------------------- matching */

/** A change to one Kaarbar item made on these pages (saved at Merge). */
export interface ItemEdit {
  key: string;
  kaarbarName: string;
  how: 'auto' | 'hand' | 'hidden';
  /** The site product (null = a new hidden product). */
  choice: SiteChoice | null;
  /** Name of the new hidden product (Add as new). */
  productName: string;
  /** Buying price of one pack (null = not typed). */
  costPerPack: number | null;
  /** Buying price of one unit, typed for lines sold by a unit. */
  unitCosts: Record<string, number>;
}

export interface MatchContext {
  items: ReadonlyMap<string, SavedItem>;
  edits: Readonly<Record<string, ItemEdit>>;
  choices: readonly SiteChoice[];
}

export type MatchTag = 'Auto' | 'By hand' | 'Hidden';

/** The edit of an item as it is now: the draft change, else a copy of the
 *  saved item (so a typed unit price keeps its saved match). */
export function currentEdit(key: string, name: string, ctx: MatchContext): ItemEdit {
  const edit = ctx.edits[key];
  if (edit) return edit;
  const saved = ctx.items.get(key) ?? null;
  if (!saved) return { key, kaarbarName: name.trim(), how: 'hidden', choice: null, productName: name.trim(), costPerPack: null, unitCosts: {} };
  return {
    key,
    kaarbarName: saved.name,
    how: saved.how,
    choice: saved.how === 'hidden' ? null : findChoice(ctx.choices, saved.productId, saved.variantId),
    productName: findChoice(ctx.choices, saved.productId, saved.variantId)?.name ?? saved.name,
    costPerPack: saved.costPerPack,
    unitCosts: {},
  };
}

export interface LineMatch {
  key: string;
  matched: boolean;
  label: string;
  tag: MatchTag | null;
  /** The unit whose buying price is not known (lines sold by a unit). */
  needsUnit: string | null;
  saved: SavedItem | null;
}

const TAG: Record<'auto' | 'hand' | 'hidden', MatchTag> = { auto: 'Auto', hand: 'By hand', hidden: 'Hidden' };

function findChoice(choices: readonly SiteChoice[], productId: string | null, variantId: string | null): SiteChoice | null {
  if (!productId) return null;
  return choices.find((c) => c.productId === productId && c.variantId === variantId) ?? null;
}

export function lineMatch(l: Pick<DraftLine, 'name' | 'unit' | 'isDelivery'>, ctx: MatchContext): LineMatch {
  const key = itemKey(l.name);
  const saved = key === '' ? null : (ctx.items.get(key) ?? null);
  const edit = key === '' ? null : (ctx.edits[key] ?? null);
  let matched = false;
  let label = '';
  let tag: MatchTag | null = null;
  if (edit) {
    matched = true;
    tag = TAG[edit.how];
    label = edit.how === 'hidden' ? edit.productName : edit.choice ? choiceLabel(edit.choice) : '';
  } else if (saved) {
    const choice = findChoice(ctx.choices, saved.productId, saved.variantId);
    if (saved.how === 'hidden' || choice) {
      matched = true;
      tag = TAG[saved.how];
      label = choice ? choiceLabel(choice) : saved.name;
    }
  }
  const costs = { ...(saved?.unitCosts ?? {}), ...(edit?.unitCosts ?? {}) };
  const needsUnit = matched && !l.isDelivery && l.unit !== null && costs[l.unit] === undefined ? l.unit : null;
  return { key, matched, label, tag, needsUnit, saved };
}

/** A suggested buying price of one unit (from the site pack), or null. */
export function suggestedUnitCost(m: LineMatch, ctx: MatchContext, maxRate: number): number | null {
  if (!m.needsUnit) return null;
  const edit = ctx.edits[m.key] ?? null;
  const choice = edit ? edit.choice : m.saved ? findChoice(ctx.choices, m.saved.productId, m.saved.variantId) : null;
  const cost = edit ? (edit.costPerPack ?? 0) : (m.saved?.costPerPack ?? 0);
  return derivedUnitCost(cost, choice, m.needsUnit, maxRate);
}

/** How many old receipts use an item: the ones on this page + saved lines. */
export function receiptsUsing(key: string, receipts: readonly DraftReceipt[], saved: SavedItem | null): number {
  return receipts.filter((r) => r.lines.some((l) => !l.isDelivery && itemKey(l.name) === key)).length + (saved?.billLines ?? 0);
}

/* ---------------------------------------------------- receipt status */

export type StatusTone = 'ok' | 'warn' | 'bad' | 'muted';

export interface ReceiptStatus {
  tone: StatusTone;
  text: string;
  /** Shown with a check icon ("Ready"). */
  ready: boolean;
  already: boolean;
  flag: boolean;
  needs: boolean;
}

export function receiptStatus(r: DraftReceipt, ctx: MatchContext, done: ReadonlySet<string>): ReceiptStatus {
  const base = { ready: false, already: false, flag: false, needs: false };
  if (done.has(r.key)) return { ...base, tone: 'muted', text: 'Already merged', already: true };
  const t = receiptTotals(r);
  if (t.problems.length > 0) return { ...base, tone: 'bad', text: billProblemText(t.problems[0], true), flag: true };
  const matches = r.lines.filter((l) => !l.isDelivery).map((l) => lineMatch(l, ctx));
  const missing = matches.filter((m) => !m.matched).length;
  if (missing > 0) return { ...base, tone: 'warn', text: `${missing} item${missing === 1 ? ' is' : 's are'} not on the site`, needs: true };
  const noPrice = matches.filter((m) => m.needsUnit !== null).length;
  if (noPrice > 0) return { ...base, tone: 'warn', text: `${noPrice} item${noPrice === 1 ? ' needs' : 's need'} a buying price`, needs: true };
  return { ...base, tone: 'ok', text: 'Ready', ready: true };
}

export interface ReviewCounts {
  receipts: number;
  ready: number;
  needs: number;
  bad: number;
  toMerge: number;
}

export function reviewCounts(statuses: readonly ReceiptStatus[]): ReviewCounts {
  return {
    receipts: statuses.length,
    ready: statuses.filter((s) => s.ready).length,
    needs: statuses.filter((s) => s.needs).length,
    bad: statuses.filter((s) => s.flag).length,
    toMerge: statuses.filter((s) => !s.already).length,
  };
}

export function chipTexts(c: ReviewCounts): { tone: 'neutral' | 'ok' | 'warn' | 'bad'; text: string }[] {
  const out: { tone: 'neutral' | 'ok' | 'warn' | 'bad'; text: string }[] = [{ tone: 'neutral', text: `${c.receipts} receipt${c.receipts === 1 ? '' : 's'}` }];
  if (c.ready > 0) out.push({ tone: 'ok', text: `${c.ready} ready` });
  if (c.needs > 0) out.push({ tone: 'warn', text: `${c.needs} ${c.needs === 1 ? 'needs' : 'need'} a product` });
  if (c.bad > 0) out.push({ tone: 'bad', text: `${c.bad} ${c.bad === 1 ? "doesn't" : "don't"} add up` });
  return out;
}

/* ------------------------------------------------------- merge rows */

export interface MergeItemRow {
  name_key: string;
  kaarbar_name: string;
  kaarbar_price: number;
  choice: 'auto' | 'hand' | 'hidden';
  product_id: string | null;
  variant_id: string | null;
  cost_per_pack: number;
  unit_costs: Record<string, number>;
  product_name: string | null;
}

export interface MergeBillRow {
  kind: 'sale' | 'return';
  bill_no: string;
  date: string;
  party_name: string;
  party_phone: string | null;
  items_total: number;
  bill_discount: number;
  delivery: number;
  bill_total: number;
  paid_amount: number | null;
  due_amount: number | null;
  note: string | null;
  lines: {
    name_key: string;
    kaarbar_name: string;
    quantity: number;
    unit: string | null;
    rate: number;
    line_discount: number;
    line_total: number;
  }[];
}

/** One item row to save: a change made here, or a saved item with a new
 *  unit price. Null when it can't be saved yet (no buying price). */
export function itemRow(key: string, ctx: MatchContext): MergeItemRow | null {
  const edit = ctx.edits[key] ?? null;
  const saved = ctx.items.get(key) ?? null;
  if (edit) {
    const cost = edit.costPerPack ?? (edit.how !== 'hidden' ? (edit.choice?.costPerPack ?? saved?.costPerPack ?? null) : null);
    if (cost === null || cost <= 0) return null;
    return {
      name_key: key,
      kaarbar_name: edit.kaarbarName,
      kaarbar_price: saved?.kaarbarPrice ?? 0,
      choice: edit.how,
      product_id: edit.how === 'hidden' ? null : (edit.choice?.productId ?? null),
      variant_id: edit.how === 'hidden' ? null : (edit.choice?.variantId ?? null),
      cost_per_pack: cost,
      unit_costs: edit.unitCosts,
      product_name: edit.how === 'hidden' ? edit.productName.trim() || null : null,
    };
  }
  return null;
}

/** What Merge sends: the item changes, then the bills (only the receipts
 *  not merged before). Null while anything still needs fixing. */
export function mergeRows(
  draft: Pick<MergeDraft, 'receipts' | 'edits' | 'statement'>,
  ctx: MatchContext,
  done: ReadonlySet<string>
): { items: MergeItemRow[]; bills: MergeBillRow[] } | null {
  const todo = draft.receipts.filter((r) => !done.has(r.key));
  if (todo.length === 0) return null;
  const keys = new Set<string>();
  const bills: MergeBillRow[] = [];
  for (const r of todo) {
    const st = receiptStatus(r, ctx, done);
    if (!st.ready) return null;
    const t = receiptTotals(r);
    const products = r.lines.filter((l) => !l.isDelivery);
    for (const l of products) keys.add(itemKey(l.name));
    bills.push({
      kind: r.kind,
      bill_no: r.billNo,
      date: r.date,
      party_name: draft.statement.partyName,
      party_phone: draft.statement.phone || null,
      items_total: t.items,
      bill_discount: round2(t.itemsPlusDelivery - r.kaarbarTotal),
      delivery: t.delivery,
      bill_total: r.kaarbarTotal,
      paid_amount: r.paid,
      due_amount: r.due,
      note: r.note.trim() || null,
      lines: products.map((l) => ({
        name_key: itemKey(l.name),
        kaarbar_name: l.name.trim(),
        quantity: l.quantity,
        unit: l.unit,
        rate: l.rate,
        line_discount: l.discount,
        line_total: l.total,
      })),
    });
  }
  const items: MergeItemRow[] = [];
  for (const key of keys) {
    if (!ctx.edits[key]) continue;
    const row = itemRow(key, ctx);
    if (!row) return null;
    items.push(row);
  }
  return { items, bills };
}

/* --------------------------------------------------------- texts */

export function qtyText(quantity: number, unit: string | null): string {
  const q = Number.isInteger(quantity) ? String(quantity) : String(round2(quantity));
  return unit ? `${q} ${unit.toUpperCase()}` : q;
}

export function receiptTitle(kind: 'sale' | 'return', billNo: string): string {
  return `${kind === 'return' ? 'Return' : 'Sale'} #${billNo}`;
}

/** A typed number for a line (quantity, rate, total), or null. */
export function typedNumber(text: string): number | null {
  const clean = text.replace(/[৳,\s]/g, '');
  if (clean === '' || !/^\d+(\.\d+)?$/.test(clean)) return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

/** Keep the saved items unique by key for the matching context. */
export function itemsByKey(items: readonly SavedItem[]): Map<string, SavedItem> {
  return new Map(items.map((i) => [i.key, i]));
}

