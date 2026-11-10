import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useToast } from '../../../hooks/useToast';
import type { LoadState } from '../../../lib/payouts';
import { fetchToGive, saveParty } from '../../../lib/money/api';
import { moneyText } from '../../../lib/money/format';
import type { PartyKind, ToGiveRow } from '../../../lib/money/types';
import { AdminPageHeader, EmptyState, SkeletonRows } from '../ui/AdminUi';
import type { MoneyOpen } from './moneyNav';

/**
 * Batch 41 Part 3: investors and "To give". Per investor: capital in,
 * capital returned, capital still owed, profit share paid (this month /
 * this year / all time). Suppliers: each lot's unpaid rest + what was owed
 * on the start date − supplier payments. Other people: what was owed on the
 * start date − payments. Their detailed terms stay in the Ledger app — here
 * only the money moves.
 */
export function PeopleView({ onBack, onOpen, onOpenLot }: { onBack: () => void; onOpen: MoneyOpen; onOpenLot: (lotId: string) => void }) {
  const { showToast } = useToast();
  const [state, setState] = useState<LoadState<ToGiveRow[]> | null>(null);
  const [adding, setAdding] = useState<PartyKind | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setState(await fetchToGive());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!adding) return;
    setSaving(true);
    const answer = await saveParty({ id: null, name, phone, kind: adding, note });
    setSaving(false);
    if (!answer.ok) {
      showToast(answer.error ?? 'Could not save', 'error');
      return;
    }
    showToast(adding === 'investor' ? 'Investor added' : 'Added');
    setAdding(null);
    setName('');
    setPhone('');
    setNote('');
    await load();
  };

  const rows = state?.kind === 'ready' ? state.data : [];
  const investors = rows.filter((r) => r.kind === 'investor');
  const suppliers = rows.filter((r) => r.kind === 'supplier' && r.owed !== 0);
  const others = rows.filter((r) => r.kind === 'other');
  const total = rows.reduce((s, r) => s + r.owed, 0);

  return (
    <section className="inv money" aria-label="Investors and what I owe">
      <AdminPageHeader
        title="Investors and what I owe"
        onBack={onBack}
        menu={[
          { label: 'Add an investor', onSelect: () => setAdding('investor') },
          { label: 'Add someone I owe', onSelect: () => setAdding('other') },
          { label: 'Record a payment', onSelect: () => onOpen('add') },
        ]}
      />
      {state === null ? (
        <SkeletonRows rows={5} thumb={false} />
      ) : state.kind !== 'ready' ? (
        <EmptyState icon="alert" title="Could not load" hint={state.kind === 'error' ? state.message : 'The Batch 41 database step has not been run.'} />
      ) : (
        <>
          <div className="adm-ocard inv-stack" data-testid="money-to-give-total">
            <div className="inv-line inv-line--total">
              <span>To give (all)</span>
              <b>{moneyText(total)}</b>
            </div>
            <p className="inv-muted">Investor capital still owed + supplier balances + what was owed on the start date.</p>
          </div>

          <h2 className="inv-section">Investors</h2>
          {investors.length === 0 ? (
            <p className="inv-muted">No investors yet. Add one here or on Add money → Investor.</p>
          ) : (
            investors.map((r) => (
              <div key={r.id ?? r.name} className="adm-ocard inv-stack" data-testid="money-investor">
                <div className="inv-line inv-line--total">
                  <span>{r.name}</span>
                  <b>{moneyText(r.owed)}</b>
                </div>
                <div className="inv-line">
                  <span>Capital in</span>
                  <span>{moneyText(r.capital_in ?? 0)}</span>
                </div>
                <div className="inv-line">
                  <span>Capital returned</span>
                  <span>{moneyText(r.capital_back ?? 0)}</span>
                </div>
                <div className="inv-line">
                  <span>Capital still owed</span>
                  <span>{moneyText(r.owed)}</span>
                </div>
                <div className="inv-line">
                  <span>Profit share paid — this month</span>
                  <span>{moneyText(r.share_month ?? 0)}</span>
                </div>
                <div className="inv-line">
                  <span>— this year</span>
                  <span>{moneyText(r.share_year ?? 0)}</span>
                </div>
                <div className="inv-line">
                  <span>— all time</span>
                  <span>{moneyText(r.share_all ?? 0)}</span>
                </div>
              </div>
            ))
          )}

          <h2 className="inv-section">Suppliers</h2>
          {suppliers.length === 0 ? (
            <p className="inv-muted">Nothing owed to suppliers.</p>
          ) : (
            suppliers.map((r) => (
              <div key={r.id ?? r.name} className="adm-ocard inv-stack" data-testid="money-supplier">
                <div className="inv-line inv-line--total">
                  <span>{r.name}</span>
                  <b>{moneyText(r.owed)}</b>
                </div>
                {r.lots.map((l) => (
                  <button key={l.lot_id} type="button" className="adm-btn adm-btn--ghost money-lot-link" onClick={() => onOpenLot(l.lot_id)}>
                    {l.code}: {moneyText(l.owed)} not paid
                  </button>
                ))}
              </div>
            ))
          )}

          <h2 className="inv-section">Other people</h2>
          {others.length === 0 ? (
            <p className="inv-muted">No one else.</p>
          ) : (
            others.map((r) => (
              <div key={r.id ?? r.name} className="inv-line">
                <span>{r.name}</span>
                <span>{moneyText(r.owed)}</span>
              </div>
            ))
          )}
        </>
      )}

      {adding && (
        <form className="adm-ocard inv-stack" onSubmit={save} noValidate data-testid="money-party-form">
          <p className="inv-mode__title">{adding === 'investor' ? 'New investor' : 'Someone I owe'}</p>
          <label className="form-field">
            <span className="form-label">Name</span>
            <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
          </label>
          <label className="form-field">
            <span className="form-label">Phone (optional)</span>
            <input className="form-input" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} aria-label="Phone" />
          </label>
          <label className="form-field">
            <span className="form-label">Note (optional)</span>
            <input className="form-input" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
          </label>
          <p className="inv-muted">Money in and out for them is added on Add money. What you owed on the start date goes in Opening balances.</p>
          <div className="inv-actions">
            <button type="button" className="adm-btn" onClick={() => setAdding(null)}>
              Cancel
            </button>
            <button type="submit" className="adm-btn adm-btn--primary" disabled={saving || name.trim() === ''}>
              {saving ? <span className="spinner" aria-hidden="true" /> : 'Save'}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
