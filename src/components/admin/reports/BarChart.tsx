import { formatTakaBd } from '../../../lib/adminNav';

export interface BarSeries {
  name: string;
  /** CSS class of the bar (colour comes from the stylesheet tokens). */
  tone: 'dark' | 'light';
  values: readonly number[];
}

/** "৳12k", "৳1.2L" — short labels that fit over a bar. */
export function shortTaka(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (a >= 100000) return `${sign}৳${(a / 100000).toFixed(a >= 1000000 ? 0 : 1)}L`;
  if (a >= 1000) return `${sign}৳${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}k`;
  return `${sign}${formatTakaBd(a)}`;
}

/**
 * Batch 42: a plain bar chart — labels on the bars, a zero line, no 3D and
 * no animation. Negative months go below the line. The numbers are also in
 * the table under it (and the Excel file), so nothing depends on colour.
 */
export function BarChart({ labels, series, title, testId }: { labels: readonly string[]; series: readonly BarSeries[]; title: string; testId?: string }) {
  const all = series.flatMap((s) => s.values);
  const max = Math.max(0, ...all);
  const min = Math.min(0, ...all);
  const span = max - min || 1;
  const width = 640;
  const height = 240;
  const top = 18;
  const bottom = 30;
  const plot = height - top - bottom;
  const zeroY = top + (max / span) * plot;
  const group = width / Math.max(labels.length, 1);
  const barW = Math.max(4, Math.min(28, (group - 8) / series.length));

  return (
    <figure className="rep-chart" data-testid={testId}>
      <figcaption className="rep-chart__title">{title}</figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title} className="rep-chart__svg">
        <line x1="0" x2={width} y1={zeroY} y2={zeroY} className="rep-chart__zero" />
        {labels.map((label, i) => {
          const x0 = i * group + (group - barW * series.length) / 2;
          return (
            <g key={label}>
              {series.map((s, k) => {
                const v = s.values[i] ?? 0;
                const h = (Math.abs(v) / span) * plot;
                const y = v >= 0 ? zeroY - h : zeroY;
                const x = x0 + k * barW;
                return (
                  <g key={s.name}>
                    <rect x={x} y={y} width={barW - 2} height={Math.max(h, v === 0 ? 0 : 1)} className={`rep-bar rep-bar--${s.tone}${v < 0 ? ' rep-bar--neg' : ''}`}>
                      <title>{`${s.name}, ${label}: ${formatTakaBd(v)}`}</title>
                    </rect>
                    {v !== 0 && series.length === 1 && (
                      <text x={x + (barW - 2) / 2} y={v >= 0 ? y - 4 : y + h + 11} textAnchor="middle" className="rep-chart__value">
                        {shortTaka(v)}
                      </text>
                    )}
                  </g>
                );
              })}
              <text x={i * group + group / 2} y={height - 10} textAnchor="middle" className="rep-chart__label">
                {label}
              </text>
            </g>
          );
        })}
      </svg>
      {series.length > 1 && (
        <p className="rep-chart__legend">
          {series.map((s) => (
            <span key={s.name} className="rep-chart__key">
              <span className={`rep-chart__swatch rep-bar--${s.tone}`} aria-hidden="true" />
              {s.name}
            </span>
          ))}
        </p>
      )}
    </figure>
  );
}
