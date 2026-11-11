import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { useToast } from '../../../hooks/useToast';
import { dhakaToday } from '../../../lib/inventory/api';
import type { LoadState } from '../../../lib/payouts';
import { dayText } from '../../../lib/money/format';
import { confirmPassword, fetchLockChecklist, fetchLockedMonths, lockMonth, unlockMonth } from '../../../lib/reports/api';
import { lockableMonths, shortMonth } from '../../../lib/reports/periods';
import type { LockChecklist, LockedMonth } from '../../../lib/reports/types';
import { AdminPageHeader, EmptyState, SkeletonRows } from '../ui/AdminUi';
import { AdminIcon } from '../ui/AdminIcon';
import { ConfirmSheet } from '../OrderActionCards';

/**
 * Batch 42 Part 3.2–3.3: lock a month once it is checked. The checklist
 * first (books balance, no order still processing, Steadfast payouts
 * placed, the stock count done); then "Lock September 2026" (Careful
 * actions + password). After that nothing dated in the month can be added,
 * changed or deleted — the database refuses it; a correction is a new entry
 * dated today. Unlock: the Super Admin, with a reason (Activity Log).
 */
export function MonthLockView({ onBack }: { onBack: () => void }) {
  const { isAdmin, session } = useAuth();
  const { showToast } = useToast();
  const months = lockableMonths(dhakaToday());
  const [month, setMonth] = useState(months[0]);
  const [check, setCheck] = useState<LoadState<LockChecklist> | null>(null);
  const [locked, setLocked] = useState<LockedMonth[]>([]);
  const [sheet, setSheet] = useState<'lock' | 'unlock' | null>(null);
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('');
  const [sheetError, setSheetError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setCheck(null);
    const [c, l] = await Promise.all([fetchLockChecklist(month), fetchLockedMonths()]);
    setCheck(c);
    setLocked(l.kind === 'ready' ? l.data : []);
  }, [month]);

  useEffect(() => {
    void load();
  }, [load]);

  const data = check?.kind === 'ready' ? check.data : null;

  const openSheet = (which: 'lock' | 'unlock') => {
    setPassword('');
    setReason('');
    setSheetError(null);
    setSheet(which);
  };

  const confirm = async () => {
    if (!sheet || !data) return;
    setSheetError(null);
    if (sheet === 'unlock' && reason.trim().length < 5) {
      setSheetError('Write why you unlock it.');
      return;
    }
    const wrong = await confirmPassword(session?.user.email, password);
    if (wrong) {
      setSheetError(wrong);
      return;
    }
    const answer = sheet === 'lock' ? await lockMonth(month) : await unlockMonth(month, reason.trim());
    if (!answer.ok) {
      setSheetError(answer.error ?? 'Could not do that.');
      return;
    }
    setSheet(null);
    setPassword('');
    showToast(sheet === 'lock' ? `${data.label} is locked` : `${data.label} is unlocked`);
    await load();
  };

  return (
    <section className="inv money" aria-label="Lock a month">
      <AdminPageHeader title="Lock a month" onBack={onBack} />
      <p className="inv-muted">
        Once a month is checked, lock it: nothing dated in it (orders, payments, expenses, lots, write-offs, opening balances) can then be added,
        changed or deleted. A correction is a new entry dated today with the note &quot;correction for …&quot;.
      </p>

      <label className="form-field">
        <span className="form-label">Month</span>
        <select className="form-input" value={month} onChange={(e) => setMonth(e.target.value)} data-testid="lock-month">
          {months.map((m) => (
            <option key={m} value={m}>
              {shortMonth(m)}
              {locked.some((l) => l.month === m && l.locked) ? ' (locked)' : ''}
            </option>
          ))}
        </select>
      </label>

      {check === null ? (
        <SkeletonRows rows={5} thumb={false} />
      ) : !data ? (
        <EmptyState icon="alert" title="Could not load" hint={check.kind === 'error' ? check.message : 'The Batch 42 database step has not been run.'} />
      ) : (
        <>
          {data.locked ? (
            <p className="inv-ok rep-lockline" data-testid="lock-status">
              <AdminIcon name="lock" />
              <b>{data.label} is locked</b>
              {data.locked_at ? ` — ${dayText(data.locked_at)}${data.locked_by ? ` by ${data.locked_by}` : ''}` : ''}
            </p>
          ) : (
            <div className="adm-ocard inv-stack" data-testid="lock-checklist">
              <p className="inv-mode__title">Before you lock {data.label}</p>
              <ul className="lock-list">
                {data.items.map((item) => (
                  <li key={item.key} className={`lock-item${item.ok ? ' lock-item--ok' : ' lock-item--bad'}`} data-testid={`lock-item-${item.key}`}>
                    <AdminIcon name={item.ok ? 'check' : 'close'} />
                    <span>
                      <b>{item.title}</b>
                      <span className="inv-muted"> — {item.detail}</span>
                      {item.orders && item.orders.length > 0 && <span className="inv-muted"> ({item.orders.join(', ')})</span>}
                    </span>
                  </li>
                ))}
              </ul>
              {!data.ready && <p className="inv-muted" data-testid="lock-not-ready">Every line must be ticked before the month can be locked.</p>}
            </div>
          )}
          {data.unlocked_at && !data.locked && (
            <p className="inv-muted" data-testid="lock-unlocked-note">
              Unlocked {dayText(data.unlocked_at)}
              {data.unlocked_by ? ` by ${data.unlocked_by}` : ''}: {data.unlock_reason}
            </p>
          )}

          <section className="adm-ocard adm-careful" aria-label="Careful actions" data-testid="careful-actions">
            <h2 className="adm-careful__title">Careful actions</h2>
            <p className="adm-ocard__muted">You will be asked for your password.</p>
            <ul className="adm-careful__list">
              {!data.locked ? (
                <li className="adm-careful__row">
                  <span className="adm-careful__text">
                    <span className="adm-careful__name">Lock {data.label}</span>
                    <span className="adm-careful__explain">Nothing dated in it can be added, changed or deleted afterwards.</span>
                  </span>
                  <button
                    type="button"
                    className="adm-btn adm-btn--sm adm-careful__btn"
                    onClick={() => openSheet('lock')}
                    disabled={!data.ready}
                    data-testid="lock-button"
                  >
                    Lock {data.label}…
                  </button>
                </li>
              ) : isAdmin ? (
                <li className="adm-careful__row">
                  <span className="adm-careful__text">
                    <span className="adm-careful__name">Unlock {data.label}</span>
                    <span className="adm-careful__explain">Only the Super Admin; the reason goes in the Activity Log.</span>
                  </span>
                  <button type="button" className="adm-btn adm-btn--sm adm-careful__btn adm-careful__btn--red" onClick={() => openSheet('unlock')} data-testid="unlock-button">
                    Unlock…
                  </button>
                </li>
              ) : (
                <li className="adm-careful__row">
                  <span className="adm-careful__explain">Only the Super Admin can unlock a month.</span>
                </li>
              )}
            </ul>
          </section>

          {locked.length > 0 && (
            <>
              <h2 className="inv-section">Locked months</h2>
              <ul className="rep-list" data-testid="locked-months">
                {locked.map((l) => (
                  <li key={l.month} className="rep-list__item">
                    <span>
                      {l.locked && <AdminIcon name="lock" />} <b>{l.label}</b>
                    </span>
                    <span className="inv-muted">
                      {l.locked ? `locked ${dayText(l.locked_at)}` : `unlocked ${dayText(l.unlocked_at)}: ${l.unlock_reason ?? ''}`}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <ConfirmSheet
            isOpen={sheet !== null}
            title={sheet === 'lock' ? `Lock ${data.label}?` : `Unlock ${data.label}?`}
            warning={sheet === 'unlock' ? 'Entries dated in this month can be changed again until you lock it again.' : null}
            keepLabel="Keep it as it is"
            confirmLabel={sheet === 'lock' ? 'Lock' : 'Unlock'}
            danger={sheet === 'unlock'}
            onConfirm={confirm}
            onClose={() => setSheet(null)}
          >
            <p className="adm-csheet__text">
              {sheet === 'lock'
                ? `After this nothing dated in ${data.label} can be added, changed or deleted. Corrections are new entries dated today.`
                : 'Write why. It is kept in the Activity Log.'}
            </p>
            {sheet === 'unlock' && (
              <label className="adm-csheet__type">
                <span>Reason</span>
                <input className="form-input" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="unlock-reason" />
              </label>
            )}
            <label className="adm-csheet__type">
              <span>Type your password to confirm</span>
              <input
                className="form-input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                data-testid="lock-password"
              />
            </label>
            {sheetError && (
              <p className="inv-error" role="alert" data-testid="lock-error">
                {sheetError}
              </p>
            )}
          </ConfirmSheet>
        </>
      )}
    </section>
  );
}
