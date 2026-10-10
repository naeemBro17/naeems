import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { useProducts } from '../../../contexts/ProductContext';
import { useToast } from '../../../hooks/useToast';
import { supabase } from '../../../lib/supabase';
import { fetchModeCheck, fetchStockUnits, packsText, setInventoryMode, unitName } from '../../../lib/inventory/api';
import type { ModeCheck, StockUnit } from '../../../lib/inventory/types';
import type { LoadState } from '../../../lib/payouts';
import { AdminPageHeader, EmptyState, SkeletonRows } from '../ui/AdminUi';
import { ConfirmSheet } from '../OrderActionCards';

/** Whole packs the shop will show once the lots decide. */
export function lotPacks(unit: Pick<StockUnit, 'lot_pieces_left' | 'pack_size'>): number {
  return Math.max(0, Math.floor(unit.lot_pieces_left / Math.max(1, unit.pack_size)));
}

/** On sale today, but no whole pack in any lot → "Sold out" once On. */
export function willSellOut(unit: StockUnit): boolean {
  const onSaleNow = unit.is_active && (unit.site_stock === null ? unit.in_stock : unit.site_stock > 0);
  return onSaleNow && lotPacks(unit) === 0;
}

/**
 * Batch 39 Part 4: before Inventory mode is turned On — the check screen —
 * and the switch itself. On needs the opening stock (L-000) confirmed and
 * the Super Admin's password typed again (the database checks both).
 * Off is a careful action with a clear warning. Both are written to the
 * Activity Log.
 */
