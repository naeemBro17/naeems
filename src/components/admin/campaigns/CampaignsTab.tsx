import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AdminPageHeader, ChipRow, EmptyState, SkeletonRows } from '../ui/AdminUi';
import { AdminIcon } from '../ui/AdminIcon';
import { Switch } from '../../shared/Switch';
import { useToast } from '../../../hooks/useToast';
import { useAuth } from '../../../contexts/AuthContext';
import { adminPath } from '../../../lib/adminPages';
import { moneyText } from '../../../lib/money/format';
import {
  campaignStatus,
  campaignSummary,
  dhakaRange,
  fetchAdminCampaigns,
  setCampaignEnabled,
  statusText,
  type AdminCampaign,
  type CampaignStatus,
} from '../../../lib/campaignsAdmin';

type Filter = 'all' | 'live' | 'scheduled' | 'ended';

/** Batch 66: Admin → Campaigns. One card per campaign; tap to edit. */
export function CampaignsTab() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { can } = useAuth();
  const seeMoney = can('view_profit_costs');
  const [campaigns, setCampaigns] = useState<AdminCampaign[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const result = await fetchAdminCampaigns();
    setMissing(result.missing);
    if (result.error && !result.missing) showToast(result.error);
    setCampaigns(result.campaigns);
    setNow(Date.now());
  }, [showToast]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [load]);

  const counts = useMemo(() => {
    const c: Record<CampaignStatus, number> = { live: 0, scheduled: 0, ended: 0, off: 0 };
    for (const x of campaigns ?? []) c[campaignStatus(x, now)] += 1;
    return c;
  }, [campaigns, now]);

  const shown = (campaigns ?? []).filter((c) => filter === 'all' || campaignStatus(c, now) === filter);

  const toggle = async (c: AdminCampaign, on: boolean) => {
    setCampaigns((list) => (list ?? []).map((x) => (x.id === c.id ? { ...x, is_enabled: on } : x)));
    const error = await setCampaignEnabled(c.id, on);
    if (error) {
      showToast(error);
      setCampaigns((list) => (list ?? []).map((x) => (x.id === c.id ? { ...x, is_enabled: !on } : x)));
      return;
    }
    showToast(on ? `${c.name} is on` : `${c.name} is off`);
  };

  return (
    <div className="cmpa" data-testid="admin-campaigns">
      <AdminPageHeader
        title="Campaigns"
        subtitle="Timed sales with a countdown on the shop"
        primary={
          <button type="button" className="adm-btn adm-btn--primary" onClick={() => navigate(adminPath.newCampaign())} data-testid="campaign-new">
            <AdminIcon name="plus" className="adm-icon--sm" />
            New
          </button>
        }
      />
      <ChipRow
        label="Show campaigns"
        active={filter}
        onSelect={(id) => setFilter(id as Filter)}
        chips={[
          { id: 'all', label: 'All', count: campaigns?.length },
          { id: 'live', label: 'Live', count: counts.live },
          { id: 'scheduled', label: 'Scheduled', count: counts.scheduled },
          { id: 'ended', label: 'Ended', count: counts.ended },
        ]}
      />

      {campaigns === null ? (
        <SkeletonRows rows={3} thumb={false} />
      ) : missing ? (
        <EmptyState icon="campaigns" title="Campaigns are not set up yet" hint="Run migration-063 in the Supabase SQL Editor, then reload." />
      ) : shown.length === 0 ? (
        <EmptyState
          icon="campaigns"
          title={filter === 'all' ? 'No campaigns yet' : 'Nothing here'}
          hint={filter === 'all' ? 'A campaign puts products on sale between two dates, with a countdown on Home.' : undefined}
        />
      ) : (
        <ul className="cmpa-list">
          {shown.map((c) => {
            const status = campaignStatus(c, now);
            return (
              <li key={c.id} className="cmpa-card" data-testid="campaign-row">
                <button type="button" className="cmpa-card__open" onClick={() => navigate(adminPath.editCampaign(c.id), { state: { fromList: true } })}>
                  <span className="cmpa-card__top">
                    <span className="cmpa-card__name">{c.name}</span>
                    <span className={`cmpa-pill cmpa-pill--${status}`} data-testid="campaign-status">
                      {status === 'live' && <i aria-hidden="true" />}
                      {statusText(c, now)}
                    </span>
                  </span>
                  <span className="cmpa-card__dates">{dhakaRange(c.starts_at, c.ends_at)}</span>
                  <span className="cmpa-card__what">
                    {campaignSummary(c)}
                    {c.style === 'glitter' ? ' · Glitter' : ''}
                  </span>
                  {seeMoney && c.orders > 0 && (
                    <span className="cmpa-stats" data-testid="campaign-stats">
                      <span>
                        <small>Orders</small>
                        <b>{c.orders}</b>
                      </span>
                      <span>
                        <small>Sold</small>
                        <b>{moneyText(c.sold)}</b>
                      </span>
                      <span>
                        <small>Given off</small>
                        <b>{moneyText(c.given_off)}</b>
                      </span>
                    </span>
                  )}
                </button>
                <span className="cmpa-card__switch">
                  <Switch checked={c.is_enabled} onChange={(on) => void toggle(c, on)} label={`${c.name} on or off`} />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
