import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../../../hooks/useToast';
import { fetchCustomersV3, type CustomerRow } from '../../../lib/adminData';
import { formatTakaBd } from '../../../lib/adminNav';
import { customerName, initial, joinCandidates, phoneText, toCandidate, type JoinCandidate } from '../../../lib/customerNumbers';
import { fetchMergePreview, mergeCustomers, type MergePreview } from '../../../lib/customerNumbersApi';
import { fetchCustomerDues } from '../../../lib/money/api';
import { AdminFormPage } from '../AdminFormPage';
import { SkeletonRows } from '../ui/AdminUi';
import { AdminIcon } from '../ui/AdminIcon';
import '../../../styles/kaarbarMerge.css';
import '../../../styles/customerTools.css';

/**
 * Batch 55, mockup screen 3: /admin/customers/:key/join — pick the
 * duplicate record of this customer; everything from it moves here and the
 * duplicate is removed (admin_merge_customers, Super Admin). `pickKey`
 * (?pick=) picks one first.
 */
export function JoinCustomerPage({
  customerKey,
  pickKey,
  onBack,
  onMerged,
}: {
  customerKey: string;
  pickKey: string | null;
  onBack: () => void;
  onMerged: () => void;
}) {
  const { showToast } = useToast();
  const [rows, setRows] = useState<CustomerRow[] | null>(null);
  const [previous, setPrevious] = useState<Map<string, number>>(() => new Map());
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<JoinCandidate | null>(null);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let alive = true;
    void Promise.all([fetchCustomersV3(), fetchCustomerDues()]).then(([customers, dues]) => {
      if (!alive) return;
      const prev = new Map<string, number>();
      for (const [key, d] of dues) prev.set(key, d.previous_left);
      setPrevious(prev);
      setRows(customers.rows);
      const first = pickKey ? customers.rows.find((r) => r.key === pickKey && r.key !== customerKey) : undefined;
      if (first) setPicked(toCandidate(first, prev));
    });
    return () => {
      alive = false;
    };
  }, [customerKey, pickKey]);

  useEffect(() => {
    setPreview(null);
    if (!picked || picked.reason !== null) return;
    let alive = true;
    void fetchMergePreview(customerKey, picked.key).then((answer) => {
      if (!alive) return;
      if (answer.ok) {
        setPreview(answer.data);
        return;
      }
      showToast(answer.error, 'error');
      setPicked(null);
    });
    return () => {
      alive = false;
    };
  }, [customerKey, picked, showToast]);

  const self = rows?.find((r) => r.key === customerKey) ?? null;
  const keptName = self ? customerName(self) : '';
  const results = useMemo(() => {
    const found = rows ? joinCandidates(rows, customerKey, query, previous) : [];
    return picked && !found.some((r) => r.key === picked.key) ? [picked, ...found] : found;
  }, [rows, customerKey, query, previous, picked]);

  const pick = (r: JoinCandidate) => {
    if (r.reason !== null) return;
    setPicked(r.key === picked?.key ? null : r);
  };

  const merge = async () => {
    if (!picked || !preview) return;
    setWorking(true);
    const answer = await mergeCustomers(customerKey, picked.key);
    setWorking(false);
    if (!answer.ok) {
      showToast(answer.error, 'error');
      return;
    }
    showToast(`Merged ${picked.name} into ${keptName}`);
    onMerged();
  };

  return (
    <AdminFormPage title="Merge with another customer" backLabel="Back to the customer" onBack={onBack} testId="join-customer" guard={false}>
      <div className="km-page">
        {rows === null ? (
          <SkeletonRows rows={3} thumb={false} />
        ) : self === null ? (
          <p className="adm-fpage__notice">This customer was not found.</p>
        ) : (
          <>
            <p className="km-note">
              Pick the duplicate record of <b>{keptName}</b>. Everything from it moves here, and the duplicate is removed.
            </p>
            <label className="ct-search">
              <AdminIcon name="search" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name or number" aria-label="Search customers" data-testid="join-search" />
            </label>
            <div className="ct-list">
              {results.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  className={`ct-who${r.key === picked?.key ? ' ct-who--on' : ''}`}
                  disabled={r.reason !== null}
                  onClick={() => pick(r)}
                  data-testid="join-result"
                >
                  <span className="ct-who__av" aria-hidden="true">
                    {initial(r.name)}
                  </span>
                  <span className="ct-who__text">
                    <b>{r.name}</b>
                    <span className="ct-who__sub">{r.reason ?? `${phoneText(r.phone)} · ${r.orders} orders · ${formatTakaBd(r.due)} due`}</span>
                  </span>
                  {r.key === picked?.key && <span className="km-chip km-chip--neutral">Selected</span>}
                </button>
              ))}
            </div>
            {preview && picked && (
              <>
                <h3 className="km-title">WHAT HAPPENS</h3>
                <div className="km-card" data-testid="join-preview">
                  <div className="ct-cmp">
                    <span className="ct-cmp__h" />
                    <span className="ct-cmp__h ct-cmp__r">{keptName}</span>
                    <span className="ct-cmp__h ct-cmp__r">{picked.name}</span>
                    <span>Orders</span>
                    <span className="ct-cmp__r">{preview.keep.orders}</span>
                    <span className="ct-cmp__r">{preview.remove.orders}</span>
                    <span>Due on orders</span>
                    <span className="ct-cmp__r">{formatTakaBd(preview.keep.due)}</span>
                    <span className="ct-cmp__r">{formatTakaBd(preview.remove.due)}</span>
                    <span>Previous balance</span>
                    <span className="ct-cmp__r">{formatTakaBd(preview.keep.previous)}</span>
                    <span className="ct-cmp__r">{formatTakaBd(preview.remove.previous)}</span>
                    <span>Kaarbar bills</span>
                    <span className="ct-cmp__r">{preview.keep.bills}</span>
                    <span className="ct-cmp__r">{preview.remove.bills}</span>
                    <span className="ct-cmp__total">After merging</span>
                    <span className="ct-cmp__total" />
                    <span className="ct-cmp__total ct-cmp__r" data-testid="join-after">{`${preview.after.orders} orders · ${formatTakaBd(preview.after.due)}`}</span>
                  </div>
                </div>
                <p className="km-note ct-pad">{`${keptName} keeps their name, main number and address. ${phoneText(picked.phone)} is added as their old number.`}</p>
              </>
            )}
          </>
        )}
      </div>
      <div className="km-bar">
        <button type="button" className="km-btn km-btn--orange" disabled={!picked || !preview || working} onClick={() => void merge()} data-testid="join-merge">
          {`Merge into ${keptName}`}
        </button>
        <p className="km-note">This can&apos;t be undone.</p>
      </div>
    </AdminFormPage>
  );
}
