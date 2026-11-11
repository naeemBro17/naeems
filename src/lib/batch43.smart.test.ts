// @vitest-environment node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { salesSpeed, monthsToExpiry, isExpired, expiryEnd } from './smart/speed';
import { floorPrice, offerFor, offerList } from './smart/offers';
import { buyingLine, buyingLines, buyingSheet, buyingTotal, monthsCovered, packsFor, rowsForSource } from './smart/buying';
import { belowCostText } from './smart/belowCost';
import { investorReportModel, investorPdfName } from './smart/investorReport';
import { buildInvestorPdf } from './smart/investorPdf';
import { investorsSheet } from './reports/sheets';
import { moneyText } from './money/format';
import type { BuyingRow, InvestorStatement, OfferRow } from './smart/types';
import { fontFilesFromDisk, pdfPageCount, pdfPageText } from '../../e2e/helpers/invoicePdf';

const TODAY = '2026-11-11';

function offerRow(over: Partial<OfferRow> = {}): OfferRow {
  return {
    lot_item_id: 'li-1', product_id: 'p-1', variant_id: null, label: 'Test Cream', stock_unit: 'pcs', pack_size: 1,
    lot_code: 'L-001', lot_date: '2026-06-01', expiry_date: '2027-03-01', units: 14, units_before: 0, unit_cost: 700,
    units_90: 6, last_sold: '2026-11-01', history_days: 90, price: 1000,
    ...over,
  };
}

describe('Batch 43: sales speed', () => {
  it('is units sold in 90 days ÷ 3, like the Stock report', () => {
    expect(salesSpeed(6, 90)).toEqual({ perMonth: 2, isNew: false });
    expect(salesSpeed(10, 45)).toEqual({ perMonth: 3.3, isNew: false });
  });
  it('with less than 30 days of history it uses what exists, marked new', () => {
    expect(salesSpeed(3, 10)).toEqual({ perMonth: 9, isNew: true });
    expect(salesSpeed(0, 0)).toEqual({ perMonth: 0, isNew: true });
  });
  it('a product is good until the end of its expiry month', () => {
    expect(expiryEnd('2027-02-01')).toBe('2027-02-28');
    expect(isExpired('2026-11-01', TODAY)).toBe(false);
    expect(isExpired('2026-10-01', TODAY)).toBe(true);
    expect(monthsToExpiry('2027-03-01', TODAY)).toBeCloseTo(140 / 30.4, 6);
  });
});

describe('Batch 43: Give an offer', () => {
  it('"Give offer" when it needs more time to sell than it has, less one month (red, 10–20%)', () => {
    // 14 left at 2 a month = 7 months; 4.6 months to the end of March 2027.
    const o = offerFor(offerRow(), TODAY);
    expect(o?.status).toBe('offer');
    expect(o?.discount).toEqual({ min: 10, max: 20 });
    expect(o?.priceLow).toBe(800);
    expect(o?.priceHigh).toBe(900);
    expect(o?.floor).toBe(700);
    expect(o?.reason).toBe('sells 2 a month, 14 left, expires in 5 months (Mar 2027), needs about 7 months to sell');
  });
  it('"Watch" within a month of that (amber, 5–10%)', () => {
    // 6 left = 3 months; 3.6 ≥ 3 > 2.6.
    const o = offerFor(offerRow({ units: 6 }), TODAY);
    expect(o?.status).toBe('watch');
    expect(o?.discount).toEqual({ min: 5, max: 10 });
    expect(o?.priceLow).toBe(900);
    expect(o?.priceHigh).toBe(950);
  });
  it('nothing when it sells in time', () => {
    expect(offerFor(offerRow({ units: 4 }), TODAY)).toBeNull();
  });
  it('units of earlier-expiring lots sell first and count', () => {
    const o = offerFor(offerRow({ units: 4, units_before: 4 }), TODAY);
    expect(o?.status).toBe('offer');
    expect(o?.reason).toContain('4 from earlier-expiring lots sell first');
  });
  it('no sale in 90 days → Give offer, with that as the reason', () => {
    const o = offerFor(offerRow({ units_90: 0, units: 1 }), TODAY);
    expect(o?.status).toBe('offer');
    expect(o?.monthsToSell).toBeNull();
    expect(o?.reason.startsWith('no sale in the last 90 days')).toBe(true);
  });
  it('a new product is marked new', () => {
    const o = offerFor(offerRow({ units_90: 1, history_days: 10, units: 20 }), TODAY);
    expect(o?.isNew).toBe(true);
    expect(o?.reason).toContain('(new — less than 30 days of sales)');
  });
  it('the suggested price is never below the landed cost', () => {
    const capped = offerFor(offerRow({ unit_cost: 850 }), TODAY);
    expect(capped?.floor).toBe(850);
    expect(capped?.priceLow).toBe(850);
    expect(capped?.priceHigh).toBe(900);
    expect(capped?.maxDiscount).toBe(15);
    const none = offerFor(offerRow({ unit_cost: 1000 }), TODAY);
    expect(none?.noRoom).toBe(true);
    expect(none?.priceLow).toBe(1000);
    expect(none?.maxDiscount).toBe(0);
    for (const cost of [1, 333.33, 699.99, 812.5, 949.01, 999.99]) {
      const o = offerFor(offerRow({ unit_cost: cost }), TODAY);
      expect(o!.priceLow).toBeGreaterThanOrEqual(cost);
      expect(o!.priceHigh).toBeGreaterThanOrEqual(cost);
    }
  });
  it('the floor is the cost of a whole pack, rounded up', () => {
    expect(floorPrice(2.5, 400)).toBe(1000);
    expect(floorPrice(2.501, 400)).toBe(1001);
    expect(floorPrice(699.2, 1)).toBe(700);
  });
  it('lists expired units apart, with their landed cost; Give offer before Watch', () => {
    const list = offerList(
      [
        offerRow({ lot_item_id: 'w', units: 6, label: 'B' }),
        offerRow({ lot_item_id: 'x', expiry_date: '2026-10-01', units: 3, unit_cost: 120.5 }),
        offerRow({ lot_item_id: 'o', label: 'A', expiry_date: '2027-04-01', units: 20 }),
        offerRow({ lot_item_id: 'ok', units: 2 }),
      ],
      TODAY
    );
    expect(list.offers.map((o) => o.row.lot_item_id)).toEqual(['o', 'w']);
    expect(list.expired).toHaveLength(1);
    expect(list.expired[0].value).toBe(361.5);
  });
});