export function ModeView({ onBack }: { onBack: () => void }) {
  const { isAdmin, session } = useAuth();
  const { refetch } = useProducts();
  const { showToast } = useToast();
  const [check, setCheck] = useState<LoadState<ModeCheck> | null>(null);
  const [units, setUnits] = useState<StockUnit[]>([]);
  const [takeOpen, setTakeOpen] = useState(true);
  const [sheet, setSheet] = useState<'on' | 'off' | null>(null);
  const [password, setPassword] = useState('');
  const [sheetError, setSheetError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [answer, stock] = await Promise.all([fetchModeCheck(), fetchStockUnits()]);
    setCheck(answer);
    setUnits(stock.kind === 'ready' ? stock.data : []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const differences = useMemo(
    () => units.filter((u) => u.is_active && (u.site_stock === null ? (u.in_stock ? 1 : 0) !== lotPacks(u) : u.site_stock !== lotPacks(u))),
    [units]
  );
  const sellOut = useMemo(() => units.filter(willSellOut), [units]);
  const packed = useMemo(() => units.filter((u) => u.pack_size > 1), [units]);

  const data = check?.kind === 'ready' ? check.data : null;

  const confirm = async () => {
    if (!sheet) return;
    setSheetError(null);
    const email = session?.user.email;
    if (!email || password === '') {
      setSheetError('Type your password.');
      return;
    }
    // The same re-confirmation as the Safety Lock: sign in again; the
    // database accepts the switch only within 5 minutes of it.
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
    if (authError) {
      setSheetError('Password is incorrect.');
      return;
    }
    const answer = await setInventoryMode(sheet === 'on', takeOpen);
    if (!answer.ok) {
      setSheetError(answer.error ?? 'Could not change Inventory mode.');
      return;
    }
    setSheet(null);
    setPassword('');
    showToast(sheet === 'on' ? 'Inventory mode is On: stock numbers now come from lots' : 'Inventory mode is Off');
    await refetch();
    await load();
  };

  const openSheet = (which: 'on' | 'off') => {
    setPassword('');
    setSheetError(null);
    setSheet(which);
  };

  if (check === null) {
    return (
      <section className="inv" aria-label="Inventory mode">
        <AdminPageHeader title="Inventory mode" onBack={onBack} />
        <SkeletonRows rows={5} thumb={false} />
      </section>
    );
  }
  if (!data) {
    return (
      <section className="inv" aria-label="Inventory mode">
        <AdminPageHeader title="Inventory mode" onBack={onBack} />
        <EmptyState icon="alert" title="Could not load" hint={check.kind === 'error' ? check.message : 'The Batch 39 database step has not been run.'} />
      </section>
    );
  }

  const turnOn =
    !data.mode_on && isAdmin ? (
      <button type="button" className="adm-btn adm-btn--primary" disabled={!data.opening_confirmed} onClick={() => openSheet('on')} data-testid="inv-mode-turn-on">
        Turn On
      </button>
    ) : undefined;

  return (
    <section className="inv" aria-label="Inventory mode">
      <AdminPageHeader title="Inventory mode" onBack={onBack} primary={turnOn} />

      <div className="adm-ocard inv-stack" data-testid="inv-mode-status">
        <p className="inv-mode__title">
          Inventory mode: <b>{data.mode_on ? 'On' : 'Off'}</b>
        </p>
        <p className="inv-muted">
          {data.mode_on
            ? 'Every sale takes stock from lots (earliest expiry first) and the shop’s stock numbers come from the lots.'
            : 'When On, every sale takes stock from lots (earliest expiry first), every order gets a real cost and profit, and the shop’s stock numbers come from the lots.'}
        </p>
        <div className="inv-line">
          <span>Opening stock (L-000)</span>
          <span className={data.opening_confirmed ? 'inv-ok' : 'inv-bad'} data-testid="inv-mode-opening">
            {data.opening_confirmed ? 'Confirmed' : 'Not confirmed yet'}
          </span>
        </div>
        {!data.opening_confirmed && (
          <p className="inv-muted">Upload and confirm your opening stock first (Inventory → Opening stock). Until then the switch stays Off.</p>
        )}
        {!isAdmin && <p className="inv-muted">Only the Super Admin can turn Inventory mode On or Off.</p>}
      </div>

      {!data.mode_on && (
        <>
          <h2 className="inv-section">Check before turning On</h2>
          <div className="adm-ocard inv-stack" data-testid="inv-mode-compare">
            <div className="inv-line">
              <span>Shop stock different from lots</span>
              <span>{differences.length}</span>
            </div>
            {differences.length > 0 && (
              <details>
                <summary className="inv-muted">Show them</summary>
                <ul className="inv-check-list">
                  {differences.map((u) => (
                    <li key={`${u.product_id}:${u.variant_id ?? ''}`}>
                      {unitName(u)} — shop {u.site_stock === null ? (u.in_stock ? 'in stock (not counted)' : 'out of stock') : u.site_stock}, lots{' '}
                      {lotPacks(u)}
                      {u.pack_size > 1 ? ` packs (${u.lot_pieces_left} ${u.stock_unit})` : ''}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>

          <div className="adm-ocard inv-stack" data-testid="inv-mode-sellout">
            <h3 className="adm-ocard__title">These will show Sold out ({sellOut.length})</h3>
            <p className="inv-muted">On sale today, but no whole pack in any lot.</p>
            {sellOut.length === 0 ? (
              <p className="inv-ok">None</p>
            ) : (
              <ul className="inv-check-list">
                {sellOut.map((u) => (
                  <li key={`${u.product_id}:${u.variant_id ?? ''}`}>{unitName(u)}</li>
                ))}
              </ul>
            )}
          </div>

          <div className="adm-ocard inv-stack" data-testid="inv-mode-packs">
            <h3 className="adm-ocard__title">Pack size not 1 ({packed.length})</h3>
            <p className="inv-muted">Double-check these: the shop sells whole packs of this many units.</p>
            {packed.length === 0 ? (
              <p className="inv-muted">None — every product is counted in single pieces.</p>
            ) : (
              <ul className="inv-check-list">
                {packed.map((u) => (
                  <li key={`${u.product_id}:${u.variant_id ?? ''}`}>
                    {unitName(u)} — {u.pack_size} {u.stock_unit} per pack; in lots: {packsText(u.lot_pieces_left, u.stock_unit, u.pack_size)}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="adm-ocard inv-stack" data-testid="inv-mode-open-orders">
            <h3 className="adm-ocard__title">Open orders placed before ({data.open_orders.length})</h3>
            {data.open_orders.length === 0 ? (
              <p className="inv-muted">None.</p>
            ) : (
              <>
                <p className="inv-muted">
                  Processing or Confirmed orders whose goods are still on your shelf. If your opening count included their goods,
                  they should take their stock from lots when you turn On.
                </p>
                <ul className="inv-check-list">
                  {data.open_orders.map((o) => (
                    <li key={o.order_number}>
                      {o.order_number} · {o.status === 'pending' ? 'Processing' : 'Confirmed'} · {o.units} item{o.units === 1 ? '' : 's'}
                    </li>
                  ))}
                </ul>
                <label className="inv-check">
                  <input type="checkbox" checked={takeOpen} onChange={(e) => setTakeOpen(e.target.checked)} data-testid="inv-mode-take-open" />
                  Take their stock from lots when I turn On
                </label>
              </>
            )}
          </div>
        </>
      )}

      {data.mode_on && isAdmin && (
        <section className="adm-ocard adm-careful" aria-label="Careful actions" data-testid="careful-actions">
          <h2 className="adm-careful__title">Careful actions</h2>
          <p className="adm-ocard__muted">You will be asked for your password.</p>
          <ul className="adm-careful__list">
            <li className="adm-careful__row">
              <span className="adm-careful__text">
                <span className="adm-careful__name">Turn Inventory mode Off</span>
                <span className="adm-careful__explain">Sales stop taking stock from lots; profit will be missing for orders while Off.</span>
              </span>
              <button type="button" className="adm-btn adm-btn--sm adm-careful__btn adm-careful__btn--red" onClick={() => openSheet('off')} data-testid="careful-inventory-off">
                Turn Off…
              </button>
            </li>
          </ul>
        </section>
      )}

      <ConfirmSheet
        isOpen={sheet !== null}
        title={sheet === 'on' ? 'Turn Inventory mode On?' : 'Turn Inventory mode Off?'}
        warning={
          sheet === 'off'
            ? 'Sales will stop taking stock from lots; profit will be missing for orders while Off. The shop’s stock numbers stay at their last value.'
            : sellOut.length > 0
              ? `${sellOut.length} product${sellOut.length === 1 ? '' : 's'} will show Sold out.`
              : null
        }
        keepLabel="Keep it as it is"
        confirmLabel={sheet === 'on' ? 'Turn On' : 'Turn Off'}
        danger={sheet === 'off'}
        onConfirm={confirm}
        onClose={() => setSheet(null)}
      >
        <p className="adm-csheet__text">
          {sheet === 'on'
            ? `From now on the shop's stock numbers come from the lots.${takeOpen && data.open_orders.length > 0 ? ` ${data.open_orders.length} open order${data.open_orders.length === 1 ? '' : 's'} take${data.open_orders.length === 1 ? 's' : ''} their stock now.` : ''}`
            : 'You can turn it On again later.'}
        </p>
        <label className="adm-csheet__type">
          <span>Type your password to confirm</span>
          <input
            className="form-input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid="inv-mode-password"
          />
        </label>
        {sheetError && (
          <p className="inv-error" role="alert" data-testid="inv-mode-error">
            {sheetError}
          </p>
        )}
      </ConfirmSheet>
    </section>
  );
}
