import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { dhakaToday } from '../../../lib/inventory/api';
import type { LoadState } from '../../../lib/payouts';
import { dayText } from '../../../lib/money/format';
import { buildWorkbook, downloadBlob, excelFileName, type ReportSheet } from '../../../lib/reports/excel';
import { presetRange, REPORT_PRESETS, shortMonth, type DateRange, type ReportPreset } from '../../../lib/reports/periods';
import { AdminPageHeader, ChipRow, EmptyState, SkeletonRows } from '../ui/AdminUi';
import { AdminIcon } from '../ui/AdminIcon';
import { useToast } from '../../../hooks/useToast';

const PRESET_IDS = new Set<string>(REPORT_PRESETS.map((p) => p.id));

/** The chosen dates live in the URL (?rp=&rf=&rt=), so Back and refresh keep them. */
export function useReportRange(defaultPreset: ReportPreset = 'month') {
  const [params, setParams] = useSearchParams();
  const today = dhakaToday();
  const raw = params.get('rp') ?? defaultPreset;
  const preset: ReportPreset = PRESET_IDS.has(raw) ? (raw as ReportPreset) : defaultPreset;
  const custom: DateRange = { from: params.get('rf') ?? `${today.slice(0, 7)}-01`, to: params.get('rt') ?? today };
  const range = presetRange(preset, today, custom);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(range.from) && /^\d{4}-\d{2}-\d{2}$/.test(range.to) && range.to >= range.from;

  const set = useCallback(
    (next: { preset?: ReportPreset; from?: string; to?: string }) => {
      const p = new URLSearchParams(params);
      if (next.preset) p.set('rp', next.preset);
      if (next.from !== undefined) p.set('rf', next.from);
      if (next.to !== undefined) p.set('rt', next.to);
      setParams(p, { replace: true });
    },
    [params, setParams]
  );

  return { preset, range, custom, valid, set, today };
}

/** Loads a report again whenever its dates change. */
export function useReport<T>(load: () => Promise<LoadState<T>>, deps: readonly unknown[]): { state: LoadState<T> | null; reload: () => void } {
  const [state, setState] = useState<LoadState<T> | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setState(null);
    void load().then((answer) => {
      if (alive) setState(answer);
    });
    return () => {
      alive = false;
    };
  }, [...deps, tick]);
  return { state, reload: () => setTick((n) => n + 1) };
}

interface ShellProps {
  title: string;
  onBack: () => void;
  /** Dates: shown when the report takes a date range. */
  period?: ReturnType<typeof useReportRange>;
  /** The sheets for "Download Excel" (the same rows as the screen). */
  sheets: readonly ReportSheet[] | null;
  /** Locked months inside the dates (first days, "2026-09-01"). */
  locked?: readonly string[];
  state: LoadState<unknown> | null;
  children: ReactNode;
  note?: ReactNode;
}

/**
 * Batch 42: the frame every report shares — Back, the date presets, Download
 * Excel (the one orange button) and Print / PDF, a lock note for locked
 * months, and the loading / error states.
 */
export function ReportShell({ title, onBack, period, sheets, locked = [], state, children, note }: ShellProps) {
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);

  const download = async () => {
    if (!sheets || sheets.length === 0) return;
    setBusy(true);
    try {
      const blob = await buildWorkbook(sheets);
      downloadBlob(blob, excelFileName(title, period?.range.from, period?.range.to));
    } catch {
      showToast('Could not make the Excel file. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const excel = (
    <button
      type="button"
      className="adm-btn adm-btn--primary rep-noprint"
      onClick={() => void download()}
      disabled={busy || !sheets || state?.kind !== 'ready'}
      data-testid="report-excel"
    >
      {busy ? 'Making file…' : 'Download Excel'}
    </button>
  );

  const rangeText = period ? (period.range.from === period.range.to ? dayText(period.range.from) : `${dayText(period.range.from)} – ${dayText(period.range.to)}`) : null;

  return (
    <section className="rep" aria-label={title}>
      <AdminPageHeader title={title} onBack={onBack} primary={excel} />
      <p className="rep-print-head">
        Naeem&apos;s Price Hub — {title}
        {rangeText ? ` — ${rangeText}` : ''}
      </p>

      <div className="rep-tools rep-noprint">
        {period && (
          <>
            <ChipRow
              label="Dates"
              active={period.preset}
              onSelect={(id) => period.set({ preset: id as ReportPreset })}
              chips={REPORT_PRESETS.map((p) => ({ id: p.id, label: p.label }))}
            />
            {period.preset === 'custom' && (
              <div className="inv-fields">
                <label className="form-field">
                  <span className="form-label">From</span>
                  <input className="form-input" type="date" value={period.custom.from} onChange={(e) => period.set({ from: e.target.value })} aria-label="From date" />
                </label>
                <label className="form-field">
                  <span className="form-label">To</span>
                  <input className="form-input" type="date" value={period.custom.to} onChange={(e) => period.set({ to: e.target.value })} aria-label="To date" />
                </label>
              </div>
            )}
            {!period.valid && <p className="inv-error">The end date is before the start date.</p>}
          </>
        )}
        <div className="rep-actions">
          {rangeText && <span className="inv-muted" data-testid="report-range">{rangeText}</span>}
          <button type="button" className="adm-btn adm-btn--ghost adm-btn--sm" onClick={() => window.print()} data-testid="report-print">
            Print / PDF
          </button>
        </div>
      </div>

      {locked.length > 0 && (
        <p className="rep-locked" data-testid="report-locked">
          <AdminIcon name="lock" />
          Locked: {locked.map((m) => shortMonth(m)).join(', ')} — nothing dated in {locked.length === 1 ? 'it' : 'them'} can change.
        </p>
      )}
      {note}

      {state === null ? (
        <SkeletonRows rows={6} thumb={false} />
      ) : state.kind !== 'ready' ? (
        <EmptyState icon="alert" title="Could not load" hint={state.kind === 'error' ? state.message : 'The Batch 42 database step has not been run.'} />
      ) : (
        children
      )}
    </section>
  );
}

export function useLockedSet(locked: readonly string[] | undefined): Set<string> {
  return useMemo(() => new Set((locked ?? []).map((m) => m.slice(0, 7))), [locked]);
}