function buyRow(over: Partial<BuyingRow> = {}): BuyingRow {
  return {
    product_id: 'p-1', variant_id: null, label: 'Fish Oil', stock_unit: 'pcs', pack_size: 1, supplier_id: 's-1', country: 'Australia',
    units_left: 4, units_on_way: 2, units_90: 9, history_days: 90, last_sold: '2026-11-01', sold_120: 12, last_unit_cost: 1250.5,
    last_buy_unit: 1100, last_bought: '2026-08-01',
    ...over,
  };
}

describe('Batch 43: buying list', () => {
  const settings = { weeks: 6, months: 3 };
  it('covers the weeks until the stock arrives plus the months after', () => {
    expect(monthsCovered(settings)).toBeCloseTo(42 / 30.4 + 3, 9);
  });
  it('speed × time − left − on the way, rounded up to whole packs', () => {
    // 3 a month × 4.38 = 13.14 − 4 − 2 = 7.14 → 8.
    expect(buyingLine(buyRow(), settings).packs).toBe(8);
    // Packs of 3 → 3 packs (9 units).
    expect(buyingLine(buyRow({ pack_size: 3 }), settings).packs).toBe(3);
    // Exactly 6 units needed in packs of 3 → 2 packs, not 3.
    expect(buyingLine(buyRow({ units_90: 6, units_left: 0, units_on_way: 0 }), { weeks: 0, months: 3 }).packs).toBe(6);
    expect(buyingLine(buyRow({ units_90: 6, units_left: 0, units_on_way: 0, pack_size: 3 }), { weeks: 0, months: 3 }).packs).toBe(2);
  });
  it('units on the way count', () => {
    expect(buyingLine(buyRow({ units_on_way: 0 }), settings).packs).toBe(10);
    expect(buyingLine(buyRow({ units_on_way: 20 }), settings).packs).toBe(0);
    expect(buyingLine(buyRow({ units_on_way: 20 }), settings).note.startsWith('Enough stock')).toBe(true);
  });
  it('no sale in 120 days → Skip — not moving', () => {
    const l = buyingLine(buyRow({ sold_120: 0, units_90: 0 }), settings);
    expect(l.skip).toBe(true);
    expect(l.packs).toBe(0);
    expect(l.note.startsWith('Skip — not moving')).toBe(true);
  });
  it('only products usually bought from the chosen source', () => {
    const rows = [buyRow(), buyRow({ product_id: 'p-2', supplier_id: 's-2', country: 'japan' }), buyRow({ product_id: 'p-3', supplier_id: null, country: null })];
    expect(rowsForSource(rows, { kind: 'supplier', id: 's-1' }).map((r) => r.product_id)).toEqual(['p-1']);
    expect(rowsForSource(rows, { kind: 'country', name: 'Japan' }).map((r) => r.product_id)).toEqual(['p-2']);
    expect(rowsForSource(rows, null)).toEqual([]);
  });
  it('total money = packs × newest landed cost of a pack; a typed number replaces the suggestion', () => {
    const lines = buyingLines([buyRow(), buyRow({ product_id: 'p-2', pack_size: 2, last_unit_cost: 100 }), buyRow({ product_id: 'p-3', sold_120: 0 })], { kind: 'supplier', id: 's-1' }, settings);
    // 8 × 1250.50 + 4 packs × 200 = 10,004 + 800.
    expect(buyingTotal(lines, new Map())).toBe(10804);
    const typed = new Map([['p-1:', 2]]);
    expect(packsFor(lines.find((l) => l.key === 'p-1:')!, typed)).toBe(2);
    expect(buyingTotal(lines, typed)).toBe(2 * 1250.5 + 800);
    const sheet = buyingSheet(lines, typed, 'Chemist Warehouse', settings, TODAY);
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[0][0]).toBe('Fish Oil');
    expect(sheet.total?.[5]).toBe(2 * 1250.5 + 800);
    expect(String(sheet.rows.find((r) => r[1] === 2)?.[6])).toContain('Changed from 8');
  });
});

