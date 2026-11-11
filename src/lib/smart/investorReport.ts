/* Batch 43 Part 4: what the one-page investor report says — built from
   report_investor_statement (money_summary / report_investors /
   money_profit_parts), so its numbers are the Reports' numbers. Kept apart
   from the PDF drawing so the tests can check every line. */
import { dayText, moneyText } from '../money/format';
import { shortMonth } from '../reports/periods';
import type { InvestorStatement } from './types';

export interface InvestorReportModel {
  shop: string;
  title: string;
  investor: string;
  period: string;
  /** The business in the period. */
  business: { label: string; value: string }[];
  /** This investor. */
  investorRows: { label: string; value: string }[];
  /** The year by month: [month, sales, net profit]. */
  monthsTitle: string;
  months: [string, string, string][];
  monthsTotal: [string, string, string];
  footer: string;
}

export function periodText(from: string, to: string): string {
  if (from === to) return dayText(from);
  return `${dayText(from)} – ${dayText(to)}`;
}

export function percentText(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return '—';
  return `${p.toFixed(1)}%`;
}

export function investorReportModel(s: InvestorStatement, madeOn: string): InvestorReportModel {
  const inv = s.investor;
  const sales = s.months.reduce((a, m) => a + m.sales, 0);
  const net = s.months.reduce((a, m) => a + m.net_profit, 0);
  return {
    shop: "NAEEM'S",
    title: 'Investor report',
    investor: inv.name,
    period: periodText(s.from, s.to),
    business: [
      { label: 'Sales', value: moneyText(s.sales) },
      { label: 'Net profit', value: moneyText(s.net_profit) },
      { label: 'Return on money in the business', value: percentText(s.roi_percent) },
    ],
    investorRows: [
      { label: 'Capital put in (all time)', value: moneyText(inv.capital_in) },
      { label: 'Capital returned (all time)', value: moneyText(inv.capital_back) },
      { label: 'Capital still owed', value: moneyText(inv.owed) },
      { label: 'Profit share paid in this period', value: moneyText(inv.share_range) },
    ],
    monthsTitle: `${s.year} by month`,
    months: s.months.map((m) => [shortMonth(m.month), moneyText(m.sales), moneyText(m.net_profit)]),
    monthsTotal: ['Total', moneyText(Math.round(sales * 100) / 100), moneyText(Math.round(net * 100) / 100)],
    footer: `Made on ${dayText(madeOn)}${s.start_date ? ` · Books kept since ${dayText(s.start_date)}` : ''} · Net profit = sales − cost of goods + delivery charged − courier − expenses − write-offs.`,
  };
}

export function investorPdfName(investor: string, from: string, to: string): string {
  const safe = investor.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'investor';
  return `NAEEMS-investor-${safe}-${from}${from === to ? '' : `-to-${to}`}.pdf`;
}
