import { dayText, moneyText } from '../../../lib/money/format';
import type { ColumnKind, ReportSheet, ReportValue } from '../../../lib/reports/excel';

/** One value as the screen shows it (the Excel file keeps the real number). */
export function cellText(kind: ColumnKind, value: ReportValue): string {
  if (value === null || value === '') return '';
  if (typeof value === 'number') {
    if (kind === 'money') return moneyText(value);
    if (kind === 'percent') return `${Math.round(value * 10) / 10}%`;
    return value.toLocaleString('en-IN');
  }
  if (kind === 'date') return dayText(value);
  return value;
}

interface TableProps {
  sheet: ReportSheet;
  testId?: string;
  /** Rows to show before "Show all" (the file always has every row). */
  limit?: number;
  /** Row labels (first column) shown bold — totals in Profit & loss. */
  strongRows?: ReadonlySet<number>;
  /** Row indexes shown smaller and grey (expense categories). */
  subRows?: ReadonlySet<number>;
  empty?: string;
  caption?: string;
}

/**
 * Batch 42: a report table. The same ReportSheet becomes the Excel sheet,
 * so what the screen shows and what the file adds up are one thing. Wide
 * tables scroll sideways inside their own box (the page never does).
 */
export function ReportTable({ sheet, testId, limit, strongRows, subRows, empty = 'Nothing in these dates.', caption }: TableProps) {
  const rows = limit !== undefined ? sheet.rows.slice(0, limit) : sheet.rows;
  if (sheet.rows.length === 0) {
    return (
      <p className="inv-muted rep-empty" data-testid={testId ? `${testId}-empty` : undefined}>
        {empty}
      </p>
    );
  }
  return (
    <div className="rep-table-wrap" data-testid={testId}>
      <table className="rep-table">
        {caption && <caption className="rep-caption">{caption}</caption>}
        <thead>
          <tr>
            {sheet.columns.map((c, i) => (
              <th key={i} scope="col" className={c.kind === 'text' || c.kind === 'date' ? '' : 'rep-num'}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className={`${strongRows?.has(r) ? 'rep-row--strong' : ''}${subRows?.has(r) ? ' rep-row--sub' : ''}`}>
              {sheet.columns.map((c, i) => {
                const value = row[i] ?? null;
                const negative = typeof value === 'number' && c.kind === 'money' && Math.round(value * 100) < 0;
                return (
                  <td key={i} className={`${c.kind === 'text' || c.kind === 'date' ? '' : 'rep-num'}${negative ? ' rep-neg' : ''}`}>
                    {cellText(c.kind, value)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        {sheet.total && (
          <tfoot>
            <tr>
              {sheet.columns.map((c, i) => (
                <td key={i} className={c.kind === 'text' || c.kind === 'date' ? '' : 'rep-num'} data-testid={testId ? `${testId}-total-${i}` : undefined}>
                  {cellText(c.kind, sheet.total?.[i] ?? null)}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
      {limit !== undefined && sheet.rows.length > limit && (
        <p className="inv-muted rep-more">
          Showing {limit} of {sheet.rows.length}. The Excel file has all of them.
        </p>
      )}
    </div>
  );
}
