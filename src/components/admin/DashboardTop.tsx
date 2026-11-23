import { sectionPath } from '../../lib/adminNav';
import { ActionLink } from '../shared/ActionLink';
import { moneyText, signedMoney } from '../../lib/money/format';
import { changePercent, changeText, type DashboardPeriod } from '../../lib/reports/periods';
import type { DashboardData } from '../../lib/reports/types';
import type { AdminSection } from '../../lib/adminNav';
import { ChipRow } from './ui/AdminUi';

interface Props {
  data: DashboardData | null;
  error: string | null;
  period: DashboardPeriod;
  onPeriod: (p: DashboardPeriod) => void;
  onOpen: (section: AdminSection, params?: Record<string, string>) => void;
}

const PREV_TEXT: Record<DashboardPeriod, string> = {
  today: 'vs yesterday',
  month: 'vs the same days last month',
  year: 'vs the same days last year',
};

function Row({ label, value, testId }: { label: string; value: number; testId?: string }) {
  return (
    <div className="inv-line">
      <span>{label}</span>
      <span data-testid={testId}>{moneyText(value)}</span>
    </div>
  );
}

/**
 * Batch 42 Part 1: the top of the Dashboard (Home for "View profit &
 * costs") — few numbers, big and clear; the details are one tap away in
 * Reports. Every number is the Money page's own (money_summary): Your
 * profit, the return on money in the business, the money now and the
 * balance check. Batch 58: investors' money is shown on its own line,
 * apart from what the business owes (To give).
 */
export function DashboardTop({ data, error, period, onPeriod, onOpen }: Props) {
  const s = data?.summary;
  const p = s?.profit;
  const pos = s?.position;
  const change = p && data?.previous ? changePercent(p.your_profit, data.previous.your_profit) : null;

  return (
    <div className="dash" data-testid="dashboard">
      <ChipRow
        label="Period"
        active={period}
        onSelect={(id) => onPeriod(id as DashboardPeriod)}
        chips={[
          { id: 'today', label: 'Today' },
          { id: 'month', label: 'This month' },
          { id: 'year', label: 'This year' },
        ]}
      />
      {error ? (
        <p className="inv-error" role="alert" data-testid="dash-error">
          {error}
        </p>
      ) : !s || !p || !pos ? (
        <div className="dash-grid" aria-label="Loading" role="status">
          {[0, 1, 2].map((i) => (
            <div key={i} className="adm-kpi adm-kpi--loading dash-card" />
          ))}
        </div>
      ) : (
        <div className="dash-grid">
          <ActionLink className="adm-ocard dash-card dash-profit" to={sectionPath('reports', { r: 'pnl', rp: period })} onOpen={() => onOpen('reports', { r: 'pnl', rp: period })} data-testid="dash-profit">
            <span className="money-big-label">Your profit</span>
            <span className={`dash-big${p.your_profit < 0 ? ' money-out' : ''}`} data-testid="dash-your-profit">
              {signedMoney(p.your_profit)}
            </span>
            <span className={`dash-change${change !== null && change < 0 ? ' money-out' : ''}`} data-testid="dash-change">
              {changeText(change)} <span className="inv-muted">{PREV_TEXT[period]}</span>
            </span>
            <span className="dash-small" data-testid="dash-took">
              You took {moneyText(p.withdrawals)}
            </span>
            <span className="dash-small" data-testid="dash-left">
              Left in the business {moneyText(p.left_in_business)}
            </span>
            {!s.confirmed && <span className="inv-muted dash-small">Opening balances not confirmed yet.</span>}
          </ActionLink>

          <ActionLink className="adm-ocard dash-card" to={sectionPath('money')} onOpen={() => onOpen('money')} data-testid="dash-roi">
            <span className="money-big-label">Return on money in the business</span>
            <span className="dash-big" data-testid="dash-roi-value">
              {s.roi.percent === null ? '—' : `${s.roi.percent}%`}
            </span>
            <span className="inv-muted dash-small">Net profit {moneyText(p.net_profit)} ÷ average money in the business (as on the Money page).</span>
          </ActionLink>

          <div className="adm-ocard dash-card inv-stack" data-testid="dash-money">
            <div className="dash-card__head">
              <span className="money-big-label">Money now</span>
              {pos.balanced === true ? (
                <span className="dash-badge dash-badge--ok" data-testid="dash-balance-ok">
                  All figures match
                </span>
              ) : pos.balanced === false ? (
                <span className="dash-badge dash-badge--bad" role="alert" data-testid="dash-balance-off">
                  Mismatch {signedMoney(pos.difference ?? 0)}
                </span>
              ) : (
                <span className="dash-badge" data-testid="dash-balance-none">
                  Not checked yet
                </span>
              )}
            </div>
            {pos.accounts
              .filter((a) => a.kind !== 'steadfast' && (!a.archived || a.balance !== 0))
              .map((a) => (
                <Row key={a.account_id} label={a.name} value={a.balance} />
              ))}
            <Row label="With Steadfast" value={pos.with_steadfast} testId="dash-steadfast" />
            <Row label="To receive" value={pos.to_receive + pos.previous_balances} testId="dash-receive" />
            <Row label="To give" value={pos.to_give - pos.to_give_investors} testId="dash-give" />
            <Row label="Stock value" value={pos.stock_value} testId="dash-stock" />
            {pos.to_give_investors !== 0 && (
              <>
                <div className="dash-divider" />
                <Row label="Investors' money" value={pos.to_give_investors} testId="dash-investors" />
                <span className="dash-small">Money your investors have put in. Shown apart from what you owe.</span>
              </>
            )}
            <ActionLink className="adm-btn adm-btn--ghost adm-btn--sm" to={sectionPath('money')} onOpen={() => onOpen('money')}>
              Open Money
            </ActionLink>
          </div>
        </div>
      )}
    </div>
  );
}
