import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { useProducts } from '../../../contexts/ProductContext';
import { useToast } from '../../../hooks/useToast';
import { supabase } from '../../../lib/supabase';
import { dhakaToday, monthYear } from '../../../lib/inventory/api';
import { fetchWriteOffs, writeOff } from '../../../lib/money/api';
import { WRITE_OFF_REASONS, dayText, moneyText, writeOffReasonLabel } from '../../../lib/money/format';
import type { WriteOff, WriteOffReason } from '../../../lib/money/types';
import { ConfirmSheet } from '../OrderActionCards';

interface LotRow {
  id: string;
  variant_id: string | null;
  qty_remaining: number;
  expiry_date: string | null;
  landed_unit_cost_bdt: number;
  code: string;
}

/**
 * Batch 41 Part 5: "Remove stock" on a product — units that leave without a
 * sale (expired, damaged, gift / sample, own use, lost, count difference).
 * They leave the lot rows that expire first (or a lot picked here) at their
 * landed cost, which is a loss in that day's profit (its own line, not an
 * expense). Only while Inventory mode is On; only "View profit & costs".
 */
export function RemoveStockPanel({ productId }: { productId: string }) {
  const { can } = useAuth();
  const { settings, allVariants } = useProducts();
  const { showToast } = useToast();
  const allowed = can('view_profit_costs');
  const modeOn = settings.inventory_mode === 'true';
  const options = useMemo(() => allVariants.filter((v) => v.product_id === productId), [allVariants, productId]);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [lots, setLots] = useState<LotRow[]>([]);
  const [units, setUnits] = useState('1');
  const [reason, setReason] = useState<WriteOffReason>('expired');
  const [lotItemId, setLotItemId] = useState('');
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [history, setHistory] = useState<WriteOff[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (options.length > 0 && variantId === null) setVariantId(options[0].id);
  }, [options, variantId]);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('lot_items')
      .select('id, variant_id, qty_remaining, expiry_date, landed_unit_cost_bdt, lots(code)')
      .eq('product_id', productId)
      .gt('qty_remaining', 0)
      .order('expiry_date', { ascending: true, nullsFirst: false });
    setLots(
      ((data ?? []) as Record<string, unknown>[]).map((r) => ({
        id: r.id as string,
        variant_id: (r.variant_id as string | null) ?? null,
        qty_remaining: Number(r.qty_remaining),
        expiry_date: (r.expiry_date as string | null) ?? null,
        landed_unit_cost_bdt: Number(r.landed_unit_cost_bdt),
        code: ((r.lots as { code?: string } | null)?.code ?? '') as string,
      }))
    );
    const done = await fetchWriteOffs({ from: '2000-01-01', to: dhakaToday(), productId });
    setHistory(done.kind === 'ready' ? done.data.slice(0, 10) : []);
  }, [productId]);

  useEffect(() => {
    if (allowed && open) void load();
  }, [allowed, open, load]);

  if (!allowed) return null;

  const mine = lots.filter((l) => l.variant_id === (options.length > 0 ? variantId : null));
  const available = mine.reduce((s, l) => s + l.qty_remaining, 0);
  const count = Number(units);
  const valid = Number.isInteger(count) && count > 0 && count <= (lotItemId ? (mine.find((l) => l.id === lotItemId)?.qty_remaining ?? 0) : available);

  const run = async () => {
    const answer = await writeOff({
      productId,
      variantId: options.length > 0 ? variantId : null,
      units: count,
      reason,
      note,
      lotItemId: lotItemId || null,
    });
    if (!answer.ok || !answer.data) {
      showToast(answer.error ?? 'Could not remove the stock', 'error');
      return;
    }
    setConfirm(false);
    showToast(`Removed ${count} — loss ${moneyText(answer.data.cost_bdt)} at landed cost`);
    setUnits('1');
    setNote('');
    setLotItemId('');
    await load();
  };

  return (
    <section className="admin-panel" aria-label="Remove stock" data-testid="remove-stock-panel">
      <h3 className="admin-panel__title">Remove stock</h3>
      <p className="admin-panel__description">
        For stock that leaves without a sale: expired, damaged, a gift or sample, your own use, lost, or a count difference. The units leave the
        lots that expire first, at their landed cost, which counts as a loss in profit (its own line, not an expense).
      </p>
      {!modeOn ? (
        <p className="inv-muted" data-testid="remove-stock-off">
          Works only while Inventory mode is On: then stock comes from lots, so the units can leave the right lot at the right cost. Today the
          shop&apos;s stock number is typed by hand — change it in the stock field above.
        </p>
      ) : !open ? (
        <button type="button" className="adm-btn" onClick={() => setOpen(true)} data-testid="remove-stock-open">
          Remove stock…
        </button>
      ) : (
        <div className="inv-stack">
          {options.length > 0 && (
            <label className="form-field">
              <span className="form-label">Option</span>
              <select className="form-input" value={variantId ?? ''} onChange={(e) => setVariantId(e.target.value)} aria-label="Option">
                {options.map((v) => (
                  <option key={v.id} value={v.id}>
                    {[v.region, v.size].filter((s) => s && s.trim() !== '').join(' · ') || 'Option'}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="inv-muted">In lots now: {available} units.</p>
          <div className="inv-fields">
            <label className="form-field">
              <span className="form-label">Units</span>
              <input className="form-input" inputMode="numeric" value={units} onChange={(e) => setUnits(e.target.value)} aria-label="Units to remove" />
            </label>
            <label className="form-field">
              <span className="form-label">Reason</span>
              <select className="form-input" value={reason} onChange={(e) => setReason(e.target.value as WriteOffReason)} aria-label="Reason">
                {WRITE_OFF_REASONS.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="form-field">
            <span className="form-label">From</span>
            <select className="form-input" value={lotItemId} onChange={(e) => setLotItemId(e.target.value)} aria-label="From lot">
              <option value="">Earliest expiry first</option>
              {mine.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.code} · {l.qty_remaining} left · expires {monthYear(l.expiry_date)}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field">
            <span className="form-label">Note</span>
            <input className="form-input" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
          </label>
          <div className="inv-actions">
            <button type="button" className="adm-btn" onClick={() => setOpen(false)}>
              Close
            </button>
            <button type="button" className="adm-btn adm-btn--danger" onClick={() => setConfirm(true)} disabled={!valid} data-testid="remove-stock-go">
              Remove {Number.isInteger(count) && count > 0 ? count : ''} units…
            </button>
          </div>
          {history.length > 0 && (
            <div className="inv-stack">
              <p className="inv-muted">Removed before</p>
              {history.map((w) => (
                <div key={w.id} className="inv-line">
                  <span>
                    {dayText(w.write_date)} · {w.units} · {writeOffReasonLabel(w.reason)}
                  </span>
                  <span>{moneyText(w.cost_bdt)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <ConfirmSheet
        isOpen={confirm}
        title={`Remove ${count} units (${writeOffReasonLabel(reason).toLowerCase()})?`}
        typeToConfirm={String(count)}
        keepLabel="Keep"
        confirmLabel="Remove stock"
        danger
        onConfirm={run}
        onClose={() => setConfirm(false)}
      >
        <p className="adm-csheet__text">They leave the lots and count as a loss at their landed cost today. Written to the Activity Log.</p>
      </ConfirmSheet>
    </section>
  );
}
