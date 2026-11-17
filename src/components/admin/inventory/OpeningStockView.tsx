import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { useToast } from '../../../hooks/useToast';
import { useSafetyLock } from '../../../contexts/SafetyLockContext';
import { useProducts } from '../../../contexts/ProductContext';
import { takaExact } from '../../../lib/payouts';
import {
  confirmOpening,
  dhakaToday,
  fetchLot,
  fetchOpeningLotId,
  fetchStockUnits,
  logOpeningUpload,
  monthYear,
  undoOpening,
} from '../../../lib/inventory/api';
import {
  confirmPayload,
  openingLandedUnit,
  openingTotals,
  openingUnits,
  readOpeningSheet,
  type OpeningIssue,
  type OpeningPreview,
} from '../../../lib/inventory/opening';
import { buildOpeningTemplate, readOpeningFile, saveBlob } from '../../../lib/inventory/xlsx';
import type { LotDetail, StockUnit } from '../../../lib/inventory/types';
import { AdminPageHeader, EmptyState, SkeletonRows } from '../ui/AdminUi';
import { formatLotDate, sourceLabel, taka2 } from './invFormat';

const SHOWN_ROWS = 30;

function IssueList({ title, issues, tone, testId }: { title: string; issues: OpeningIssue[]; tone: 'bad' | 'warn'; testId: string }) {
  if (issues.length === 0) return null;
  return (
    <details className={`inv-issues inv-issues--${tone}`} open={tone === 'bad'} data-testid={testId}>
      <summary>
        {title}: {issues.length}
      </summary>
      <ul>
        {issues.map((i) => (
          <li key={`${i.row}-${i.message}`}>
            Row {i.row} · {i.label} — {i.message}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Batch 38 Part 4: opening stock. Download the template, fill it, upload
 * it, read the preview (nothing is saved), then Confirm — which creates the
 * one opening lot L-000. Undo is behind the Safety Lock and only while
 * Inventory mode is Off. Batch 45: no weight % — weight is not part of
 * product cost; L-000 is edited and deleted like any lot.
 */

/** Batch 45: the opening stock's landed cost is its buy price (0% added). */
const NO_WEIGHT = 0n;
export function OpeningStockView({ onBack, onOpenLot }: { onBack: () => void; onOpenLot: (id: string) => void }) {
  const { showToast } = useToast();
  const { openUntil } = useSafetyLock();
  const { settings } = useProducts();
  const [units, setUnits] = useState<StockUnit[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [opening, setOpening] = useState<LotDetail | null>(null);
  const [startDate, setStartDate] = useState(dhakaToday());
  const [draft, setDraft] = useState<{ fileName: string; preview: OpeningPreview } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [isReading, setIsReading] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [askUndo, setAskUndo] = useState(false);
  const [isUndoing, setIsUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  const modeOn = settings.inventory_mode === 'true';

  const load = useCallback(async () => {
    const [stock, openingId] = await Promise.all([fetchStockUnits(), fetchOpeningLotId()]);
    if (stock.kind !== 'ready') {
      setLoadError(stock.kind === 'error' ? stock.message : 'The Batch 38 database step has not been run.');
      return;
    }
    setUnits(stock.data);
    if (openingId) {
      const lot = await fetchLot(openingId);
      setOpening(lot.kind === 'ready' ? lot.data : null);
    } else {
      setOpening(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(() => (draft ? openingTotals(draft.preview.rows, NO_WEIGHT) : null), [draft]);

  const download = async () => {
    if (!units) return;
    setIsDownloading(true);
    try {
      saveBlob(await buildOpeningTemplate(units), `opening-stock-template-${dhakaToday()}.xlsx`);
    } catch {
      showToast('Could not make the template. Please try again.', 'error');
    }
    setIsDownloading(false);
  };

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !units) return;
    setFileError(null);
    setConfirmError(null);
    setIsReading(true);
    try {
      const sheet = await readOpeningFile(file);
      const preview = readOpeningSheet(sheet, units, dhakaToday());
      // Re-uploading replaces the draft.
      setDraft({ fileName: file.name, preview });
      setShowAll(false);
      void logOpeningUpload(file.name, preview.totalRows, preview.rows.length, preview.problemCount);
    } catch (error) {
      setDraft(null);
      setFileError(error instanceof Error ? error.message : 'Could not read the file.');
    }
    setIsReading(false);
  };

  const confirm = async () => {
    if (!draft) return;
    setIsConfirming(true);
    setConfirmError(null);
    const answer = await confirmOpening(startDate, '0', confirmPayload(draft.preview.rows), draft.fileName);
    setIsConfirming(false);
    if (!answer.ok) {
      setConfirmError(answer.error ?? 'Could not save the opening stock.');
      return;
    }
    showToast('Opening stock saved (L-000)');
    setDraft(null);
    await load();
  };

  const undo = async () => {
    setIsUndoing(true);
    setUndoError(null);
    const answer = await undoOpening();
    setIsUndoing(false);
    if (!answer.ok) {
      setUndoError(answer.error ?? 'Could not undo.');
      return;
    }
    showToast('Opening stock removed');
    setAskUndo(false);
    await load();
  };

  if (loadError) {
    return (
      <section className="inv" aria-label="Opening stock">
        <AdminPageHeader title="Opening stock" onBack={onBack} />
        <EmptyState icon="alert" title="Could not load" hint={loadError} />
      </section>
    );
  }
  if (!units) {
    return (
      <section className="inv" aria-label="Opening stock">
        <AdminPageHeader title="Opening stock" onBack={onBack} />
        <SkeletonRows rows={4} thumb={false} />
      </section>
    );
  }

  if (opening) {
    const pieces = opening.lot_items.reduce((a, i) => a + i.qty, 0);
    const value = opening.lot_items.reduce((a, i) => a + Math.round(i.qty * Number(i.unit_price_bdt) * 100) + Number(i.alloc_other_paisa), 0);
    return (
      <section className="inv" aria-label="Opening stock">
        <AdminPageHeader title="Opening stock" onBack={onBack} />
        <div className="adm-ocard inv-stack" data-testid="inv-opening-saved">
          <p>
            <b>L-000</b> saved: {opening.lot_items.length} rows, {pieces} pieces, start date {formatLotDate(opening.lot_date)}.
          </p>
          <div className="inv-line inv-line--total">
            <span>Opening stock value</span>
            <span>{takaExact(value)}</span>
          </div>
          <button type="button" className="adm-btn adm-btn--ghost" onClick={() => onOpenLot(opening.id)}>
            Open L-000
          </button>
        </div>
        <div className="adm-ocard inv-stack">
          <h2 className="adm-ocard__title">Undo opening stock</h2>
          <p className="inv-muted">
            Removes L-000 and its stock movements, so you can upload again. Only while Inventory mode is Off. (Deleting L-000 from its lot page works at any time.)
          </p>
          {modeOn ? (
            <p className="inv-error">Inventory mode is On: the opening stock can&apos;t be undone.</p>
          ) : !askUndo ? (
            <button type="button" className="adm-btn adm-btn--ghost adm-btn--danger-text" onClick={() => setAskUndo(true)} data-testid="inv-undo-opening">
              Undo opening stock
            </button>
          ) : (
            <div className="inv-stack inv-danger-box">
              <p>Remove the opening stock (L-000, {pieces} pieces)?</p>
              {!openUntil && (
                <p className="inv-muted">First turn off the Safety Lock: Settings → Safety Locks (it asks your password).</p>
              )}
              {undoError && <p className="inv-error">{undoError}</p>}
              <div className="inv-actions">
                <button type="button" className="adm-btn adm-btn--danger" disabled={!openUntil || isUndoing} onClick={() => void undo()} data-testid="inv-undo-confirm">
                  {isUndoing ? <span className="spinner" aria-hidden="true" /> : 'Remove opening stock'}
                </button>
                <button type="button" className="adm-btn adm-btn--ghost" onClick={() => setAskUndo(false)}>
                  Keep it
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
    );
  }

  const preview = draft?.preview ?? null;
  const canConfirm = preview !== null && preview.problemCount === 0 && preview.rows.length > 0 && startDate !== '';

  return (
    <section className="inv" aria-label="Opening stock">
      <AdminPageHeader title="Opening stock" onBack={onBack} />

      <div className="adm-ocard inv-stack">
        <h2 className="adm-ocard__title">1. Download the template</h2>
        <p className="inv-muted">
          One row per product (and per size). Fill buy price, pieces, expiry and source. The first sheet explains how.
        </p>
        <button type="button" className="adm-btn adm-btn--ghost" onClick={() => void download()} disabled={isDownloading} data-testid="inv-download-template">
          {isDownloading ? <span className="spinner" aria-hidden="true" /> : 'Download template (.xlsx)'}
        </button>
      </div>

      <div className="adm-ocard inv-stack">
        <h2 className="adm-ocard__title">2. Start date and file</h2>
        <label className="form-field">
          <span className="form-label">Opening stock start date</span>
          <input className="form-input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} aria-label="Start date" />
        </label>
        <label className="form-field">
          <span className="form-label">Filled file (.xlsx)</span>
          <input
            className="form-input"
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => void upload(e)}
            disabled={isReading}
            aria-label="Upload opening stock file"
            data-testid="inv-upload"
          />
        </label>
        {isReading && <p className="inv-muted">Reading the file…</p>}
        {fileError && (
          <p className="inv-error" role="alert" data-testid="inv-file-error">
            {fileError}
          </p>
        )}
        <p className="inv-muted">Nothing is saved until you tap Confirm. Uploading again replaces this preview.</p>
      </div>

      {preview && totals && (
        <div className="adm-ocard inv-stack" data-testid="inv-opening-preview">
          <h2 className="adm-ocard__title">3. Preview — {draft?.fileName}</h2>
          <div className="inv-counts">
            <span data-testid="inv-count-ready">
              Ready <b>{preview.rows.length}</b>
            </span>
            <span className={preview.problemCount > 0 ? 'inv-bad' : ''} data-testid="inv-count-fix">
              To fix <b>{preview.problemCount}</b>
            </span>
            <span>
              Skipped (empty) <b>{preview.skipped}</b>
            </span>
          </div>
          <IssueList title="Missing price or pieces (must fix)" issues={preview.problems.missing} tone="bad" testId="inv-issues-missing" />
          <IssueList title="Unknown product_key (must fix)" issues={preview.problems.unknown_key} tone="bad" testId="inv-issues-unknown" />
          <IssueList title="Zero or negative numbers (must fix)" issues={preview.problems.not_positive} tone="bad" testId="inv-issues-negative" />
          <IssueList title="Values not understood (must fix)" issues={preview.problems.bad_value} tone="bad" testId="inv-issues-bad" />
          <IssueList title="Buy price higher than selling price (warning)" issues={preview.warnings.price_above_selling} tone="warn" testId="inv-warn-price" />
          <IssueList title="Expiry already passed (warning, still allowed)" issues={preview.warnings.expired} tone="warn" testId="inv-warn-expired" />
          {preview.merged.length > 0 && (
            <details className="inv-issues inv-issues--warn" data-testid="inv-merged">
              <summary>Same product + expiry, merged: {preview.merged.length}</summary>
              <ul>
                {preview.merged.map((m) => (
                  <li key={`${m.label}-${m.expiry ?? ''}-${m.rows.join(',')}`}>
                    Rows {m.rows.join(', ')} · {m.label} · {monthYear(m.expiry)}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="inv-line">
            <span>Total units (pieces)</span>
            <span data-testid="inv-total-pieces">{totals.pieces}</span>
          </div>
          <div className="inv-line">
            <span>Buy price</span>
            <span>{takaExact(Number(totals.buyPaisa))}</span>
          </div>
          <div className="inv-line inv-line--total">
            <span>Opening stock value</span>
            <span data-testid="inv-total-value">{takaExact(Number(totals.valuePaisa))}</span>
          </div>

          <div className="inv-stack">
            {(showAll ? preview.rows : preview.rows.slice(0, SHOWN_ROWS)).map((r) => (
              <div key={`${r.key}-${r.expiry ?? ''}-${r.source}`} className="inv-item">
                <span className="inv-item__name">{r.label}</span>
                <span className="inv-muted">
                  {(r.packSize ?? 1) > 1
                    ? `${r.pieces} packs${r.extraUnits ? ` + ${r.extraUnits} loose` : ''} = ${openingUnits(r)} units`
                    : `${openingUnits(r)} pcs`}{' '}
                  · {sourceLabel(r.source)} · expiry {monthYear(r.expiry)}
                </span>
                <div className="inv-line">
                  <span>
                    Buy {taka2(Number(r.priceE4) / 10000)}
                    {(r.packSize ?? 1) > 1 ? ' per pack' : ''} → landed per {(r.packSize ?? 1) > 1 ? 'unit' : 'piece'}
                  </span>
                  <span>{taka2(openingLandedUnit(r, NO_WEIGHT))}</span>
                </div>
              </div>
            ))}
            {!showAll && preview.rows.length > SHOWN_ROWS && (
              <button type="button" className="adm-btn adm-btn--ghost" onClick={() => setShowAll(true)}>
                Show all {preview.rows.length} rows
              </button>
            )}
          </div>

          {preview.problemCount > 0 && <p className="inv-error">Fix the rows marked &quot;must fix&quot; in the file and upload it again.</p>}
          {confirmError && (
            <p className="inv-error" role="alert" data-testid="inv-confirm-error">
              {confirmError}
            </p>
          )}
          <button type="button" className="adm-btn adm-btn--primary adm-btn--lg" disabled={!canConfirm || isConfirming} onClick={() => void confirm()} data-testid="inv-confirm-opening">
            {isConfirming ? <span className="spinner" aria-hidden="true" /> : 'Confirm opening stock'}
          </button>
        </div>
      )}
    </section>
  );
}
