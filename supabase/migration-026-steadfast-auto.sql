-- ============================================================
-- Naeem's Price Hub — Migration 026 (Batch 20 Part 2: Steadfast
-- verification against the official API guide + automatic status updates)
-- Run this in the Supabase SQL Editor. Safe to re-run.
--
-- What this adds, on top of migration-025:
--   1. steadfast_tracking_link column — Steadfast's own real per-parcel
--      tracking URL (consignment.tracking_link), confirmed to exist from
--      their official API guide PDF. Batch 20 didn't have this field and
--      fell back to the generic https://steadfast.com.bd/tracking page.
--   2. admin_record_steadfast_shipment now also stores that link.
--   3. system_update_steadfast_status — same body as
--      admin_update_steadfast_status (migration-025), but for the
--      3-hourly automatic background refresh, which has no admin session
--      to check is_admin() against. Granted to service_role ONLY — never
--      to authenticated/anon — so the only thing that can call it is the
--      steadfast-refresh-all Edge Function's own service-role client, the
--      same trust boundary every other service-role-only write in Supabase
--      already relies on. It does NOT weaken or touch is_admin() or the
--      existing admin_update_steadfast_status function at all.
--   4. Enables pg_cron + pg_net (Supabase-managed extensions; harmless if
--      already on) and schedules the 3-hourly refresh job. The job calls
--      the steadfast-refresh-all Edge Function through pg_net, carrying a
--      long secret token so that function can tell the call really came
--      from this cron job. The token itself is stored in Supabase Vault
--      (below), never in this file as plain text — see the "ONE THING TO
--      EDIT BEFORE RUNNING" block partway down: you generate that token and
--      paste it in, once, before running this file.
-- ============================================================

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS steadfast_tracking_link text;

-- ---------- Booking a parcel (now also saves the tracking link) ----------
CREATE OR REPLACE FUNCTION admin_record_steadfast_shipment(
  p_order_id        uuid,
  p_consignment_id  text,
  p_tracking_code   text,
  p_tracking_link   text,
  p_courier_status  text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order orders%ROWTYPE;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;
  IF v_order.status <> 'confirmed' THEN
    RAISE EXCEPTION 'Order is not confirmed.';
  END IF;
  IF v_order.steadfast_consignment_id IS NOT NULL THEN
    RAISE EXCEPTION 'This order has already been booked with Steadfast.';
  END IF;

  UPDATE orders SET
    steadfast_consignment_id = p_consignment_id,
    steadfast_tracking_code  = p_tracking_code,
    steadfast_tracking_link  = NULLIF(p_tracking_link, ''),
    steadfast_status         = p_courier_status,
    tracking_number          = p_tracking_code,
    status                   = 'shipped',
    updated_at               = now()
  WHERE id = p_order_id;

  INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, note)
  VALUES (p_order_id, v_order.status, 'shipped', auth.uid(), 'Steadfast-এ পাঠানো হয়েছে');

  RETURN true;
END;
$$;

-- Old 4-argument version (pre-migration-026) is now shadowed by the 5-arg
-- one above; drop it so nothing accidentally still resolves to it.
DROP FUNCTION IF EXISTS admin_record_steadfast_shipment(uuid, text, text, text);

GRANT EXECUTE ON FUNCTION admin_record_steadfast_shipment(uuid, text, text, text, text) TO authenticated;

-- ---------- Refreshing delivery status — the SYSTEM path ----------
-- Identical logic to admin_update_steadfast_status (migration-025), minus
-- the is_admin() check — there is no signed-in admin for a pg_cron-
-- triggered call to check. The GRANT below (service_role only) is what
-- keeps this safe: nothing reachable by a browser (anon/authenticated) can
-- ever call it, only this project's own service-role Postgres client
-- (steadfast-refresh-all's Edge Function code), which already bypasses RLS
-- by design for every other service-role operation in this project.
CREATE OR REPLACE FUNCTION system_update_steadfast_status(
  p_order_id       uuid,
  p_courier_status text,
  p_mark_delivered boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_status text;
BEGIN
  SELECT status INTO v_old_status FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;

  UPDATE orders SET steadfast_status = p_courier_status, updated_at = now()
  WHERE id = p_order_id;

  IF p_mark_delivered AND v_old_status NOT IN ('delivered', 'cancelled') THEN
    UPDATE orders SET status = 'delivered', updated_at = now() WHERE id = p_order_id;
    INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, note)
    VALUES (p_order_id, v_old_status, 'delivered', NULL, 'Steadfast (auto): ডেলিভারি সম্পন্ন হয়েছে');
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION system_update_steadfast_status(uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION system_update_steadfast_status(uuid, text, boolean) TO service_role;

-- ---------- The 3-hourly automatic refresh job ----------
-- pg_net and supabase_vault ship with every Supabase project; pg_cron needs
-- enabling once. All three are no-ops if already on.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS supabase_vault;

-- ---------- ONE THING TO EDIT BEFORE RUNNING ----------
-- Replace PASTE_A_LONG_RANDOM_SECRET_HERE below with a long random string —
-- anything works (e.g. generate one at https://1password.com/password-
-- generator/, 40+ characters, letters+digits). This is NOT your Steadfast
-- key and NOT your Supabase key — it's a brand new token that only proves
-- "this request really came from my own cron job" to the
-- steadfast-refresh-all function. Copy the SAME value into Supabase
-- Dashboard -> Edge Functions -> steadfast-refresh-all -> Secrets as
-- STEADFAST_CRON_REFRESH_SECRET (or run
-- `supabase secrets set STEADFAST_CRON_REFRESH_SECRET=<the same value>`)
-- — both sides must match. Safe to re-run this block later with a new value
-- if you ever want to rotate it (just update the Edge Function secret to
-- match).
DELETE FROM vault.secrets WHERE name = 'steadfast_cron_refresh_secret';
SELECT vault.create_secret(
  'PASTE_A_LONG_RANDOM_SECRET_HERE',
  'steadfast_cron_refresh_secret',
  'Bearer token the pg_cron job uses to call steadfast-refresh-all.'
);

-- Re-runnable: drop any previous schedule under this name before recreating
-- it, rather than erroring if it doesn't exist yet.
DO $$
BEGIN
  PERFORM cron.unschedule('steadfast-refresh-all');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'steadfast-refresh-all',
  '0 */3 * * *', -- every 3 hours, on the hour — 8 times a day, far under
                 -- Steadfast's documented 1,000-requests-a-minute limit
                 -- even with hundreds of shipped orders at once.
  $cron$
  SELECT net.http_post(
    url := 'https://afkgkpuppmwmkyrbheew.supabase.co/functions/v1/steadfast-refresh-all',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets
        WHERE name = 'steadfast_cron_refresh_secret'
      )
    ),
    body := '{}'::jsonb
  );
  $cron$
);

-- ============================================================
-- ---------- Verify ----------
-- 1. SELECT steadfast_tracking_link FROM orders LIMIT 1;
--      → comes back null, not an error.
-- 2. SELECT jobname, schedule, active FROM cron.job
--      WHERE jobname = 'steadfast-refresh-all';
--      → one row, active = true, schedule = '0 */3 * * *'.
-- 3. SELECT name FROM vault.decrypted_secrets
--      WHERE name = 'steadfast_cron_refresh_secret';
--      → one row (the value itself is never shown by this query — that's
--        the point of Vault).
-- 4. As a non-service-role session, calling system_update_steadfast_status
--    directly must fail with a permission error (not "Not authorized" —
--    it never reaches its own body, the GRANT itself blocks it).
-- ============================================================
