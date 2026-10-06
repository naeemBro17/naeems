-- ============================================================
-- NAEEM'S — Migration 034 (Batch 31: Steadfast customer check)
-- Run this in the Supabase SQL Editor after migration-033. Safe to re-run.
--
-- ADDITIVE ONLY. Nothing is dropped, renamed or changed in meaning.
--
-- What it adds:
--   A staff-only cache of Steadfast's customer check (delivered / returned
--   share for a phone number), so Steadfast is asked about one number at
--   most once a day. Only the steadfast Edge Function writes it; staff with
--   "View orders" may read it; customers and visitors can't see it at all.
--   Until this runs, the function keeps the answers in memory instead.
-- ============================================================

CREATE TABLE IF NOT EXISTS steadfast_fraud_cache (
  phone      text PRIMARY KEY,
  result     jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE steadfast_fraud_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "steadfast_fraud_cache_staff_read" ON steadfast_fraud_cache;
CREATE POLICY "steadfast_fraud_cache_staff_read"
  ON steadfast_fraud_cache FOR SELECT TO authenticated
  USING (staff_can('view_orders'));

REVOKE ALL ON steadfast_fraud_cache FROM anon, authenticated;
GRANT SELECT ON steadfast_fraud_cache TO authenticated;
GRANT ALL ON steadfast_fraud_cache TO service_role;
