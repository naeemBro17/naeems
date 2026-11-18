import { useMemo, useState } from 'react';
import { useToast } from '../../../hooks/useToast';
import { checkCustomers, importCustomers, readKaarbarFile, undoCustomers, type KaarbarStatus, type KeptCustomer } from '../../../lib/kaarbar/api';
import {
  classifyParties,
  customerImportRows,
  dueDifferences,
  readParties,
  toggleTick,
  type CustomerGroup,
  type CustomerPreviewRow,
  type PartyRow,
} from '../../../lib/kaarbar/parse';
import { moneyText } from '../../../lib/money/format';
import { AdminSearch, ChipRow, type Chip } from '../ui/AdminUi';
import { importWhen, PasswordSheet } from './KaarbarImportTab';

const GROUPS: { id: CustomerGroup; label: string; tag: string }[] = [
  { id: 'new', label: 'New', tag: 'New' },
  { id: 'existing', label: 'Already on the site', tag: 'Already on the site' },
  { id: 'samePhone', label: 'Same phone', tag: 'Same phone as another party' },
  { id: 'noPhone', label: 'No phone', tag: 'No phone' },
  { id: 'supplier', label: 'Looks like a supplier', tag: 'Looks like a supplier' },
  { id: 'cashName', label: 'Cash / walk-in', tag: 'Cash / walk-in name' },
];

const PAGE = 60;

