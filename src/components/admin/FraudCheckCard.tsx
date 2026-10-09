import { useEffect, useState } from 'react';
import { fetchFraudCheck, fraudCheckPhone, fraudTone, type FraudAnswer } from '../../lib/fraudCheck';

interface FraudCheckCardProps {
  phone: string;
}

/**
 * Batch 31 Part 2: Steadfast's courier history for a phone number — how
 * many parcels it has received across every Steadfast merchant and what
 * share was delivered or returned. Staff only (the function refuses anyone
 * else). Renders nothing until there is an answer, and nothing at all if
 * the check fails or isn't deployed.
 */
export function FraudCheckCard({ phone }: FraudCheckCardProps) {
  const normalized = fraudCheckPhone(phone);
  const [answer, setAnswer] = useState<FraudAnswer | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    setAnswer(null);
    if (!normalized) return;
    let cancelled = false;
    void fetchFraudCheck(normalized).then((a) => {
      if (!cancelled) setAnswer(a);
    });
    return () => {
      cancelled = true;
    };
  }, [normalized]);

  if (!normalized || !answer) return null;

  const refresh = async () => {
    setIsRefreshing(true);
    const fresh = await fetchFraudCheck(normalized, { refresh: true });
    setIsRefreshing(false);
    if (fresh) setAnswer(fresh);
  };

  const { result } = answer;
  const tone = fraudTone(result);
  const checkedAt = new Date(answer.fetchedAt).toLocaleString('en-GB', {
    timeZone: 'Asia/Dhaka',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <section className={`fraud-card fraud-card--${tone}`} data-testid="fraud-card" data-tone={tone} aria-label="Courier history">
      <div className="fraud-card__head">
        <span className="fraud-card__title">Courier history</span>
        <button type="button" className="fraud-card__refresh" onClick={refresh} disabled={isRefreshing}>
          {isRefreshing ? <span className="spinner" aria-hidden="true" /> : 'Refresh'}
        </button>
      </div>
      {tone === 'none' ? (
        <p className="fraud-card__empty">No courier history yet</p>
      ) : (
        <>
          <div className="fraud-card__stats">
            <span className="fraud-card__stat">
              <span className="fraud-card__value" data-testid="fraud-parcels">
                {result.volumeRange ?? '—'}
              </span>
              <span className="fraud-card__label">Parcels</span>
            </span>
            <span className="fraud-card__stat fraud-card__stat--score">
              <span className="fraud-card__value" data-testid="fraud-success">
                {result.deliveryRatio}%
              </span>
              <span className="fraud-card__label">Delivered</span>
            </span>
            <span className="fraud-card__stat">
              <span className="fraud-card__value" data-testid="fraud-returned">
                {result.cancellationRatio ?? 0}%
              </span>
              <span className="fraud-card__label">Returned</span>
            </span>
          </div>
          {tone === 'risk' && <p className="fraud-card__hint">High return risk — consider an advance payment</p>}
        </>
      )}
      {result.totalReports > 0 && (
        <p className="fraud-card__note">
          Reported {result.totalReports} {result.totalReports === 1 ? 'time' : 'times'} by other merchants
        </p>
      )}
      <p className="fraud-card__note">All Steadfast merchants · checked {checkedAt}</p>
    </section>
  );
}
