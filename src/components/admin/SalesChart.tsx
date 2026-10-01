import { useEffect, useState } from 'react';
import { fetchSales7d, salesBars, type SalesBar } from '../../lib/brandAdmin';
import { formatTakaBd } from '../../lib/adminNav';

/**
 * Admin Home: the last 7 days of sales (Batch 26 Part 7). One bar per day —
 * total ৳ of orders that aren't cancelled, Bangladesh time — today's bar
 * orange, the rest grey. Tap (or hover) a bar for its value. The database
 * refuses the numbers without "See sales figures", and then nothing shows.
 */
export function SalesChart() {
  const [bars, setBars] = useState<SalesBar[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchSales7d().then((days) => {
      if (alive) setBars(days ? salesBars(days) : []);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (bars === null) return <div className="adm-sales adm-sales--loading" aria-label="Loading" role="status" />;
  if (bars.length === 0) return null;

  const shown = bars.find((b) => b.day === picked) ?? bars[bars.length - 1];
  const weekTotal = bars.reduce((sum, b) => sum + b.total, 0);

  return (
    <section className="adm-sales" aria-label="Sales, last 7 days" data-testid="sales-chart">
      <div className="adm-sales__head">
        <h2 className="adm-group__title adm-sales__title">LAST 7 DAYS</h2>
        <span className="adm-sales__week">{formatTakaBd(weekTotal)}</span>
      </div>
      <p className="adm-sales__readout" aria-live="polite" data-testid="sales-readout">
        <b>{shown.isToday ? 'Today' : `${shown.weekday} ${shown.date}`}</b>
        <span>{formatTakaBd(shown.total)}</span>
        <span className="adm-sales__orders">
          {shown.orderCount} order{shown.orderCount === 1 ? '' : 's'}
        </span>
      </p>
      <div className="adm-sales__plot">
        {bars.map((bar) => (
          <button
            key={bar.day}
            type="button"
            className={`adm-sales__col${bar.day === shown.day ? ' adm-sales__col--picked' : ''}`}
            onClick={() => setPicked(bar.day)}
            onMouseEnter={() => setPicked(bar.day)}
            aria-label={`${bar.weekday} ${bar.date}: ${formatTakaBd(bar.total)}, ${bar.orderCount} order${bar.orderCount === 1 ? '' : 's'}`}
            aria-pressed={bar.day === shown.day}
            data-testid="sales-bar"
            data-day={bar.day}
            data-total={bar.total}
          >
            <span className="adm-sales__track">
              <span
                className={`adm-sales__bar${bar.isToday ? ' adm-sales__bar--today' : ''}${bar.total === 0 ? ' adm-sales__bar--zero' : ''}`}
                style={{ height: `${bar.heightPct}%` }}
              />
            </span>
            <span className="adm-sales__day">{bar.isToday ? 'Today' : bar.weekday}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
