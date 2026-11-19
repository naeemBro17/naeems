import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AdminPageHeader, EmptyState, SkeletonRows } from './ui/AdminUi';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { ComboThumbs, ShareComboSheet, type ReadyCombo } from '../combo/ComboShare';
import { useComboLines } from '../../hooks/useComboLines';
import { useToast } from '../../hooks/useToast';
import { comboPath, comboTotals, comboUrl, deleteCombo, listCombos, type ComboListLoad, type ComboRow } from '../../lib/combos';
import { formatTakaBd } from '../../lib/adminNav';

function createdText(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Dhaka' });
}

/** One combo: thumbnails, name, count, today's total, date, actions. */
function ComboListRow({
  row,
  onShare,
  onDelete,
}: {
  row: ComboRow;
  onShare: (combo: ReadyCombo) => void;
  onDelete: (row: ComboRow) => void;
}) {
  const { showToast } = useToast();
  const lines = useComboLines(row.items);
  const totals = useMemo(() => comboTotals(lines), [lines]);
  const n = row.items.length;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(comboUrl(row.code));
      showToast('Link copied');
    } catch {
      showToast('Could not copy the link');
    }
  };

  return (
    <li className="adm-combo" data-testid="admin-combo-row">
      <div className="adm-combo__top">
        <ComboThumbs lines={lines} size="sm" />
        <div className="adm-combo__main">
          <Link to={comboPath(row.code)} className="adm-combo__name">
            {row.name}
          </Link>
          <p className="adm-combo__meta">
            {n} product{n === 1 ? '' : 's'} · <span className="adm-price">{formatTakaBd(totals.total)}</span> today ·{' '}
            {createdText(row.created_at)}
          </p>
        </div>
      </div>
      <div className="adm-combo__actions">
        <Link to={comboPath(row.code)} className="adm-btn adm-btn--ghost adm-btn--sm" data-testid="admin-combo-open">
          Open
        </Link>
        <button type="button" className="adm-btn adm-btn--ghost adm-btn--sm" onClick={() => void copy()} data-testid="admin-combo-copy">
          Copy link
        </button>
        <button
          type="button"
          className="adm-btn adm-btn--ghost adm-btn--sm"
          onClick={() =>
            onShare({ code: row.code, name: row.name, total: totals.total, productCount: n, previewSrc: row.preview_url })
          }
          data-testid="admin-combo-share"
        >
          Share
        </button>
        <button type="button" className="adm-btn adm-btn--ghost adm-btn--sm adm-combo__delete" onClick={() => onDelete(row)} data-testid="admin-combo-delete">
          Delete
        </button>
      </div>
    </li>
  );
}

/**
 * Admin → Combos (Batch 52 Part 3.5): every combo link made from the cart.
 * Links never expire unless deleted here.
 */
export function CombosTab() {
  const { showToast } = useToast();
  const [load, setLoad] = useState<ComboListLoad | null>(null);
  const [sharing, setSharing] = useState<ReadyCombo | null>(null);
  const [deleting, setDeleting] = useState<ComboRow | null>(null);

  const reload = useCallback(async () => {
    setLoad(await listCombos());
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <section aria-label="Combos" className="adm-combos">
      <AdminPageHeader title="Combos" subtitle="Product picks you shared as a link. Make one from your cart." />

      {load === null ? (
        <SkeletonRows rows={3} />
      ) : load.kind === 'missing' ? (
        <EmptyState icon="combos" title="Combos are not set up yet" hint="Run the Batch 52 database step (in the batch report), then come back." />
      ) : load.kind === 'error' ? (
        <EmptyState
          icon="alert"
          title="Could not load your combos"
          action={
            <button type="button" className="adm-btn adm-btn--ghost" onClick={() => void reload()}>
              Try again
            </button>
          }
        />
      ) : load.rows.length === 0 ? (
        <EmptyState
          icon="combos"
          title="No combos yet"
          hint="Add products to your cart, then tap Share as a combo."
        />
      ) : (
        <ul className="adm-combo-list" data-testid="admin-combo-list">
          {load.rows.map((row) => (
            <ComboListRow key={row.id} row={row} onShare={setSharing} onDelete={setDeleting} />
          ))}
        </ul>
      )}

      <ShareComboSheet combo={sharing} onClose={() => setSharing(null)} />
      <ConfirmDialog
        isOpen={deleting !== null}
        title="Delete this combo?"
        message="Its link will stop working."
        confirmLabel="Delete"
        danger
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          const ok = await deleteCombo(deleting);
          setDeleting(null);
          showToast(ok ? 'Combo deleted' : 'Could not delete the combo');
          await reload();
        }}
      />
    </section>
  );
}
