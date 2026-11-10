import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { categoryShares, moneyText, signedMoney } from '../../../lib/money/format';
import {
  fetchCharts,
  fetchCustomersReport,
  fetchDayBook,
  fetchInvestorsReport,
  fetchLotsReport,
  fetchProductsReport,
  fetchProfitLoss,
  fetchSalesReport,
  fetchStockReport,
} from '../../../lib/reports/api';
import { shortMonth } from '../../../lib/reports/periods';
import {
  chartsSheet,
  customerSheets,
  dayBookSheets,
  expensesSheets,
  expiringRows,
  investorsSheet,
  lotsSheet,
  pnlLines,
  pnlSheet,
  PRODUCT_TABS,
  productSheets,
  salesSheets,
  sellsText,
  sourceLabel,
  stockSheets,
  sum,
  type ProductsTab,
} from '../../../lib/reports/sheets';
import { ChipRow } from '../ui/AdminUi';
import { BarChart } from './BarChart';
import { ReportShell, useReport, useReportRange } from './ReportShell';
import { ReportTable } from './ReportTable';

interface ViewProps {
  onBack: () => void;
  onOpenOrder?: (orderNumber: string) => void;
}

function Big({ label, value, testId, tone }: { label: string; value: string; testId?: string; tone?: 'bad' }) {
  return (
    <div className="rep-stat">
      <span className="rep-stat__label">{label}</span>
      <span className={`rep-stat__value${tone === 'bad' ? ' money-out' : ''}`} data-testid={testId}>
        {value}
      </span>
    </div>
  );
}

/* ------------------------------------------------------ 1. Profit & loss */

export function ProfitLossView({ onBack }: ViewProps) {
  const period = useReportRange('month');
  const { state } = useReport(() => fetchProfitLoss(period.range), [period.range.from, period.range.to]);
  const data = state?.kind === 'ready' ? state.data : null;
  const sheet = useMemo(() => (data ? pnlSheet(data) : null), [data]);
  const lines = useMemo(() => (data ? pnlLines(data) : []), [data]);
  const strong = new Set(lines.map((l, i) => (l.kind === 'total' ? i : -1)).filter((i) => i >= 0));
  const subs = new Set(lines.map((l, i) => (l.kind === 'sub' ? i : -1)).filter((i) => i >= 0));
  return (
    <ReportShell title="Profit & loss" onBack={onBack} period={period} sheets={sheet ? [sheet] : null} locked={data?.locked_months} state={period.valid ? state : null}>
      {data && sheet && (
        <>
          <div className="rep-stats">
            <Big label="Net profit" value={signedMoney(data.parts.net_profit)} testId="pnl-net" tone={data.parts.net_profit < 0 ? 'bad' : undefined} />
            <Big label="Your profit" value={signedMoney(data.parts.your_profit)} testId="pnl-your" tone={data.parts.your_profit < 0 ? 'bad' : undefined} />
            <Big label="Left in the business" value={signedMoney(data.parts.left_in_business)} testId="pnl-left" />
          </div>
          {data.parts.uncosted_orders > 0 && (
            <p className="inv-muted">
              {data.parts.uncosted_orders} order{data.parts.uncosted_orders === 1 ? '' : 's'} from before Inventory mode (no lot cost) are left out, as on the Money page.
            </p>
          )}
          <ReportTable sheet={sheet} testId="pnl-table" strongRows={strong} subRows={subs} />
        </>
      )}
    </ReportShell>
  );
}

/* ---------------------------------------------------------------- 2. Sales */

