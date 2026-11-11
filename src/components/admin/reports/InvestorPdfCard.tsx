import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../../../hooks/useToast';
import { downloadBlob } from '../../../lib/reports/excel';
import { monthRange, monthText } from '../../../lib/money/format';
import type { DateRange } from '../../../lib/reports/periods';
import type { InvestorRow } from '../../../lib/reports/types';
import { fetchInvestorStatement } from '../../../lib/smart/api';
import { investorPdfName, investorReportModel, periodText } from '../../../lib/smart/investorReport';
import { canShareFile, makeInvestorFile, shareFile, type InvestorFile } from '../../../lib/smart/investorOutput';
import '../../../styles/adminSmart.css';

interface Props {
  investors: readonly InvestorRow[];
  range: DateRange;
  today: string;
  /** Picks a whole month as the report's dates. */
  onPickMonth: (range: DateRange) => void;
}

/** The last 12 months, newest first, as "YYYY-MM". */
function recentMonths(today: string): string[] {
  const [y, m] = today.split('-').map(Number);
  const out: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/**
 * Batch 43 Part 4: Reports → Investors → a one-page A4 PDF for one investor
 * and the report's dates (or a month picked here). The numbers come from
 * report_investor_statement — the same functions as the Money page and the
 * Reports. Download, or Share on a phone.
 */
export function InvestorPdfCard({ investors, range, today, onPickMonth }: Props) {
  const { showToast } = useToast();
  const [investorId, setInvestorId] = useState(investors[0]?.id ?? '');
  const [busy, setBusy] = useState<'download' | 'share' | null>(null);
  const months = useMemo(() => recentMonths(today), [today]);
  const pickedMonth = months.find((m) => {
    const r = monthRange(m);
    return r.from === range.from && r.to === range.to;
  });

  useEffect(() => {
    if (!investors.some((i) => i.id === investorId)) setInvestorId(investors[0]?.id ?? '');
  }, [investors, investorId]);

  const make = async (): Promise<InvestorFile | null> => {
    const answer = await fetchInvestorStatement(investorId, range);
    if (answer.kind !== 'ready') {
      showToast(answer.kind === 'error' ? answer.message : 'The Batch 43 database step has not been run.');
      return null;
    }
    const model = investorReportModel(answer.data, today);
    return makeInvestorFile(model, investorPdfName(answer.data.investor.name, range.from, range.to));
  };

  const run = async (how: 'download' | 'share') => {
    if (!investorId) return;
    setBusy(how);
    try {
      const file = await make();
      if (!file) return;
      if (how === 'share' && canShareFile(file.file)) {
        // Cancelling the share sheet is fine: nothing else to do.
        await shareFile(file.file, file.fileName);
        return;
      }
      downloadBlob(file.blob, file.fileName);
      if (how === 'share') showToast('Sharing is not available here — the PDF was downloaded instead.');
    } catch {
      showToast('Could not make the PDF. Please try again.');
    } finally {
      setBusy(null);
    }
  };

  if (investors.length === 0) return null;

  return (
    <div className="adm-ocard smart-pdf" data-testid="investor-pdf">
      <h3 className="smart-pdf__title">Investor report (PDF)</h3>
      <p className="inv-muted">
        One A4 page in English for the investor: sales, net profit, return on money, their capital and profit share, and the
        year by month. No product costs, no customer names.
      </p>
      <label className="form-field">
        <span className="form-label">Investor</span>
        <select className="form-input" value={investorId} onChange={(e) => setInvestorId(e.target.value)} data-testid="investor-pdf-who">
          {investors.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
      </label>
      <label className="form-field">
        <span className="form-label">Month (or use the dates above)</span>
        <select
          className="form-input"
          value={pickedMonth ?? ''}
          onChange={(e) => {
            if (e.target.value) onPickMonth(monthRange(e.target.value));
          }}
          data-testid="investor-pdf-month"
        >
          <option value="">The dates above</option>
          {months.map((m) => (
            <option key={m} value={m}>
              {monthText(m)}
            </option>
          ))}
        </select>
      </label>
      <p className="inv-muted" data-testid="investor-pdf-period">
        Period: {periodText(range.from, range.to)}
      </p>
      <div className="smart-pdf__buttons">
        <button type="button" className="adm-btn adm-btn--ghost" disabled={busy !== null || !investorId} onClick={() => void run('download')} data-testid="investor-pdf-download">
          {busy === 'download' ? 'Making…' : 'Download PDF'}
        </button>
        <button type="button" className="adm-btn adm-btn--ghost" disabled={busy !== null || !investorId} onClick={() => void run('share')} data-testid="investor-pdf-share">
          {busy === 'share' ? 'Making…' : 'Share'}
        </button>
      </div>
    </div>
  );
}
