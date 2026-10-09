-- ============================================================
-- Batch 36 — Steadfast payouts (reports/batch-36.txt).
--
--   steadfast_payouts       one row per payout Steadfast made to Naeem
--                           (Steadfast's payment id is unique, so the same
--                           payout read twice is stored once).
--   steadfast_payout_items  the parcels inside each payout: COD collected,
--                           delivery charge, 1% COD fee, anything else
--                           kept, net paid, and whether it matched our order.
--   order_courier_costs     one row per order: what the courier kept and
--                           what reached Naeem (the later profit batch reads
--                           this).
--   steadfast_sync_state    one row: Steadfast's current balance and when
--                           it was last read.
--   steadfast_unpaid_orders()  delivered Steadfast orders not in any payout
--                           after N days (the amber alert).
--   'view_profit_costs'     a new staff switch "View profit & costs", Off
--                           for everyone (no existing role or person gets
--                           it).
--
-- Who can read: only staff_can('view_profit_costs') — the Super Admin
-- always, staff only with that switch On. Nobody can write these tables
-- from the website; only the Steadfast functions (service role) fill them.
--
-- Money never counts twice: the existing "COD via Steadfast" payment row
-- stays the record that the customer paid. These tables only record the
-- courier settling that money.
--
-- Additive only: new tables, new functions, one more name in the staff
-- permission list. Nothing existing is dropped, renamed or changed. Safe
-- to run more than once.
-- ============================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- The new staff switch (appended at the end; every role and person keeps
-- exactly the permissions they have, so it is Off for everyone).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION staff_permission_names()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'view_orders', 'change_order_status', 'create_orders', 'book_steadfast',
    'edit_products', 'edit_categories', 'view_customers', 'delete_early_orders',
    'view_wholesalers', 'see_sales', 'edit_brands', 'edit_customer_notes',
    'edit_orders', 'manage_customers', 'view_profit_costs'
  ];
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS steadfast_payouts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  steadfast_payment_id  text NOT NULL UNIQUE,
  paid_at               timestamptz,
  total_amount          numeric(12,2) NOT NULL DEFAULT 0,
  parcel_count          integer NOT NULL DEFAULT 0,
  steadfast_status      text,
  -- Steadfast's own answer, kept as it came.
  raw                   jsonb,
  -- true once the parcels inside it were read.
  items_synced          boolean NOT NULL DEFAULT false,
  first_synced_at       timestamptz NOT NULL DEFAULT now(),
  last_synced_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_steadfast_payouts_paid_at ON steadfast_payouts (paid_at DESC);

CREATE TABLE IF NOT EXISTS steadfast_payout_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id        uuid NOT NULL REFERENCES steadfast_payouts(id) ON DELETE CASCADE,
  -- "c:<consignment id>" (or "i:<invoice>"), unique inside one payout.
  item_key         text NOT NULL,
  consignment_id   text,
  -- The invoice we booked with = our order number.
  invoice          text,
  order_id         uuid REFERENCES orders(id) ON DELETE SET NULL,
  cod_collected    numeric(12,2) NOT NULL DEFAULT 0,
  delivery_charge  numeric(12,2) NOT NULL DEFAULT 0,
  cod_fee          numeric(12,2) NOT NULL DEFAULT 0,
  other_deduction  numeric(12,2) NOT NULL DEFAULT 0,
  net_paid         numeric(12,2) NOT NULL DEFAULT 0,
  -- The COD we expected (what the parcel was booked with).
  expected_cod     numeric(12,2),
  -- true = Steadfast's answer had no COD fee; it was worked out as 1%.
  fee_estimated    boolean NOT NULL DEFAULT false,
  match_status     text NOT NULL DEFAULT 'to_check' CHECK (match_status IN ('matched', 'to_check')),
  match_reason     text CHECK (match_reason IS NULL OR match_reason IN ('cod_differs', 'order_not_found', 'order_cancelled', 'duplicate')),
  note             text,
  raw              jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payout_id, item_key)
);

CREATE INDEX IF NOT EXISTS idx_payout_items_order ON steadfast_payout_items (order_id);
CREATE INDEX IF NOT EXISTS idx_payout_items_consignment ON steadfast_payout_items (consignment_id);
CREATE INDEX IF NOT EXISTS idx_payout_items_invoice ON steadfast_payout_items (invoice);

