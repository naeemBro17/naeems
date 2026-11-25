import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import {
  campaignsVersion,
  liveCampaignsNow,
  parseCampaigns,
  refreshCampaigns,
  setLiveCampaigns,
  subscribeCampaigns,
  type LiveCampaign,
} from '../lib/campaigns';

/** setTimeout's longest wait (about 24.8 days). */
const MAX_WAIT = 2_147_000_000;

/**
 * Batch 66: asks the database for the live campaigns once per app load
 * (live_campaigns(); tiny, not cached) and puts them in the campaign store
 * (src/lib/campaigns.ts), which every price helper reads. At the soonest
 * end it tells every reader again, so prices go back without a reload.
 * When the call fails (or migration-063 is not run yet) there are no
 * campaigns and every price is exactly as before.
 */
export function CampaignProvider({ children }: { children: ReactNode }) {
  const version = useSyncExternalStore(subscribeCampaigns, campaignsVersion);

  useEffect(() => {
    let alive = true;
    void supabase.rpc('live_campaigns').then(({ data, error }) => {
      if (!alive) return;
      setLiveCampaigns(error ? [] : parseCampaigns(data));
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const now = Date.now();
    const ends = liveCampaignsNow(now).map((c) => new Date(c.ends_at).getTime());
    if (ends.length === 0) return undefined;
    const wait = Math.min(Math.max(0, Math.min(...ends) - now) + 50, MAX_WAIT);
    const id = window.setTimeout(refreshCampaigns, wait);
    return () => window.clearTimeout(id);
  }, [version]);

  return <>{children}</>;
}

/** The live campaigns now; re-renders when they load or one ends. */
export function useLiveCampaigns(): LiveCampaign[] {
  useSyncExternalStore(subscribeCampaigns, campaignsVersion);
  return liveCampaignsNow();
}
