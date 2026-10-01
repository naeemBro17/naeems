import { useEffect, useState } from 'react';
import { useUrlParam } from '../../hooks/useUrlParams';
import {
  ACTIVITY_PAGE_SIZE,
  ACTIVITY_TYPES,
  fetchActivityLog,
  fetchActivityPeople,
  formatDhakaTime,
} from '../../lib/staff';
import type { ActivityLogEntry } from '../../types';
import { AdminPageHeader } from './ui/AdminUi';

/** "from → to" lines for an entry's details, shortest first. */
function detailLines(details: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const [field, value] of Object.entries(details)) {
    if (value && typeof value === 'object' && 'from' in value && 'to' in value) {
      const change = value as { from: unknown; to: unknown };
      lines.push(`${field.replace(/_/g, ' ')}: ${show(change.from)} → ${show(change.to)}`);
    }
  }
  return lines;
}

function show(value: unknown): string {
  if (value === null || value === undefined || value === '') return '(empty)';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * Admin → Activity Log (Super Admin only, Batch 24 Part 2). Who did what,
 * when (Bangladesh time). Written by the database itself; nobody can edit
 * or delete an entry. Filters and the page number live in the URL, so Back
 * from anywhere returns to the same view.
 */
export function ActivityLogTab() {
  const [person, setPerson] = useUrlParam<string>('lperson', '');
  const [type, setType] = useUrlParam<string>('ltype', '');
  const [from, setFrom] = useUrlParam<string>('lfrom', '');
  const [to, setTo] = useUrlParam<string>('lto', '');
  const [search, setSearch] = useUrlParam<string>('lq', '');
  const [pageParam, setPageParam] = useUrlParam<string>('lpage', '1');
  const page = Math.max(1, Number.parseInt(pageParam, 10) || 1);

  const [people, setPeople] = useState<string[]>([]);
  const [rows, setRows] = useState<ActivityLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState(search);

  useEffect(() => {
    void fetchActivityPeople().then(setPeople);
  }, []);

  // Typing updates the URL after a short pause, not on every key.
  useEffect(() => {
    if (searchInput === search) return;
    const timer = window.setTimeout(() => {
      setSearch(searchInput);
      setPageParam('1');
    }, 350);
    return () => window.clearTimeout(timer);
  }, [searchInput, search, setSearch, setPageParam]);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    void fetchActivityLog({ person, type, from, to, search, page }).then((result) => {
      if (!active) return;
      setRows(result.rows);
      setTotal(result.total);
      setError(result.error);
      setIsLoading(false);
    });
    return () => {
      active = false;
    };
  }, [person, type, from, to, search, page]);

  const pageCount = Math.max(1, Math.ceil(total / ACTIVITY_PAGE_SIZE));
  const setFilter = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setPageParam('1');
  };

  return (
    <section aria-label="Activity Log">
      <AdminPageHeader title="Activity Log" />

      <div className="admin-filter-bar activity-filters">
        <input
          type="search"
          className="form-input admin-filter-bar__search"
          placeholder="Search order number or product name..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          aria-label="Search by order number or product name"
        />
        <select
          className="form-input form-select"
          value={person}
          onChange={(e) => setFilter(setPerson)(e.target.value)}
          aria-label="Filter by person"
        >
          <option value="">Everyone</option>
          {people.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select
          className="form-input form-select"
          value={type}
          onChange={(e) => setFilter(setType)(e.target.value)}
          aria-label="Filter by type of action"
        >
          <option value="">All actions</option>
          {ACTIVITY_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <label className="activity-filters__date">
          <span>From</span>
          <input
            type="date"
            className="form-input"
            value={from}
            onChange={(e) => setFilter(setFrom)(e.target.value)}
            aria-label="From date"
          />
        </label>
        <label className="activity-filters__date">
          <span>To</span>
          <input
            type="date"
            className="form-input"
            value={to}
            onChange={(e) => setFilter(setTo)(e.target.value)}
            aria-label="To date"
          />
        </label>
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {isLoading ? (
        <div className="full-screen-center" style={{ minHeight: 120 }}>
          <span className="spinner spinner--large" aria-hidden="true" />
        </div>
      ) : rows.length === 0 ? (
        <p className="admin-panel__description">Nothing recorded for these filters.</p>
      ) : (
        <ul className="admin-list activity-list">
          {rows.map((row) => (
            <li key={row.id} className="activity-row" data-action={row.action}>
              <div className="activity-row__top">
                <span className="activity-row__who">{row.actor_username}</span>
                <span className="activity-row__when">{formatDhakaTime(row.created_at)}</span>
              </div>
              <p className="activity-row__summary">{row.summary}</p>
              {detailLines(row.details).map((line) => (
                <p key={line} className="activity-row__detail">
                  {line}
                </p>
              ))}
            </li>
          ))}
        </ul>
      )}

      {pageCount > 1 && (
        <nav className="activity-pager" aria-label="Pages">
          <button
            type="button"
            className="button button--secondary button--small"
            disabled={page <= 1}
            onClick={() => setPageParam(String(page - 1))}
          >
            Newer
          </button>
          <span>
            Page {page} of {pageCount}
          </span>
          <button
            type="button"
            className="button button--secondary button--small"
            disabled={page >= pageCount}
            onClick={() => setPageParam(String(page + 1))}
          >
            Older
          </button>
        </nav>
      )}
    </section>
  );
}
