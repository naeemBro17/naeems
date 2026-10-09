-- Batch 35 — Order tracking (reports/batch-35.txt).
--
--   Part 1: order_tracking_events — every Steadfast tracking update of an
--           order, kept once (same order + same time + same text = one
--           row), with Steadfast's own words AND the short friendly English
--           the customer sees. Filled by the steadfast functions (the
--           3-hourly refresh and the on-demand refresh), never by a person.
--           Staff with "View orders" read every row; a customer reads only
--           the friendly text of their OWN order, through
--           customer_order_updates(), never Steadfast's own words (they can
--           hold Naeem's notes, COD edits and addresses).
--           customer_order_updates() also returns the order's payments as
--           updates (amount, method, time — never the TrxID or the note).
--           order_latest_tracking_steps(): the newest In transit / Out for
--           delivery step per order, for the order lists.
--   Part 6: the "Show rider's phone to customers" switch is one more row in
--           app_settings (key show_rider_phone, default 'false'). Only the
--           Super Admin can change app_settings (the existing
--           app_settings_admin_write policy, is_admin()), and every change
--           is already written to the Activity Log by the existing
--           app_settings_activity_log trigger.
--
-- Additive only: one new table, three new functions, one new settings
-- row. Nothing existing is dropped, renamed or changed. Safe to run more
-- than once.

BEGIN;

-- ---------------------------------------------------------------------------
-- Part 1: stored tracking updates
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS order_tracking_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  -- Same time + same text → same key (see trackingEventKey in
  -- supabase/functions/_shared/orderTracking.ts).
  event_key     text NOT NULL,
  -- in_transit / out_for_delivery / delivered / returned, or NULL when the
  -- update proves no step.
  step          text,
  -- What the customer sees; NULL = never shown to the customer.
  friendly_text text,
  -- Steadfast's own words (staff only).
  courier_text  text NOT NULL,
  happened_at   timestamptz,
  source        text NOT NULL DEFAULT 'steadfast_refresh',
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_tracking_events_once UNIQUE (order_id, event_key)
);

CREATE INDEX IF NOT EXISTS idx_order_tracking_events_order ON order_tracking_events (order_id, happened_at);

ALTER TABLE order_tracking_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "order_tracking_events_staff_read" ON order_tracking_events;
CREATE POLICY "order_tracking_events_staff_read"
  ON order_tracking_events FOR SELECT TO authenticated
  USING (staff_can('view_orders'));

REVOKE ALL ON order_tracking_events FROM anon, authenticated;
GRANT SELECT ON order_tracking_events TO authenticated;
GRANT ALL ON order_tracking_events TO service_role;

-- The customer's own order: friendly tracking text + payments. Staff with
-- "View orders" may read any order the same way. Anyone else: no rows.
CREATE OR REPLACE FUNCTION customer_order_updates(p_order_id uuid)
RETURNS TABLE (kind text, step text, text text, happened_at timestamptz, amount numeric, method text)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_customer uuid;
BEGIN
  SELECT o.customer_id INTO v_customer FROM orders o WHERE o.id = p_order_id;
  IF NOT FOUND OR NOT (COALESCE(v_customer = auth.uid(), false) OR staff_can('view_orders')) THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT 'tracking'::text, e.step, e.friendly_text, e.happened_at, NULL::numeric, NULL::text
    FROM order_tracking_events e
    WHERE e.order_id = p_order_id AND e.friendly_text IS NOT NULL
    UNION ALL
    SELECT p.kind::text, NULL::text, NULL::text, p.paid_at, p.amount, p.method::text
    FROM order_payments p
    WHERE p.order_id = p_order_id
    ORDER BY 4 NULLS FIRST;
END;
$$;

REVOKE ALL ON FUNCTION customer_order_updates(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION customer_order_updates(uuid) TO authenticated;

-- The newest In transit / Out for delivery update per order: every order
-- for staff with "View orders", only their own orders for a customer.
CREATE OR REPLACE FUNCTION order_latest_tracking_steps()
RETURNS TABLE (order_id uuid, step text, happened_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT DISTINCT ON (e.order_id) e.order_id, e.step, e.happened_at
  FROM order_tracking_events e
  JOIN orders o ON o.id = e.order_id
  WHERE e.step IN ('in_transit', 'out_for_delivery')
    AND o.status = 'shipped'
    AND (staff_can('view_orders') OR o.customer_id = auth.uid())
  ORDER BY e.order_id, e.happened_at DESC NULLS LAST, e.id DESC;
$$;

REVOKE ALL ON FUNCTION order_latest_tracking_steps() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION order_latest_tracking_steps() TO authenticated;

-- ---------------------------------------------------------------------------
-- Part 6: "Show rider's phone to customers" — default Off
-- ---------------------------------------------------------------------------

INSERT INTO app_settings (key, value) VALUES ('show_rider_phone', 'false')
ON CONFLICT (key) DO NOTHING;

COMMIT;

-- ---------- Verify ----------
-- 1. SELECT to_regclass('public.order_tracking_events');            → order_tracking_events
-- 2. SELECT value FROM app_settings WHERE key = 'show_rider_phone';  → false
-- 3. SELECT count(*) FROM order_latest_tracking_steps();             → 0 or more (as admin)