export function SalesView({ onBack, onOpenOrder }: ViewProps) {
  const period = useReportRange('month');
  const { state } = useReport(() => fetchSalesReport(period.range), [period.range.from, period.range.to]);
  const data = state?.kind === 'ready' ? state.data : null;
  const sheets = useMemo(() => (data ? salesSheets(data) : null), [data]);
  return (
    <ReportShell
      title="Sales"
      onBack={onBack}
      period={period}
      sheets={sheets}
      locked={data?.locked_months}
      state={period.valid ? state : null}
      note={<p className="inv-muted">Orders PLACED in these dates (not cancelled). Profit counts an order on the day it is delivered, so Profit &amp; loss can differ.</p>}
    >
      {data && sheets && (
        <>
          <div className="rep-stats">
            <Big label="Entries" value={String(data.totals.entries)} testId="sales-entries" />
            <Big label="Total" value={moneyText(data.totals.total)} testId="sales-total" />
            <Big label="Received" value={moneyText(data.totals.received)} testId="sales-received" />
            <Big label="Unpaid" value={moneyText(data.totals.unpaid)} testId="sales-unpaid" tone={data.totals.unpaid > 0 ? 'bad' : undefined} />
          </div>
          <h2 className="inv-section">By source</h2>
          <ReportTable sheet={sheets[1]} testId="sales-sources" />
          <h2 className="inv-section">Orders</h2>
          <div className="rep-table-wrap">
            <ul className="rep-list" data-testid="sales-orders">
              {data.orders.slice(0, 200).map((o) => (
                <li key={o.order_id}>
                  <button type="button" className="rep-list__row" onClick={() => onOpenOrder?.(o.order_number)}>
                    <span>
                      <b>{o.order_number}</b> · {o.customer_name}
                      <span className="inv-muted"> · {sourceLabel(o.source)}{o.status === 'returned' ? ' · Returned' : ''}</span>
                    </span>
                    <span className="rep-num">
                      {moneyText(o.total)}
                      {o.due > 0 && <span className="money-out"> · {moneyText(o.due)} unpaid</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {data.orders.length > 200 && <p className="inv-muted rep-more">Showing 200 of {data.orders.length}. The Excel file has all of them.</p>}
            {data.orders.length === 0 && <p className="inv-muted rep-empty">No orders in these dates.</p>}
          </div>
        </>
      )}
    </ReportShell>
  );
}

/* ------------------------------------------------------------- 3. Products */

export function ProductsView({ onBack }: ViewProps) {
  const period = useReportRange('month');
  const [params, setParams] = useSearchParams();
  const tabRaw = params.get('rtab') ?? 'best';
  const tab: ProductsTab = PRODUCT_TABS.some((t) => t.id === tabRaw) ? (tabRaw as ProductsTab) : 'best';
  const { state } = useReport(() => fetchProductsReport(period.range), [period.range.from, period.range.to]);
  const data = state?.kind === 'ready' ? state.data : null;
  const sheets = useMemo(() => (data ? productSheets(data) : null), [data]);
  const setTab = (id: string) => {
    const p = new URLSearchParams(params);
    p.set('rtab', id);
    setParams(p, { replace: true });
  };
  return (
    <ReportShell
      title="Products"
      onBack={onBack}
      period={period}
      sheets={sheets ? PRODUCT_TABS.map((t) => sheets[t.id]) : null}
      locked={data?.locked_months}
      state={period.valid ? state : null}
    >
      {data && sheets && (
        <>
          <div className="rep-stats">
            <Big label="Sales" value={moneyText(data.totals.sales)} testId="products-sales" />
            <Big label="Profit on goods" value={signedMoney(sum([data.totals.sales, -data.totals.cost]))} testId="products-profit" />
          </div>
          <ChipRow label="Products" active={tab} onSelect={setTab} chips={PRODUCT_TABS.map((t) => ({ id: t.id, label: t.label }))} />
          <ReportTable sheet={sheets[tab]} testId={`products-${tab}`} limit={150} empty="No products here." />
        </>
      )}
    </ReportShell>
  );
}

/* ---------------------------------------------------------------- 4. Lots */

export function LotsView({ onBack }: ViewProps) {
  const { state } = useReport(() => fetchLotsReport(), []);
  const data = state?.kind === 'ready' ? state.data : null;
  const sheet = useMemo(() => (data ? lotsSheet(data) : null), [data]);
  return (
    <ReportShell
      title="Lots"
      onBack={onBack}
      sheets={sheet ? [sheet] : null}
      state={state}
      note={<p className="inv-muted">All time. Landed cost includes the trip costs (weight and other bills). Sales and profit are for delivered units.</p>}
    >
      {sheet && <ReportTable sheet={sheet} testId="lots-table" empty="No lots yet." />}
    </ReportShell>
  );
}

/* --------------------------------------------------------------- 5. Stock */

export function StockView({ onBack }: ViewProps) {
  const [tab, setTab] = useState<'all' | 'expiring'>('all');
  const { state } = useReport(() => fetchStockReport(), []);
  const data = state?.kind === 'ready' ? state.data : null;
  const sheets = useMemo(() => (data ? stockSheets(data) : null), [data]);
  const expiring = useMemo(() => (data ? expiringRows(data) : []), [data]);
  return (
    <ReportShell title="Stock" onBack={onBack} sheets={sheets ? [sheets.all, sheets.expiring] : null} state={state}>
      {data && sheets && (
        <>
          <div className="rep-stats">
            <Big label="Stock at landed cost" value={moneyText(data.total_value)} testId="stock-value" />
            <Big label="Expiring in 90 days" value={String(expiring.length)} testId="stock-expiring-count" />
          </div>
          <ChipRow
            label="Stock"
            active={tab}
            onSelect={(id) => setTab(id as 'all' | 'expiring')}
            chips={[
              { id: 'all', label: 'All stock' },
              { id: 'expiring', label: 'Expiring (90 days)', count: expiring.length },
            ]}
          />
          {tab === 'all' ? (
            <ReportTable sheet={sheets.all} testId="stock-table" limit={300} empty="No stock in lots." />
          ) : expiring.length === 0 ? (
            <p className="inv-muted rep-empty" data-testid="stock-expiring-empty">Nothing expires in the next 90 days.</p>
          ) : (
            <ul className="rep-list" data-testid="stock-expiring">
              {expiring.map((r) => (
                <li key={r.lot_item_id} className="rep-list__item">
                  <span>
                    <b>{r.label}</b> · {r.lot_code}
                    <span className="inv-muted"> · {r.units} {r.stock_unit} · expires {shortMonth(r.expiry_date ?? '')}</span>
                  </span>
                  <span className={r.sells_in_time ? 'inv-muted' : 'money-out'}>{sellsText(r)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </ReportShell>
  );
}

/* ------------------------------------------------------------ 6. Expenses */

export function ExpensesReportView({ onBack }: ViewProps) {
  const period = useReportRange('month');
  const { state } = useReport(() => fetchProfitLoss(period.range), [period.range.from, period.range.to]);
  const data = state?.kind === 'ready' ? state.data : null;
  const sheets = useMemo(() => (data ? expensesSheets(data) : null), [data]);
  const shares = useMemo(() => (data ? categoryShares(data.expenses_by_category) : []), [data]);
  return (
    <ReportShell title="Expenses" onBack={onBack} period={period} sheets={sheets} locked={data?.locked_months} state={period.valid ? state : null}>
      {data && sheets && (
        <>
          <div className="rep-stats">
            <Big label="Expenses" value={moneyText(data.parts.expenses)} testId="expenses-total" />
          </div>
          {shares.length > 0 && (
            <ul className="rep-shares" aria-label="Share of each category">
              {shares.map((c) => (
                <li key={c.category_id} className="rep-share">
                  <span className="rep-share__name">{c.name}</span>
                  <span className="rep-share__bar" aria-hidden="true">
                    <span style={{ transform: `scaleX(${c.percent / 100})` }} />
                  </span>
                  <span className="rep-num">
                    {moneyText(c.amount)} · {c.percent}%
                  </span>
                </li>
              ))}
            </ul>
          )}
          <ReportTable sheet={sheets[0]} testId="expenses-categories" empty="No expenses in these dates." />
          {sheets[1] && (
            <>
              <h2 className="inv-section">By month</h2>
              <ReportTable sheet={sheets[1]} testId="expenses-months" />
            </>
          )}
        </>
      )}
    </ReportShell>
  );
}

/* ----------------------------------------------------------- 7. Customers */

export function CustomersReportView({ onBack }: ViewProps) {
  const period = useReportRange('year');
  const [tab, setTab] = useState<'dues' | 'bought' | 'profit'>('dues');
  const { state } = useReport(() => fetchCustomersReport(period.range), [period.range.from, period.range.to]);
  const data = state?.kind === 'ready' ? state.data : null;
  const sheets = useMemo(() => (data ? customerSheets(data) : null), [data]);
  const totals = sheets ? sheets[0].total : null;
  return (
    <ReportShell
      title="Customers"
      onBack={onBack}
      period={period}
      sheets={sheets}
      state={period.valid ? state : null}
      note={<p className="inv-muted">Dues are as of today (the dates choose the top customers). Age = days since the unpaid order was placed.</p>}
    >
      {data && sheets && totals && (
        <>
          <div className="rep-stats">
            <Big label="To receive" value={moneyText(Number(totals[5] ?? 0))} testId="cust-due-total" />
            <Big label="0–30 days" value={moneyText(Number(totals[2] ?? 0))} testId="cust-d0" />
            <Big label="31–60 days" value={moneyText(Number(totals[3] ?? 0))} testId="cust-d31" />
            <Big label="Over 60 days" value={moneyText(Number(totals[4] ?? 0))} testId="cust-d61" tone={Number(totals[4] ?? 0) > 0 ? 'bad' : undefined} />
          </div>
          <ChipRow
            label="Customers"
            active={tab}
            onSelect={(id) => setTab(id as 'dues' | 'bought' | 'profit')}
            chips={[
              { id: 'dues', label: 'Dues by age' },
              { id: 'bought', label: 'Top by bought' },
              { id: 'profit', label: 'Top by profit' },
            ]}
          />
          <ReportTable
            sheet={tab === 'dues' ? sheets[0] : tab === 'bought' ? sheets[1] : sheets[2]}
            testId={`cust-${tab}`}
            limit={100}
            empty={tab === 'dues' ? 'No customer owes anything.' : 'No delivered orders in these dates.'}
          />
        </>
      )}
    </ReportShell>
  );
}

/* ------------------------------------------------------------ 8. Day book */

export function DayBookView({ onBack }: ViewProps) {
  const period = useReportRange('today');
  const [account, setAccount] = useState<string>('all');
  const { state } = useReport(() => fetchDayBook(period.range), [period.range.from, period.range.to]);
  const data = state?.kind === 'ready' ? state.data : null;
  const sheets = useMemo(() => (data ? dayBookSheets(data) : null), [data]);
  const shown = data ? data.accounts.map((a, i) => ({ a, sheet: sheets?.[i] })).filter((x) => account === 'all' || x.a.account_id === account) : [];
  return (
    <ReportShell title="Day book" onBack={onBack} period={period} sheets={sheets} locked={data?.locked_months} state={period.valid ? state : null}>
      {data && (
        <>
          <div className="rep-stats">
            <Big label="Money in" value={moneyText(sum(data.accounts.map((a) => a.money_in)))} testId="daybook-in" />
            <Big label="Money out" value={moneyText(sum(data.accounts.map((a) => a.money_out)))} testId="daybook-out" />
          </div>
          <ChipRow
            label="Account"
            active={account}
            onSelect={setAccount}
            chips={[{ id: 'all', label: 'All accounts' }, ...data.accounts.map((a) => ({ id: a.account_id, label: a.name }))]}
          />
          {shown.map(({ a, sheet }) => (
            <div key={a.account_id} className="rep-account" data-testid="daybook-account">
              <h2 className="inv-section">
                {a.name}: {moneyText(a.opening)} → <b>{moneyText(a.closing)}</b>
              </h2>
              {sheet && <ReportTable sheet={sheet} limit={300} />}
            </div>
          ))}
        </>
      )}
    </ReportShell>
  );
}

/* ----------------------------------------------------------- 9. Investors */

export function InvestorsView({ onBack }: ViewProps) {
  const period = useReportRange('year');
  const { state } = useReport(() => fetchInvestorsReport(period.range), [period.range.from, period.range.to]);
  const data = state?.kind === 'ready' ? state.data : null;
  const sheet = useMemo(() => (data ? investorsSheet(data, period.range.from, period.range.to) : null), [data, period.range.from, period.range.to]);
  return (
    <ReportShell title="Investors" onBack={onBack} period={period} sheets={sheet ? [sheet] : null} state={period.valid ? state : null}>
      {data && sheet && (
        <>
          <div className="rep-stats">
            <Big label="Still owed to investors" value={moneyText(sum(data.map((r) => r.owed)))} testId="inv-owed" />
            <Big label="Profit share in these dates" value={moneyText(sum(data.map((r) => r.share_range)))} testId="inv-share" />
          </div>
          <ReportTable sheet={sheet} testId="investors-table" empty="No investors yet." />
        </>
      )}
    </ReportShell>
  );
}

/* -------------------------------------------------------------- 10. Charts */

export function ChartsView({ onBack }: ViewProps) {
  const { state } = useReport(() => fetchCharts(), []);
  const data = state?.kind === 'ready' ? state.data : null;
  const sheet = useMemo(() => (data ? chartsSheet(data) : null), [data]);
  const labels = data ? data.months.map((m) => shortMonth(m.month).slice(0, 3)) : [];
  return (
    <ReportShell title="Charts" onBack={onBack} sheets={sheet ? [sheet] : null} state={state}>
      {data && sheet && (
        <>
          <BarChart title="Your profit by month (last 12 months)" labels={labels} series={[{ name: 'Your profit', tone: 'dark', values: data.months.map((m) => m.your_profit) }]} testId="chart-profit" />
          <BarChart
            title="Money in vs money out by month"
            labels={labels}
            series={[
              { name: 'Money in', tone: 'dark', values: data.months.map((m) => m.money_in) },
              { name: 'Money out', tone: 'light', values: data.months.map((m) => m.money_out) },
            ]}
            testId="chart-money"
          />
          <ReportTable sheet={sheet} testId="charts-table" />
        </>
      )}
    </ReportShell>
  );
}