export function KaarbarCustomersCard({ status, onChanged }: { status: KaarbarStatus; onChanged: () => Promise<void> }) {
  const { showToast } = useToast();
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [parties, setParties] = useState<PartyRow[] | null>(null);
  const [rows, setRows] = useState<CustomerPreviewRow[] | null>(null);
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState<'all' | CustomerGroup>('all');
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [sheet, setSheet] = useState<'import' | 'undo' | null>(null);
  const [kept, setKept] = useState<KeptCustomer[] | null>(null);

  const classify = async (list: PartyRow[], keepTicks: boolean): Promise<string | null> => {
    const answer = await checkCustomers(list.map((r) => ({ n: r.n, phone_key: r.phoneKey, name: r.name })));
    if (!answer.ok) return answer.error;
    const next = classifyParties(list, answer.data);
    setRows(next);
    setTicked((old) => new Set(next.filter((r) => r.tickable && (keepTicks ? old.has(r.n) : r.tickedByDefault)).map((r) => r.n)));
    return null;
  };

  const pick = async (file: File | null) => {
    if (!file) return;
    setFileName(file.name);
    setFileError(null);
    setRows(null);
    setParties(null);
    setKept(null);
    setReading(true);
    try {
      const sheets = await readKaarbarFile(file);
      let found: PartyRow[] | null = null;
      let firstError: string | null = null;
      for (const cells of sheets) {
        const read = readParties(cells);
        if (!read.error) {
          found = read.rows;
          break;
        }
        firstError ??= read.error;
      }
      if (!found) {
        setFileError(firstError ?? 'The file is empty.');
        return;
      }
      setParties(found);
      setFilter('all');
      setSearch('');
      setShown(PAGE);
      const failed = await classify(found, false);
      if (failed) setFileError(failed);
    } catch (e) {
      setFileError(e instanceof Error ? e.message : 'Could not read the file.');
    } finally {
      setReading(false);
    }
  };

  const counts = useMemo(() => {
    const map = new Map<CustomerGroup, number>();
    for (const r of rows ?? []) map.set(r.group, (map.get(r.group) ?? 0) + 1);
    return map;
  }, [rows]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const digits = q.replace(/\D/g, '').replace(/^(00)?880/, '').replace(/^0/, '');
    return (rows ?? []).filter((r) => {
      if (filter !== 'all' && r.group !== filter) return false;
      if (q === '') return true;
      return r.name.toLowerCase().includes(q) || (digits.length >= 3 && (r.phoneKey ?? r.contact.replace(/\D/g, '')).includes(digits));
    });
  }, [rows, filter, search]);

  const toImport = useMemo(() => (rows ? customerImportRows(rows, ticked) : []), [rows, ticked]);
  const differences = useMemo(() => (rows ? dueDifferences(rows) : []), [rows]);

  const chips: Chip[] = [
    { id: 'all', label: 'All', count: rows?.length ?? 0 },
    ...GROUPS.filter((g) => (counts.get(g.id) ?? 0) > 0).map((g) => ({ id: g.id, label: g.label, count: counts.get(g.id) ?? 0 })),
  ];

  const doImport = async (): Promise<string | null> => {
    const answer = await importCustomers(toImport);
    if (!answer.ok) return answer.error;
    setSheet(null);
    showToast(`Imported ${answer.data.added} customer${answer.data.added === 1 ? '' : 's'}`);
    await onChanged();
    if (parties) await classify(parties, false);
    return null;
  };

  const doUndo = async (): Promise<string | null> => {
    const answer = await undoCustomers();
    if (!answer.ok) return answer.error;
    setSheet(null);
    setKept(answer.data.kept);
    showToast(`Removed ${answer.data.removed} imported customer${answer.data.removed === 1 ? '' : 's'}`);
    await onChanged();
    if (parties) await classify(parties, false);
    return null;
  };

  const last = status.lastCustomers;

  return (
    <section className="adm-ocard kb-card" aria-label="Customers" data-testid="kb-customers">
      <h2 className="kb-card__title">Customers</h2>
      <p className="inv-muted">From Kaarbar: Reports → All Party Report → Excel. Each party becomes a customer on the site (no login, no message).</p>
      <label className="adm-btn kb-file">
        {reading ? 'Reading…' : fileName ? 'Pick another file' : 'Pick the All Party Report'}
        <input type="file" accept=".xlsx" hidden onChange={(e) => void pick(e.target.files?.[0] ?? null)} data-testid="kb-customers-file" />
      </label>
      {fileName && <p className="inv-muted kb-filename">{fileName}</p>}
      {fileError && (
        <p className="inv-error" role="alert" data-testid="kb-customers-error">
          {fileError}
        </p>
      )}

      {rows && (
        <div className="inv-stack" data-testid="kb-customers-preview">
          <ul className="kb-counts" aria-label="What will happen">
            {GROUPS.map((g) => (
              <li key={g.id} className="kb-counts__item" data-testid={`kb-count-${g.id}`}>
                <span>{g.label}</span>
                <b>{counts.get(g.id) ?? 0}</b>
              </li>
            ))}
          </ul>
          {(counts.get('samePhone') ?? 0) > 0 && (
            <p className="inv-muted">
              Same phone: two Kaarbar parties share one number. The site keeps one customer per phone, so tick the one you want — ticking one
              unticks the other.
            </p>
          )}

          <AdminSearch value={search} onChange={setSearch} placeholder="Search name or phone" label="Search the parties" />
          <ChipRow chips={chips} active={filter} onSelect={(id) => setFilter(id as 'all' | CustomerGroup)} label="Show" />

          <ul className="kb-list" data-testid="kb-customers-list">
            {visible.slice(0, shown).map((r) => {
              const group = GROUPS.find((g) => g.id === r.group);
              return (
                <li key={r.n} className={`kb-row${r.pairKey ? ' kb-row--pair' : ''}`} data-testid="kb-customer-row" data-group={r.group}>
                  <label className="kb-row__label">
                    <input
                      type="checkbox"
                      className="kb-check"
                      checked={r.tickable && ticked.has(r.n)}
                      disabled={!r.tickable}
                      onChange={() => setTicked((old) => toggleTick(rows, old, r.n))}
                      aria-label={`Import ${r.name}`}
                    />
                    <span className="kb-row__main">
                      <span className="kb-row__name">{r.name}</span>
                      <span className="kb-row__sub">
                        {r.phoneKey ?? (r.contact ? `No mobile number (${r.contact})` : 'No phone')}
                        {r.group === 'existing' && r.site.siteName ? ` · on the site as ${r.site.siteName}` : ''}
                      </span>
                    </span>
                    <span className={`kb-tag kb-tag--${r.group}`}>{group?.tag}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          {visible.length === 0 && <p className="inv-muted">No party matches.</p>}
          {visible.length > shown && (
            <button type="button" className="adm-btn adm-btn--ghost" onClick={() => setShown((s) => s + PAGE)}>
              Show {Math.min(PAGE, visible.length - shown)} more
            </button>
          )}

          {differences.length > 0 && (
            <details className="kb-fold" data-testid="kb-due-check">
              <summary>
                Dues to check ({differences.length}) <span className="inv-muted">— information only, nothing changes</span>
              </summary>
              <p className="inv-muted">
                Kaarbar&apos;s Receivable is different from what the site says this customer owes today. The site keeps its own dues (your
                opening dues from Batch 41 are the truth).
              </p>
              <ul className="kb-list">
                {differences.map((d) => (
                  <li key={d.n} className="kb-row kb-due" data-testid="kb-due-row">
                    <span className="kb-row__main">
                      <span className="kb-row__name">{d.name}</span>
                      <span className="kb-row__sub">{d.phoneKey ?? 'No phone'}</span>
                    </span>
                    <span className="kb-due__nums">
                      <span>Kaarbar {moneyText(d.kaarbar)}</span>
                      <span>Site {moneyText(d.site)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {kept && kept.length > 0 && (
        <div className="kb-notice" data-testid="kb-customers-kept">
          <b>Kept {kept.length} customer{kept.length === 1 ? '' : 's'} (they now have something on the site):</b>
          <ul>
            {kept.map((k) => (
              <li key={`${k.name}-${k.phone}`}>
                {k.name}
                {k.phone ? ` (${k.phone})` : ''} — {k.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <section className="adm-careful kb-careful" aria-label="Careful actions" data-testid="kb-customers-careful">
        <h3 className="adm-careful__title">Careful actions</h3>
        <p className="adm-ocard__muted">You will be asked for your password.</p>
        <ul className="adm-careful__list">
          <li className="adm-careful__row">
            <span className="adm-careful__text">
              <span className="adm-careful__name">Import {toImport.length} customers</span>
              <span className="adm-careful__explain">Only the ticked rows. Customers already on the site are never changed.</span>
            </span>
            <button
              type="button"
              className="adm-btn adm-btn--sm kb-go"
              disabled={toImport.length === 0}
              onClick={() => setSheet('import')}
              data-testid="kb-customers-import"
            >
              Import {toImport.length}…
            </button>
          </li>
          <li className="adm-careful__row">
            <span className="adm-careful__text">
              <span className="adm-careful__name">Undo last import</span>
              <span className="adm-careful__explain">
                {last
                  ? `${importWhen(last.at)}: ${last.count} customers. Anyone who since has an order, a payment, a due or a login is kept.`
                  : 'No customer import yet.'}
              </span>
            </span>
            <button
              type="button"
              className="adm-btn adm-btn--sm adm-careful__btn adm-careful__btn--red"
              disabled={!last}
              onClick={() => setSheet('undo')}
              data-testid="kb-customers-undo"
            >
              Undo…
            </button>
          </li>
        </ul>
      </section>

      <PasswordSheet
        isOpen={sheet === 'import'}
        title={`Import ${toImport.length} customers?`}
        text="They are added to Customers as customers you added by hand: no login account, no password, no email and no message."
        confirmLabel="Import"
        onConfirm={doImport}
        onClose={() => setSheet(null)}
      />
      <PasswordSheet
        isOpen={sheet === 'undo'}
        title="Undo the last customer import?"
        text={last ? `Removes the ${last.count} customers imported ${importWhen(last.at)}, except anyone who since has an order, a payment, a due or a login account.` : ''}
        confirmLabel="Undo import"
        danger
        onConfirm={doUndo}
        onClose={() => setSheet(null)}
      />
    </section>
  );
}