describe('Batch 43: below-cost words', () => {
  it('nothing when not below cost', () => {
    expect(belowCostText({ below: false, cost: 500, loss: null }, true)).toBeNull();
    expect(belowCostText(undefined, true)).toBeNull();
  });
  it('without "View profit & costs": no taka at all', () => {
    const t = belowCostText({ below: true, cost: null, loss: null }, false);
    expect(t).toBe('Below cost — check with Naeem');
    expect(belowCostText({ below: true, cost: 500, loss: 100 }, false)).toBe('Below cost — check with Naeem');
  });
  it('with it: the cost and the loss', () => {
    expect(belowCostText({ below: true, cost: 500, loss: 200 }, true)).toBe('Below cost — cost ৳500 each, loss ৳200');
  });
});

const STATEMENT: InvestorStatement = {
  from: '2026-10-01', to: '2026-10-31', sales: 148250.5, net_profit: 31420, roi_percent: 6.4,
  investor: { id: 'i-1', name: 'Rahim Uddin', capital_in: 500000, capital_back: 100000, owed: 400000, share_all: 45000, in_range: 0, back_range: 0, share_range: 9000 },
  year: 2026,
  months: Array.from({ length: 11 }, (_, i) => ({ month: `2026-${String(i + 1).padStart(2, '0')}-01`, sales: 10000 * (i + 1), net_profit: 2000 * (i + 1) })),
  start_date: '2026-01-01',
};

describe('Batch 43: investor report PDF', () => {
  const model = investorReportModel(STATEMENT, TODAY);
  it('says the same numbers as Reports → Investors and the Money page', () => {
    expect(model.business.map((b) => b.value)).toEqual([moneyText(148250.5), moneyText(31420), '6.4%']);
    const sheet = investorsSheet([STATEMENT.investor], STATEMENT.from, STATEMENT.to);
    const [, capitalIn, capitalBack, owed, , , , shareRange] = sheet.rows[0];
    expect(model.investorRows.map((r) => r.value)).toEqual([capitalIn, capitalBack, owed, shareRange].map((n) => moneyText(Number(n))));
    expect(model.months).toHaveLength(11);
    expect(model.monthsTotal).toEqual(['Total', moneyText(660000), moneyText(132000)]);
    expect(investorPdfName('Rahim Uddin', '2026-10-01', '2026-10-31')).toBe('NAEEMS-investor-Rahim-Uddin-2026-10-01-to-2026-10-31.pdf');
  });
  it('an unknown return shows a dash', () => {
    expect(investorReportModel({ ...STATEMENT, roi_percent: null }, TODAY).business[2].value).toBe('—');
  });
  it('is one A4 page, every character drawn, with the numbers on it', async () => {
    const pdf = await buildInvestorPdf(model, fontFilesFromDisk());
    expect(pdf.pageCount).toBe(1);
    expect(await pdfPageCount(pdf.bytes)).toBe(1);
    expect(pdf.missingCharacters).toEqual([]);
    const text = (await pdfPageText(pdf.bytes)).join(' ');
    for (const s of ["NAEEM'S", 'Rahim Uddin', '1 Oct 2026 – 31 Oct 2026', '1,48,250.50', '31,420', '6.4%', '5,00,000', '4,00,000', '9,000', 'Nov 2026', '6,60,000']) {
      expect(text.replace(/\s+/g, ' ')).toContain(s);
    }
    expect(text).not.toMatch(/Test Cream|customer/i);
    const dir = join(process.cwd(), 'reports', 'batch-43-samples');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'investor-report-sample.pdf'), pdf.bytes);
  });
});