CREATE TABLE IF NOT EXISTS order_courier_costs (
  order_id         uuid PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  courier          text NOT NULL DEFAULT 'steadfast',
  cod_collected    numeric(12,2) NOT NULL DEFAULT 0,
  delivery_charge  numeric(12,2) NOT NULL DEFAULT 0,
  cod_fee          numeric(12,2) NOT NULL DEFAULT 0,
  other_deduction  numeric(12,2) NOT NULL DEFAULT 0,
  -- delivery charge + COD fee + other
  total_kept       numeric(12,2) NOT NULL DEFAULT 0,
  net_received     numeric(12,2) NOT NULL DEFAULT 0,
  payout_id        uuid REFERENCES steadfast_payouts(id) ON DELETE SET NULL,
  paid_at          timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS steadfast_sync_state (
  id               integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  current_balance  numeric(12,2),
  balance_at       timestamptz,
  last_sync_at     timestamptz,
  last_sync_error  text
);

-- ---------------------------------------------------------------------------
-- Who can read (RLS). No INSERT / UPDATE / DELETE policy: only the service
-- role (the Steadfast functions) writes.
-- ---------------------------------------------------------------------------
ALTER TABLE steadfast_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE steadfast_payout_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_courier_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE steadfast_sync_state ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON steadfast_payouts, steadfast_payout_items, order_courier_costs, steadfast_sync_state FROM anon, authenticated;
GRANT SELECT ON steadfast_payouts, steadfast_payout_items, order_courier_costs, steadfast_sync_state TO authenticated;
GRANT ALL ON steadfast_payouts, steadfast_payout_items, order_courier_costs, steadfast_sync_state TO service_role;

DROP POLICY IF EXISTS steadfast_payouts_read ON steadfast_payouts;
CREATE POLICY steadfast_payouts_read ON steadfast_payouts
  FOR SELECT TO authenticated USING (staff_can('view_profit_costs'));

DROP POLICY IF EXISTS steadfast_payout_items_read ON steadfast_payout_items;
CREATE POLICY steadfast_payout_items_read ON steadfast_payout_items
  FOR SELECT TO authenticated USING (staff_can('view_profit_costs'));

DROP POLICY IF EXISTS order_courier_costs_read ON order_courier_costs;
CREATE POLICY order_courier_costs_read ON order_courier_costs
  FOR SELECT TO authenticated USING (staff_can('view_profit_costs'));

DROP POLICY IF EXISTS steadfast_sync_state_read ON steadfast_sync_state;
CREATE POLICY steadfast_sync_state_read ON steadfast_sync_state
  FOR SELECT TO authenticated USING (staff_can('view_profit_costs'));

-- ---------------------------------------------------------------------------
-- Delivered more than p_days ago (Dhaka time doesn't matter for a day
-- count) and not in any payout. The delivered time is the order's
-- "delivered" history row, else its last update. Only orders delivered
-- after the oldest payout we know about are counted — older ones were paid
-- before the history Steadfast still shows. Nothing until the first sync.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION steadfast_unpaid_orders(p_days integer DEFAULT 7)
RETURNS TABLE (order_id uuid, order_number text, delivered_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_oldest timestamptz;
BEGIN
  IF NOT staff_can('view_profit_costs') THEN
    RETURN;
  END IF;
  SELECT min(p.paid_at) INTO v_oldest FROM steadfast_payouts p WHERE p.items_synced;
  IF v_oldest IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  WITH delivered AS (
    SELECT o.id, o.order_number, o.steadfast_consignment_id,
           COALESCE((SELECT max(h.changed_at) FROM order_status_history h
                     WHERE h.order_id = o.id AND h.new_status = 'delivered'), o.updated_at) AS at
    FROM orders o
    WHERE o.status = 'delivered'
      AND o.steadfast_consignment_id IS NOT NULL
  )
  SELECT d.id, d.order_number, d.at
  FROM delivered d
  WHERE d.at < now() - make_interval(days => GREATEST(p_days, 0))
    AND d.at >= v_oldest
    AND NOT EXISTS (
      SELECT 1 FROM steadfast_payout_items i
      WHERE i.order_id = d.id
         OR i.consignment_id = d.steadfast_consignment_id
         OR upper(i.invoice) = upper(d.order_number)
    )
  ORDER BY d.at;
END;
$$;

REVOKE ALL ON FUNCTION steadfast_unpaid_orders(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION steadfast_unpaid_orders(integer) TO authenticated;

COMMIT;

-- Tell the API about the new tables and functions straight away.
NOTIFY pgrst, 'reload schema';
