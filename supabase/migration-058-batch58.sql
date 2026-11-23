-- ============================================================
-- Migration 058 — Batch 58: every screen tells the same truth
-- ============================================================
-- Fixes the Batch 57 audit findings (reports/batch-57.txt).
--
-- PART 1 — one profit engine, one date rule
--  * money_order_parts_for(): ONE place that says, per order, its sale,
--    cost, delivery, courier and the moment it counts. The Sales profit
--    page, the Money page, Home, Reports (P&L, Charts, Products,
--    Customers), the investor report and the order's Profit card all read
--    it.
--  * Every part counts only ON OR AFTER money_start_date(): sales (by the
--    delivered / returned date), expenses, write-offs, investor profit
--    share, withdrawals, owner money in, old Kaarbar bills and cost
--    adjustments. Moving the start date is the only thing needed for every
--    number to follow it.
--  * An item with no known cost no longer removes its order from profit:
--    the sale, delivery and courier count; the missing cost counts as ৳0
--    and the order is flagged (items_missing_cost).
--  * Orders placed before the start date and delivered after it count in
--    the month they were delivered. The opening balance now holds the
--    cost of their goods (not their full price), so nothing is counted
--    twice and the balance check still balances.
--
-- PART 2 — the balance check
--  * Goods on open orders are valued at the lot row's landed cost.
--  * "Sold without stock" uses the same cost as profit.
--  * The expected courier fee is frozen once (order_courier_expected) and
--    is owed under To give as "Courier (not billed yet)".
--  * Steadfast bills paid outside a payout are owed until recorded
--    (money_record_courier_bill: a money movement out of an account).
--  * The "outside orders" term keeps only orders whose sale is inside the
--    opening balances (sold before the start date) and unmatched parcels.
--  * Tolerance ৳0.01 (was ৳1).
--
-- PART 3 — smaller fixes
--  * A cancelled order Steadfast charged for shows the charge on its
--    Profit card.
--  * money_customer_dues returns credit (paid more than owed).
--  * A locked month never changes: a later courier bill / cost change on
--    an order counted in a locked month is posted as an adjustment on the
--    day it happens (money_lock_adjustments).
--  * Deleting a delivered / returned order writes an Activity Log line.
--  * Investor share this month / this year follow the start date.
--  * Wording: "All figures match" in the month-lock checklist.
--
-- Additive; nothing is dropped except money_customer_dues, which is
-- re-created at once with one more column. Safe to run more than once.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------------
-- 1. Tables
-- ------------------------------------------------------------------

-- A Steadfast bill paid outside a payout, recorded from the order page.
ALTER TABLE money_movements DROP CONSTRAINT IF EXISTS money_movements_type_check;
ALTER TABLE money_movements ADD CONSTRAINT money_movements_type_check CHECK (type = ANY (ARRAY[
  'opening_balance', 'expense', 'transfer_out', 'transfer_in', 'investor_in', 'investor_profit_share',
  'investor_capital_back', 'owner_withdrawal', 'owner_money_in', 'non_business_in', 'non_business_out',
  'supplier_payment', 'steadfast_payout_in', 'adjustment', 'lot_payment', 'courier_bill_payment']));
CREATE INDEX IF NOT EXISTS money_movements_courier_bill_idx ON money_movements (order_id) WHERE type = 'courier_bill_payment';

-- The expected courier fee of a delivered parcel, frozen once.
CREATE TABLE IF NOT EXISTS order_courier_expected (
  order_id      uuid PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  amount        numeric(12, 2) NOT NULL,
  delivery_bill numeric(12, 2) NOT NULL DEFAULT 0,
  cod_fee       numeric(12, 2) NOT NULL DEFAULT 0,
  frozen_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE order_courier_expected ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS order_courier_expected_read ON order_courier_expected;
CREATE POLICY order_courier_expected_read ON order_courier_expected FOR SELECT TO authenticated
  USING (staff_can('view_profit_costs'));
REVOKE INSERT, UPDATE, DELETE ON order_courier_expected FROM anon, authenticated;

-- What each order counted in a locked month added, as last seen.
CREATE TABLE IF NOT EXISTS money_lock_order_values (
  order_id     uuid PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  month        date NOT NULL,
  counted_date date NOT NULL,
  sale         numeric NOT NULL DEFAULT 0,
  cost         numeric NOT NULL DEFAULT 0,
  delivery     numeric NOT NULL DEFAULT 0,
  courier      numeric NOT NULL DEFAULT 0,
  synced_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS money_lock_order_values_month_idx ON money_lock_order_values (month);
ALTER TABLE money_lock_order_values ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS money_lock_order_values_read ON money_lock_order_values;
CREATE POLICY money_lock_order_values_read ON money_lock_order_values FOR SELECT TO authenticated USING (money_can_view());
REVOKE INSERT, UPDATE, DELETE ON money_lock_order_values FROM anon, authenticated;

-- A change to a locked month's order, posted on the day it happened.
-- d_* = live − what the locked month showed; amount = the profit change.
CREATE TABLE IF NOT EXISTS money_lock_adjustments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  posted_date         date NOT NULL,
  affects_date        date NOT NULL,
  order_id            uuid REFERENCES orders(id) ON DELETE SET NULL,
  order_number        text,
  d_sale              numeric NOT NULL DEFAULT 0,
  d_cost              numeric NOT NULL DEFAULT 0,
  d_delivery          numeric NOT NULL DEFAULT 0,
  d_courier           numeric NOT NULL DEFAULT 0,
  amount              numeric NOT NULL,
  note                text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by_username text
);
CREATE INDEX IF NOT EXISTS money_lock_adjustments_posted_idx ON money_lock_adjustments (posted_date);
CREATE INDEX IF NOT EXISTS money_lock_adjustments_affects_idx ON money_lock_adjustments (affects_date);
ALTER TABLE money_lock_adjustments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS money_lock_adjustments_read ON money_lock_adjustments;
CREATE POLICY money_lock_adjustments_read ON money_lock_adjustments FOR SELECT TO authenticated USING (money_can_view());
REVOKE INSERT, UPDATE, DELETE ON money_lock_adjustments FROM anon, authenticated;

-- ------------------------------------------------------------------
-- 2. Movement type labels
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION money_type_sign(p_type text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE
    WHEN p_type IN ('expense', 'transfer_out', 'investor_profit_share', 'investor_capital_back',
                    'owner_withdrawal', 'non_business_out', 'supplier_payment', 'lot_payment',
                    'courier_bill_payment') THEN -1
    WHEN p_type IN ('transfer_in', 'investor_in', 'owner_money_in', 'non_business_in', 'steadfast_payout_in') THEN 1
    ELSE 0
  END;
$function$;

CREATE OR REPLACE FUNCTION money_type_label(p_type text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE p_type
    WHEN 'opening_balance' THEN 'Opening balance'
    WHEN 'expense' THEN 'Expense'
    WHEN 'transfer_out' THEN 'Moved out'
    WHEN 'transfer_in' THEN 'Moved in'
    WHEN 'investor_in' THEN 'Investor money in'
    WHEN 'investor_profit_share' THEN 'Investor profit share'
    WHEN 'investor_capital_back' THEN 'Investor capital returned'
    WHEN 'owner_withdrawal' THEN 'My withdrawal'
    WHEN 'owner_money_in' THEN 'My money put in'
    WHEN 'non_business_in' THEN 'Not shop money in'
    WHEN 'non_business_out' THEN 'Not shop money out'
    WHEN 'supplier_payment' THEN 'Paid what I owe'
    WHEN 'steadfast_payout_in' THEN 'Steadfast payout'
    WHEN 'adjustment' THEN 'Count difference'
    WHEN 'lot_payment' THEN 'Paid for a lot'
    WHEN 'courier_bill_payment' THEN 'Steadfast bill paid'
    WHEN 'customer_payment' THEN 'Customer payment'
    WHEN 'customer_refund' THEN 'Refund to customer'
    WHEN 'previous_balance_payment' THEN 'Previous balance paid'
    WHEN 'steadfast_payout_out' THEN 'Paid out by Steadfast'
    WHEN 'courier_fees' THEN 'Courier & COD fees (in order profit)'
    WHEN 'steadfast_unmatched' THEN 'Steadfast parcel not matched to an order'
    WHEN 'steadfast_courier_only' THEN 'Courier only, not a shop sale'
    ELSE p_type
  END;
$function$;

-- ------------------------------------------------------------------
-- 3. Courier: the expected fee is frozen once
-- ------------------------------------------------------------------
-- Same rule as Batch 53 (last 10 bills of the zone, or the Settings fee
-- when there are fewer than 3, + 1% COD fee). Once frozen
-- (order_courier_expected) the stored value is used and never moves; the
-- real Steadfast bill replaces it when it comes.
CREATE OR REPLACE FUNCTION order_courier_costs_for(p_ids uuid[])
 RETURNS TABLE(order_id uuid, amount numeric, kind text, delivery_bill numeric, cod_fee numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH zone_history AS (
    SELECT z.zone, count(*) AS n, avg(z.bill) AS bill
    FROM (
      SELECT o.delivery_zone AS zone, cc.delivery_charge + cc.bill_paid_separately AS bill,
             row_number() OVER (PARTITION BY o.delivery_zone ORDER BY o.created_at DESC, o.order_number DESC) AS rn
      FROM order_courier_costs cc
      JOIN orders o ON o.id = cc.order_id
      WHERE o.status = 'delivered' AND o.delivery_zone IN ('inside_dhaka', 'outside_dhaka')
    ) z
    WHERE z.rn <= 10
    GROUP BY z.zone
  ), parcels AS (
    SELECT i.payout_id, count(*) AS n
    FROM steadfast_payout_items i
    WHERE i.payout_id IN (SELECT c.payout_id FROM order_courier_costs c WHERE c.order_id = ANY (p_ids))
    GROUP BY i.payout_id
  ), expected AS (
    SELECT o.id,
           round(CASE WHEN h.n >= 3 THEN h.bill
                      ELSE COALESCE(courier_zone_fee(o.delivery_zone), o.delivery_fee) END) AS bill,
           COALESCE(o.steadfast_cod_amount, 0) AS cod
    FROM orders o
    LEFT JOIN zone_history h ON h.zone = o.delivery_zone
    WHERE o.id = ANY (p_ids)
  ), kinds AS (
    SELECT o.id,
           CASE
             WHEN cc.order_id IS NOT NULL THEN CASE WHEN p.n = 1 THEN 'exact' ELSE 'share' END
             WHEN o.delivery_zone = 'hand_delivered' THEN 'none'
             WHEN o.steadfast_consignment_id IS NULL THEN 'not_booked'
             WHEN o.status = 'delivered' THEN 'expected'
             ELSE 'unknown'
           END AS kind,
           cc.total_kept, cc.delivery_charge, cc.other_deduction, cc.bill_paid_separately, cc.cod_fee,
           COALESCE(f.delivery_bill, e.bill) AS bill,
           COALESCE(f.cod_fee, round(0.01 * GREATEST(e.cod - e.bill, 0))) AS exp_fee
    FROM orders o
    LEFT JOIN order_courier_costs cc ON cc.order_id = o.id
    LEFT JOIN parcels p ON p.payout_id = cc.payout_id
    LEFT JOIN expected e ON e.id = o.id
    LEFT JOIN order_courier_expected f ON f.order_id = o.id
    WHERE o.id = ANY (p_ids)
  )
  SELECT k.id,
         CASE k.kind WHEN 'exact' THEN k.total_kept WHEN 'share' THEN k.total_kept
                     WHEN 'expected' THEN COALESCE(k.bill, 0) + COALESCE(k.exp_fee, 0) ELSE 0 END,
         k.kind,
         CASE WHEN k.kind IN ('exact', 'share') THEN k.delivery_charge + k.other_deduction + k.bill_paid_separately
              WHEN k.kind = 'expected' THEN COALESCE(k.bill, 0) ELSE 0 END,
         CASE WHEN k.kind IN ('exact', 'share') THEN k.cod_fee
              WHEN k.kind = 'expected' THEN COALESCE(k.exp_fee, 0) ELSE 0 END
  FROM kinds k;
$function$;
REVOKE ALL ON FUNCTION order_courier_costs_for(uuid[]) FROM PUBLIC, anon, authenticated;

-- Freeze the expected fee when a booked parcel becomes Delivered (or is
-- booked after it was delivered) and Steadfast has not billed it yet.
CREATE OR REPLACE FUNCTION order_courier_freeze_expected()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'delivered' AND NEW.steadfast_consignment_id IS NOT NULL
     AND NEW.delivery_zone IS DISTINCT FROM 'hand_delivered'
     AND NOT EXISTS (SELECT 1 FROM order_courier_expected f WHERE f.order_id = NEW.id)
     AND NOT EXISTS (SELECT 1 FROM order_courier_costs cc WHERE cc.order_id = NEW.id) THEN
    INSERT INTO order_courier_expected (order_id, amount, delivery_bill, cod_fee)
    SELECT c.order_id, c.amount, c.delivery_bill, c.cod_fee
    FROM order_courier_costs_for(ARRAY[NEW.id]) c
    WHERE c.kind = 'expected'
    ON CONFLICT (order_id) DO NOTHING;
  END IF;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION order_courier_freeze_expected() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS orders_courier_expected ON orders;
CREATE TRIGGER orders_courier_expected
  AFTER INSERT OR UPDATE OF status, steadfast_consignment_id, delivery_zone ON orders
  FOR EACH ROW EXECUTE FUNCTION order_courier_freeze_expected();

-- One-time: freeze today's value for parcels delivered and still
-- "expected" (the value the site shows today). Runs again harmlessly.
INSERT INTO order_courier_expected (order_id, amount, delivery_bill, cod_fee)
SELECT c.order_id, c.amount, c.delivery_bill, c.cod_fee
FROM order_courier_costs_for(ARRAY(SELECT o.id FROM orders o WHERE o.status = 'delivered')) c
WHERE c.kind = 'expected'
ON CONFLICT (order_id) DO NOTHING;

-- ------------------------------------------------------------------
-- 4. One engine: each order's parts
-- ------------------------------------------------------------------
-- Cost of an order's goods (stored cost per line; a line with no cost
-- counts ৳0) — the same sum as the cost profit uses.
CREATE OR REPLACE FUNCTION money_order_goods_cost(p_order_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(sum(round(COALESCE(c.unit_cost_bdt, 0) * oi.quantity, 2)), 0)
  FROM order_items oi
  LEFT JOIN order_item_costs c ON c.order_item_id = oi.id
  WHERE oi.order_id = p_order_id;
$function$;
REVOKE ALL ON FUNCTION money_order_goods_cost(uuid) FROM PUBLIC, anon, authenticated;

-- How an order stands against the opening balances:
--   after  — placed on / after the start date (or no start date)
--   lots   — placed before it, stock taken from lots (goods in the opening stock)
--   closed — cancelled / returned at the start date
--   sold   — delivered before the start date: its sale is in the opening
--   open   — placed before it, not taken from lots, not delivered yet at
--            the start date: the opening holds the cost of its goods; its
--            sale counts when it is delivered.
CREATE OR REPLACE FUNCTION money_order_opening_kind(p_order_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN money_start_date() IS NULL OR o.created_at >= money_start_ts() THEN 'after'
    WHEN money_order_costed(o.id) THEN 'lots'
    WHEN money_order_status_at(o.id, money_start_ts()) IN ('cancelled', 'returned') THEN 'closed'
    WHEN COALESCE((SELECT max(h.changed_at) FROM order_status_history h
                   WHERE h.order_id = o.id AND h.new_status = 'delivered' AND h.old_status IS DISTINCT FROM 'delivered'),
                  CASE WHEN o.status = 'delivered' THEN o.updated_at END) < money_start_ts() THEN 'sold'
    ELSE 'open'
  END
  FROM orders o WHERE o.id = p_order_id;
$function$;
REVOKE ALL ON FUNCTION money_order_opening_kind(uuid) FROM PUBLIC, anon, authenticated;

-- Per order: does it count, when, and its sale / cost / delivery /
-- courier. Every profit number is a sum of these rows.
CREATE OR REPLACE FUNCTION money_order_parts_for(p_ids uuid[])
 RETURNS TABLE(order_id uuid, order_number text, status text, counts boolean, counted_at timestamptz,
               sale numeric, discount numeric, delivery numeric, courier numeric, courier_known boolean,
               courier_kind text, cost numeric, provisional numeric, costed boolean, items_missing integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH base AS (
    SELECT o.id, o.order_number, o.status, o.discount,
           (o.status IN ('delivered', 'returned') OR (o.status = 'cancelled' AND cc.order_id IS NOT NULL)) AS counts,
           -- A cancelled order Steadfast charged for counts the charge on the payout's date.
           COALESCE(inventory_order_counted_at(o.id, o.status), CASE WHEN o.status = 'cancelled' THEN cc.paid_at END) AS at,
           CASE WHEN o.status = 'delivered' THEN GREATEST(o.subtotal - o.discount, 0) ELSE 0 END AS sale,
           CASE WHEN o.status = 'delivered' THEN o.delivery_fee ELSE 0 END AS delivery,
           COALESCE(cc.total_kept, 0) AS kept,
           cc.order_id IS NOT NULL AS known
    FROM orders o
    LEFT JOIN order_courier_costs cc ON cc.order_id = o.id
    WHERE o.id = ANY (p_ids)
  ), items AS (
    SELECT c.order_id, sum(c.cost) AS cost, sum(c.provisional) AS prov, bool_and(c.costed) AS costed,
           (count(*) FILTER (WHERE NOT c.costed))::integer AS missing
    FROM inventory_item_costs(p_ids) c
    GROUP BY c.order_id
  )
  SELECT b.id, b.order_number, b.status, b.counts, b.at, b.sale, b.discount, b.delivery,
         CASE WHEN b.status = 'delivered' THEN COALESCE(k.amount, 0) ELSE b.kept END,
         b.known OR k.kind = 'none',
         CASE WHEN b.status = 'delivered' OR b.known OR k.kind IN ('none', 'not_booked') THEN k.kind ELSE 'unknown' END,
         CASE WHEN b.status = 'delivered' THEN COALESCE(i.cost, 0) ELSE 0 END,
         CASE WHEN b.status = 'delivered' THEN COALESCE(i.prov, 0) ELSE 0 END,
         COALESCE(i.costed, false),
         CASE WHEN b.status = 'delivered' THEN COALESCE(i.missing, 0) ELSE 0 END
  FROM base b
  LEFT JOIN items i ON i.order_id = b.id
  LEFT JOIN order_courier_costs_for(p_ids) k ON k.order_id = b.id;
$function$;
REVOKE ALL ON FUNCTION money_order_parts_for(uuid[]) FROM PUBLIC, anon, authenticated;

-- The Sales profit engine. p_for_money is kept for the callers; the rule
-- is now the same for every screen.
CREATE OR REPLACE FUNCTION inventory_sales_profit_core(p_from date, p_to date, p_for_money boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_start    date := money_start_date();
  v_ts       timestamptz := money_start_ts();
  v_ids      uuid[];
  v_orders   jsonb;
  v_products jsonb;
  v_adjust   jsonb;
  v_totals   jsonb;
  v_adj_sum  numeric;
  v_ret      numeric;
  v_ret_n    integer;
  v_fix      record;
  v_posted   numeric;
BEGIN
  IF NOT staff_can('view_profit_costs') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION 'Pick a date range.';
  END IF;

  -- Orders that count in these dates, on or after the money start date.
  SELECT COALESCE(array_agg(o.id), '{}') INTO v_ids
  FROM orders o
  LEFT JOIN order_courier_costs cc ON cc.order_id = o.id
  CROSS JOIN LATERAL (SELECT COALESCE(inventory_order_counted_at(o.id, o.status),
                                     CASE WHEN o.status = 'cancelled' THEN cc.paid_at END) AS at) x
  WHERE (o.status IN ('delivered', 'returned') OR (o.status = 'cancelled' AND cc.order_id IS NOT NULL))
    AND (x.at AT TIME ZONE 'Asia/Dhaka')::date BETWEEN p_from AND p_to
    AND (v_ts IS NULL OR x.at >= v_ts);

  CREATE TEMP TABLE IF NOT EXISTS _sp58_orders (
    id uuid, order_number text, status text, counted_at timestamptz, sale numeric, discount numeric,
    delivery numeric, courier numeric, courier_known boolean, courier_kind text, cost numeric,
    provisional numeric, costed boolean, items_missing integer
  ) ON COMMIT DROP;
  TRUNCATE _sp58_orders;
  INSERT INTO _sp58_orders (id, order_number, status, counted_at, sale, discount, delivery, courier, courier_known,
                            courier_kind, cost, provisional, costed, items_missing)
  SELECT p.order_id, p.order_number, p.status, p.counted_at, p.sale, p.discount, p.delivery, p.courier, p.courier_known,
         p.courier_kind, p.cost, p.provisional, p.costed, p.items_missing
  FROM money_order_parts_for(v_ids) p;

  CREATE TEMP TABLE IF NOT EXISTS _sp_items (
    order_item_id uuid, order_id uuid, product_id uuid, variant_id uuid, label text, line_total numeric,
    units integer, cost numeric, provisional numeric, costed boolean
  ) ON COMMIT DROP;
  TRUNCATE _sp_items;
  INSERT INTO _sp_items SELECT * FROM inventory_item_costs(v_ids);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'order_id', id, 'order_number', order_number, 'status', status, 'counted_at', counted_at,
           'sale', sale, 'cost', cost, 'provisional', provisional, 'delivery', delivery,
           'courier', courier, 'courier_known', courier_known, 'courier_kind', courier_kind,
           'costed', items_missing = 0, 'items_missing', items_missing,
           'profit', sale - cost + delivery - courier,
           'margin', CASE WHEN sale > 0 THEN round((sale - cost + delivery - courier) / sale * 100, 1) END)
         ORDER BY counted_at DESC, order_number DESC), '[]'::jsonb)
  INTO v_orders FROM _sp58_orders;

  -- Per product: every delivered order (a line with no cost counts ৳0).
  WITH lines AS (
    SELECT i.*, o.discount AS order_discount, o.id AS oid
    FROM _sp_items i JOIN _sp58_orders o ON o.id = i.order_id
    WHERE o.status = 'delivered'
  ), paisa AS (
    SELECT l.*, round(l.line_total * 100) AS lp, round(l.order_discount * 100) AS dp,
           sum(round(l.line_total * 100)) OVER (PARTITION BY l.oid) AS tp
    FROM lines l
  ), floors AS (
    SELECT p.*,
           CASE WHEN p.tp > 0 THEN div(LEAST(p.dp, p.tp) * p.lp, p.tp) ELSE 0 END AS d_floor,
           CASE WHEN p.tp > 0 THEN mod(LEAST(p.dp, p.tp) * p.lp, p.tp) ELSE 0 END AS d_rem
    FROM paisa p
  ), ranked AS (
    SELECT f.*,
           row_number() OVER (PARTITION BY f.oid ORDER BY f.d_rem DESC, f.order_item_id) AS d_rank,
           LEAST(f.dp, f.tp) - sum(f.d_floor) OVER (PARTITION BY f.oid) AS d_left
    FROM floors f
  ), shared AS (
    SELECT r.product_id, r.variant_id, r.label, r.units, r.cost,
           (r.lp - r.d_floor - CASE WHEN r.d_rank <= r.d_left THEN 1 ELSE 0 END) / 100.0 AS sale
    FROM ranked r
  ), per_product AS (
    SELECT s.product_id, s.variant_id, min(s.label) AS label, sum(s.units)::bigint AS units,
           round(sum(s.sale), 2) AS sales, round(sum(s.cost), 2) AS cost
    FROM shared s
    GROUP BY s.product_id, s.variant_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'product_id', product_id, 'variant_id', variant_id, 'label', label, 'units', units,
           'stock_unit', inventory_stock_unit(product_id, variant_id),
           'pack_size', inventory_pack_size(product_id, variant_id),
           'sales', sales, 'cost', cost, 'profit', sales - cost,
           'margin', CASE WHEN sales > 0 THEN round((sales - cost) / sales * 100, 1) END)
         ORDER BY sales - cost DESC, label), '[]'::jsonb)
  INTO v_products FROM per_product;

  SELECT COALESCE(sum(amount_bdt), 0),
         COALESCE(jsonb_agg(jsonb_build_object('date', adj_date, 'amount', amount_bdt, 'reason', reason, 'note', note)
                            ORDER BY adj_date, created_at), '[]'::jsonb)
  INTO v_adj_sum, v_adjust
  FROM cost_adjustments WHERE adj_date BETWEEN p_from AND p_to
    AND (v_start IS NULL OR adj_date >= v_start)
    -- Batch 45: a sale's cost is stored on the sale; these old corrections
    -- are already inside it.
    AND reason NOT IN ('late_bill', 'shortfall_filled', 'given_back');

  -- Locked months: an order counted in a locked month keeps the numbers
  -- it had when the month was locked; the later change is posted on the
  -- day it happened (money_lock_adjustments).
  SELECT COALESCE(sum(d_sale), 0) AS s, COALESCE(sum(d_cost), 0) AS c,
         COALESCE(sum(d_delivery), 0) AS d, COALESCE(sum(d_courier), 0) AS k
  INTO v_fix
  FROM money_lock_adjustments
  WHERE affects_date BETWEEN p_from AND p_to AND (v_start IS NULL OR affects_date >= v_start);
  SELECT COALESCE(sum(amount), 0) INTO v_posted
  FROM money_lock_adjustments
  WHERE posted_date BETWEEN p_from AND p_to AND (v_start IS NULL OR posted_date >= v_start);

  SELECT jsonb_build_object(
           'orders', count(*),
           'uncosted_orders', count(*) FILTER (WHERE status = 'delivered' AND items_missing > 0),
           'items_missing_cost', COALESCE(sum(items_missing), 0),
           'sales', COALESCE(sum(sale), 0) - v_fix.s,
           'cost', COALESCE(sum(cost), 0) - v_fix.c,
           'provisional', COALESCE(sum(provisional), 0),
           'delivery', COALESCE(sum(delivery), 0) - v_fix.d,
           'courier', COALESCE(sum(courier), 0) - v_fix.k,
           'adjustments', v_adj_sum,
           'locked_adjustments', v_posted)
  INTO v_totals FROM _sp58_orders;

  -- Batch 46: a returned parcel whose order was deleted (its payout line is
  -- marked "returned"): no sale; Steadfast's charge is a courier cost on
  -- the payout's date, with the other returned parcels' charges.
  SELECT COALESCE(sum(i.delivery_charge + i.cod_fee + i.other_deduction + i.bill_paid_separately), 0), count(*)
  INTO v_ret, v_ret_n
  FROM steadfast_payout_items i JOIN steadfast_payouts sp ON sp.id = i.payout_id
  WHERE i.line_kind = 'returned' AND i.order_id IS NULL
    AND (sp.paid_at AT TIME ZONE 'Asia/Dhaka')::date BETWEEN p_from AND p_to
    AND (v_ts IS NULL OR sp.paid_at >= v_ts);
  v_totals := v_totals || jsonb_build_object(
    'courier', (v_totals ->> 'courier')::numeric + v_ret,
    'courier_no_order', v_ret, 'returned_no_order', v_ret_n);

  v_totals := v_totals || jsonb_build_object(
    'profit', (v_totals ->> 'sales')::numeric - (v_totals ->> 'cost')::numeric + (v_totals ->> 'delivery')::numeric
              - (v_totals ->> 'courier')::numeric - v_adj_sum + v_posted);
  v_totals := v_totals || jsonb_build_object(
    'margin', CASE WHEN (v_totals ->> 'sales')::numeric > 0
                   THEN round((v_totals ->> 'profit')::numeric / (v_totals ->> 'sales')::numeric * 100, 1) END);

  RETURN jsonb_build_object('from', p_from, 'to', p_to, 'totals', v_totals,
                            'orders', v_orders, 'products', v_products, 'adjustments', v_adjust,
                            'start_date', v_start);
END;
$function$;

-- Old Kaarbar bills follow the same date rule (counted only on or after
-- the money start date).
CREATE OR REPLACE FUNCTION kaarbar_old_lines(p_from date, p_to date)
 RETURNS TABLE(bill_id uuid, bill_date date, line_id uuid, item_id uuid, product_id uuid, variant_id uuid, label text, quantity numeric, unit text, sign integer, line_total numeric, discount_share numeric, sale numeric, cost numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH lines AS (
    SELECT b.id AS bid, b.bill_date AS bdate, CASE WHEN b.kind = 'return' THEN -1 ELSE 1 END AS sg,
           b.bill_discount, l.id AS lid, l.item_id AS iid, i.product_id AS pid, i.variant_id AS vid,
           COALESCE(report_unit_label(i.product_id, i.variant_id), l.kaarbar_name) AS lbl,
           l.quantity AS qty, l.unit AS u, l.line_total AS lt,
           l.quantity * COALESCE(kaarbar_line_unit_cost(i, l.unit), 0) AS c
    FROM kaarbar_bills b
    JOIN kaarbar_bill_lines l ON l.bill_id = b.id
    JOIN kaarbar_items i ON i.id = l.item_id
    WHERE b.bill_date BETWEEN p_from AND p_to
      AND (money_start_date() IS NULL OR b.bill_date >= money_start_date())
  ), paisa AS (
    SELECT x.*, round(x.lt * 100) AS lp, round(x.bill_discount * 100) AS dp,
           sum(round(x.lt * 100)) OVER (PARTITION BY x.bid) AS tp
    FROM lines x
  ), floors AS (
    SELECT p.*,
           CASE WHEN p.tp > 0 THEN div(LEAST(p.dp, p.tp) * p.lp, p.tp) ELSE 0 END AS d_floor,
           CASE WHEN p.tp > 0 THEN mod(LEAST(p.dp, p.tp) * p.lp, p.tp) ELSE 0 END AS d_rem
    FROM paisa p
  ), ranked AS (
    SELECT f.*,
           row_number() OVER (PARTITION BY f.bid ORDER BY f.d_rem DESC, f.lid) AS d_rank,
           LEAST(f.dp, f.tp) - sum(f.d_floor) OVER (PARTITION BY f.bid) AS d_left
    FROM floors f
  )
  SELECT r.bid, r.bdate, r.lid, r.iid, r.pid, r.vid, r.lbl, r.qty, r.u, r.sg, r.lt,
         (r.d_floor + CASE WHEN r.d_rank <= r.d_left THEN 1 ELSE 0 END) / 100.0,
         r.sg * (r.lp - r.d_floor - CASE WHEN r.d_rank <= r.d_left THEN 1 ELSE 0 END) / 100.0,
         r.sg * round(r.c, 2)
  FROM ranked r;
$function$;

CREATE OR REPLACE FUNCTION kaarbar_old_parts(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH b AS (
    SELECT count(*) AS bills,
           COALESCE(sum(CASE WHEN kind = 'return' THEN -items_total ELSE items_total END), 0) AS gross,
           COALESCE(sum(CASE WHEN kind = 'return' THEN -bill_discount ELSE bill_discount END), 0) AS disc,
           COALESCE(sum(CASE WHEN kind = 'return' THEN -delivery ELSE delivery END), 0) AS delivery
    FROM kaarbar_bills
    WHERE bill_date BETWEEN p_from AND p_to
      AND (money_start_date() IS NULL OR bill_date >= money_start_date())
  ), c AS (
    SELECT COALESCE(sum(cost), 0) AS cost FROM kaarbar_old_lines(p_from, p_to)
  )
  SELECT jsonb_build_object(
    'old_bills', b.bills,
    'old_sales_gross', b.gross,
    'old_bill_discounts', b.disc,
    'old_sales', b.gross - b.disc,
    'old_cost', c.cost,
    'old_delivery', b.delivery,
    'old_profit', b.gross - b.disc - c.cost + b.delivery)
  FROM b, c;
$function$;

-- Kept for any caller: money_profit_parts already holds the old bills.
CREATE OR REPLACE FUNCTION kaarbar_pnl_with_old(p_parts jsonb, p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old    jsonb;
  v_profit numeric;
BEGIN
  IF p_parts ? 'old_profit' THEN
    RETURN p_parts;
  END IF;
  v_old := kaarbar_old_parts(p_from, p_to);
  v_profit := (v_old ->> 'old_profit')::numeric;
  RETURN p_parts || v_old || jsonb_build_object(
    'gross_profit', (p_parts ->> 'sales')::numeric - (p_parts ->> 'cost')::numeric
                    + (v_old ->> 'old_sales')::numeric - (v_old ->> 'old_cost')::numeric,
    'net_profit', (p_parts ->> 'net_profit')::numeric + v_profit,
    'your_profit', (p_parts ->> 'your_profit')::numeric + v_profit,
    'left_in_business', (p_parts ->> 'left_in_business')::numeric + v_profit);
END;
$function$;

-- THE profit function. Home, the Money page, Reports (P&L, Charts), the
-- investor report / PDF all read it.
CREATE OR REPLACE FUNCTION money_profit_parts(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_start    date := money_start_date();
  v_sales    jsonb;
  v_old      jsonb;
  v_exp      numeric;
  v_wo       numeric;
  v_share    numeric;
  v_with     numeric;
  v_own_in   numeric;
  v_nb       numeric;
  v_adj      numeric;
  v_lock     numeric;
  v_net      numeric;
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  v_sales := inventory_sales_profit_core(p_from, p_to, true) -> 'totals';
  SELECT COALESCE(-sum(amount) FILTER (WHERE type = 'expense'), 0),
         COALESCE(-sum(amount) FILTER (WHERE type = 'investor_profit_share'), 0),
         COALESCE(-sum(amount) FILTER (WHERE type = 'owner_withdrawal'), 0),
         COALESCE(sum(amount) FILTER (WHERE type = 'owner_money_in'), 0),
         COALESCE(sum(amount) FILTER (WHERE type IN ('non_business_in', 'non_business_out')), 0),
         COALESCE(sum(amount) FILTER (WHERE type = 'adjustment'), 0)
  INTO v_exp, v_share, v_with, v_own_in, v_nb, v_adj
  FROM money_movements
  WHERE entry_date BETWEEN p_from AND p_to
    AND (v_start IS NULL OR entry_date >= v_start);
  SELECT COALESCE(sum(cost_bdt), 0) INTO v_wo
  FROM stock_write_offs
  WHERE write_date BETWEEN p_from AND p_to AND (v_start IS NULL OR write_date >= v_start);
  v_old := kaarbar_old_parts(p_from, p_to);
  v_lock := COALESCE((v_sales ->> 'locked_adjustments')::numeric, 0);
  v_net := (v_sales ->> 'sales')::numeric - (v_sales ->> 'cost')::numeric + (v_sales ->> 'delivery')::numeric
           - (v_sales ->> 'courier')::numeric - (v_sales ->> 'adjustments')::numeric + v_lock - v_exp - v_wo
           + (v_old ->> 'old_profit')::numeric;
  RETURN v_old || jsonb_build_object(
    'from', p_from, 'to', p_to, 'start_date', v_start,
    'orders', (v_sales ->> 'orders')::integer, 'uncosted_orders', (v_sales ->> 'uncosted_orders')::integer,
    'items_missing_cost', COALESCE((v_sales ->> 'items_missing_cost')::integer, 0),
    'sales', (v_sales ->> 'sales')::numeric, 'cost', (v_sales ->> 'cost')::numeric,
    'provisional', (v_sales ->> 'provisional')::numeric,
    'delivery', (v_sales ->> 'delivery')::numeric, 'courier', (v_sales ->> 'courier')::numeric,
    'cost_adjustments', (v_sales ->> 'adjustments')::numeric,
    'locked_adjustments', v_lock,
    'gross_profit', (v_sales ->> 'sales')::numeric - (v_sales ->> 'cost')::numeric
                    + (v_old ->> 'old_sales')::numeric - (v_old ->> 'old_cost')::numeric,
    'expenses', v_exp, 'write_offs', v_wo, 'net_profit', v_net,
    'profit_share', v_share, 'your_profit', v_net - v_share,
    'withdrawals', v_with, 'left_in_business', v_net - v_share - v_with,
    'owner_money_in', v_own_in, 'not_shop_money', v_nb, 'count_differences', v_adj);
END;
$function$;

CREATE OR REPLACE FUNCTION report_profit_loss(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_parts  jsonb;
  v_months jsonb := '[]'::jsonb;
  v_m      record;
  v_p      jsonb;
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  PERFORM report_check_range(p_from, p_to);
  -- Batch 58: money_profit_parts holds everything (old Kaarbar bills too).
  v_parts := money_profit_parts(p_from, p_to);
  IF date_trunc('month', p_from) <> date_trunc('month', p_to) THEN
    FOR v_m IN SELECT * FROM report_months(p_from, p_to) LOOP
      v_p := money_profit_parts(v_m.m_from, v_m.m_to);
      v_months := v_months || (v_p || jsonb_build_object(
        'month', v_m.month,
        'expenses_by_category', report_expense_categories(v_m.m_from, v_m.m_to),
        'locked', money_month_locked(v_m.month)));
    END LOOP;
  END IF;
  RETURN jsonb_build_object(
    'from', p_from, 'to', p_to,
    'parts', v_parts,
    'expenses_by_category', report_expense_categories(p_from, p_to),
    'months', v_months,
    'locked_months', report_locked_in(p_from, p_to),
    'start_date', money_start_date());
END;
$function$;

-- Reports → Customers: profit of every counted order (nothing left out).
CREATE OR REPLACE FUNCTION report_customers(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := inventory_dhaka_today();
  v_start date := money_start_date();
  v_sp    jsonb;
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  PERFORM report_check_range(p_from, p_to);
  v_sp := inventory_sales_profit(p_from, p_to);
  RETURN (
    WITH keys AS (
      SELECT k.order_id, k.customer_key, k.due, o.created_at, o.customer_name, o.customer_phone,
             v_today - money_dhaka_date(o.created_at) AS age
      FROM order_customer_keys() k JOIN orders o ON o.id = k.order_id
    ), names AS (
      SELECT DISTINCT ON (customer_key) customer_key, customer_name, customer_phone
      FROM keys ORDER BY customer_key, created_at DESC
    ), aged AS (
      SELECT customer_key,
             sum(due) FILTER (WHERE age <= 30) AS d0,
             sum(due) FILTER (WHERE age BETWEEN 31 AND 60) AS d31,
             sum(due) FILTER (WHERE age > 60) AS d61,
             max(age) FILTER (WHERE due > 0) AS oldest
      FROM keys WHERE due > 0 GROUP BY customer_key
    ), dues AS (
      SELECT d.customer_key, d.phone_key, d.order_due, d.previous_left FROM money_customer_dues() d
      WHERE d.order_due <> 0 OR d.previous_left <> 0
    ), prev_age AS (
      SELECT CASE WHEN v_start IS NULL THEN 0 ELSE v_today - v_start END AS age
    ), sold AS (
      SELECT k.customer_key,
             sum((x ->> 'sale')::numeric) AS bought,
             sum((x ->> 'profit')::numeric) AS profit,
             count(*) FILTER (WHERE x ->> 'status' = 'delivered') AS orders
      FROM jsonb_array_elements(v_sp -> 'orders') x
      JOIN keys k ON k.order_id = (x ->> 'order_id')::uuid
      GROUP BY k.customer_key
    )
    SELECT jsonb_build_object(
      'from', p_from, 'to', p_to, 'today', v_today,
      'dues', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'customer_key', d.customer_key, 'name', COALESCE(n.customer_name, ''), 'phone', COALESCE(n.customer_phone, d.phone_key, ''),
                 'order_due', d.order_due, 'previous_left', d.previous_left, 'total', d.order_due + d.previous_left,
                 'd0', COALESCE(a.d0, 0) + CASE WHEN pa.age <= 30 THEN d.previous_left ELSE 0 END,
                 'd31', COALESCE(a.d31, 0) + CASE WHEN pa.age BETWEEN 31 AND 60 THEN d.previous_left ELSE 0 END,
                 'd61', COALESCE(a.d61, 0) + CASE WHEN pa.age > 60 THEN d.previous_left ELSE 0 END,
                 'oldest_days', GREATEST(COALESCE(a.oldest, 0), CASE WHEN d.previous_left > 0 THEN pa.age ELSE 0 END))
               ORDER BY d.order_due + d.previous_left DESC)
        FROM dues d CROSS JOIN prev_age pa
        LEFT JOIN aged a ON a.customer_key = d.customer_key
        LEFT JOIN names n ON n.customer_key = d.customer_key), '[]'::jsonb),
      'top', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('customer_key', s.customer_key, 'name', COALESCE(n.customer_name, ''),
                 'phone', COALESCE(n.customer_phone, ''), 'bought', s.bought, 'profit', COALESCE(s.profit, 0), 'orders', s.orders)
               ORDER BY s.bought DESC)
        FROM sold s LEFT JOIN names n ON n.customer_key = s.customer_key
        WHERE s.orders > 0), '[]'::jsonb))
  );
END;
$function$;

-- ------------------------------------------------------------------
-- 5. Opening balances and the balance check
-- ------------------------------------------------------------------
-- An order placed before the start date, not taken from lots and not
-- delivered yet then ("open"): the opening holds the cost of its goods
-- (they had left the shelf), not its full price. Its sale counts in
-- profit when it is delivered, so it is not counted twice.
CREATE OR REPLACE FUNCTION money_opening_net_worth()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_start   date := money_start_date();
  v_ts      timestamptz := money_start_ts();
  v_acc     numeric;
  v_prev    numeric;
  v_stock   numeric;
  v_orders  numeric;
  v_pay     numeric;
BEGIN
  IF v_start IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(sum(amount), 0) INTO v_acc FROM money_movements WHERE type = 'opening_balance';
  SELECT COALESCE(sum(amount), 0) INTO v_prev FROM customer_opening_dues;
  SELECT COALESCE(round(sum(li.qty * li.landed_unit_cost_bdt), 2), 0) INTO v_stock
  FROM lot_items li JOIN lots l ON l.id = li.lot_id
  WHERE l.kind = 'opening' OR l.lot_date < v_start;
  -- Site orders placed before the start date: what they were worth then.
  SELECT COALESCE(sum(
           CASE k.kind WHEN 'sold' THEN o.total
                       WHEN 'open' THEN money_order_goods_cost(o.id)
                       ELSE 0 END
           - COALESCE((SELECT sum(CASE WHEN p.kind = 'refund' THEN -p.amount ELSE p.amount END)
                       FROM order_payments p WHERE p.order_id = o.id AND p.paid_at < v_ts), 0)), 0)
  INTO v_orders
  FROM orders o
  CROSS JOIN LATERAL (SELECT money_order_opening_kind(o.id) AS kind) k
  WHERE o.created_at < v_ts;
  SELECT COALESCE(sum(amount), 0) INTO v_pay FROM money_opening_payables;
  RETURN jsonb_build_object('accounts', v_acc, 'previous_balances', v_prev, 'stock', v_stock,
                            'site_orders', v_orders, 'payables', v_pay,
                            'total', v_acc + v_prev + v_stock + v_orders - v_pay);
END;
$function$;

-- Courier owed: expected fees of delivered parcels Steadfast has not
-- billed yet (counted in profit since the start date).
CREATE OR REPLACE FUNCTION money_courier_not_billed()
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(sum(c.amount), 0)
  FROM order_courier_costs_for(ARRAY(
    SELECT o.id FROM orders o
    WHERE o.status = 'delivered' AND o.steadfast_consignment_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM order_courier_costs cc WHERE cc.order_id = o.id)
      AND (money_start_ts() IS NULL OR inventory_order_counted_at(o.id, o.status) >= money_start_ts()))) c
  WHERE c.kind = 'expected';
$function$;
REVOKE ALL ON FUNCTION money_courier_not_billed() FROM PUBLIC, anon, authenticated;

-- Steadfast bills paid outside a payout, per order counted since the
-- start date, and what was recorded as paid for each.
CREATE OR REPLACE FUNCTION money_courier_bill_rows()
 RETURNS TABLE(order_id uuid, order_number text, bill numeric, recorded numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT o.id, o.order_number, cc.bill_paid_separately,
         COALESCE((SELECT -sum(m.amount) FROM money_movements m
                   WHERE m.type = 'courier_bill_payment' AND m.order_id = o.id
                     AND (money_start_date() IS NULL OR m.entry_date >= money_start_date())), 0)
  FROM order_courier_costs cc
  JOIN orders o ON o.id = cc.order_id
  CROSS JOIN LATERAL (SELECT COALESCE(inventory_order_counted_at(o.id, o.status),
                                     CASE WHEN o.status = 'cancelled' THEN cc.paid_at END) AS at) x
  WHERE cc.bill_paid_separately <> 0
    AND o.status IN ('delivered', 'returned', 'cancelled')
    AND (money_start_ts() IS NULL OR x.at >= money_start_ts());
$function$;
REVOKE ALL ON FUNCTION money_courier_bill_rows() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION money_courier_bills_owed()
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE((SELECT sum(bill - recorded) FROM money_courier_bill_rows()), 0)
       -- Returned parcels whose order was deleted (counted as courier cost).
       + COALESCE((SELECT sum(i.bill_paid_separately)
                   FROM steadfast_payout_items i JOIN steadfast_payouts sp ON sp.id = i.payout_id
                   WHERE i.line_kind = 'returned' AND i.order_id IS NULL AND i.bill_paid_separately <> 0
                     AND (money_start_ts() IS NULL OR sp.paid_at >= money_start_ts())), 0);
$function$;
REVOKE ALL ON FUNCTION money_courier_bills_owed() FROM PUBLIC, anon, authenticated;

-- To give: investors, other people, suppliers, and (Batch 58) courier.
-- Investor share this month / this year follow the start date (I8).
CREATE OR REPLACE FUNCTION money_to_give_rows()
 RETURNS TABLE(kind text, id uuid, name text, owed numeric, capital_in numeric, capital_back numeric, share_month numeric, share_year numeric, share_all numeric, lots jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_today date := inventory_dhaka_today();
  v_month date := date_trunc('month', inventory_dhaka_today())::date;
  v_year  date := date_trunc('year', inventory_dhaka_today())::date;
  v_start date := money_start_date();
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  RETURN QUERY
  -- Investors: capital in (opening + money in) − capital returned.
  SELECT 'investor'::text, p.id, p.name,
         (ci.v - cb.v)::numeric, ci.v, cb.v, sm.v, sy.v, sa.v, '[]'::jsonb
  FROM parties_payable p
  CROSS JOIN LATERAL (SELECT
      COALESCE((SELECT sum(amount) FROM money_opening_payables o WHERE o.party_id = p.id), 0)
    + COALESCE((SELECT sum(amount) FROM money_movements m WHERE m.party_id = p.id AND m.type = 'investor_in'
                AND (v_start IS NULL OR m.entry_date >= v_start)), 0) AS v) ci
  CROSS JOIN LATERAL (SELECT COALESCE(-(SELECT sum(amount) FROM money_movements m WHERE m.party_id = p.id
                AND m.type = 'investor_capital_back' AND (v_start IS NULL OR m.entry_date >= v_start)), 0) AS v) cb
  CROSS JOIN LATERAL (SELECT COALESCE(-(SELECT sum(amount) FROM money_movements m WHERE m.party_id = p.id
                AND m.type = 'investor_profit_share' AND m.entry_date BETWEEN v_month AND v_today
                AND (v_start IS NULL OR m.entry_date >= v_start)), 0) AS v) sm
  CROSS JOIN LATERAL (SELECT COALESCE(-(SELECT sum(amount) FROM money_movements m WHERE m.party_id = p.id
                AND m.type = 'investor_profit_share' AND m.entry_date BETWEEN v_year AND v_today
                AND (v_start IS NULL OR m.entry_date >= v_start)), 0) AS v) sy
  CROSS JOIN LATERAL (SELECT COALESCE(-(SELECT sum(amount) FROM money_movements m WHERE m.party_id = p.id
                AND m.type = 'investor_profit_share' AND (v_start IS NULL OR m.entry_date >= v_start)), 0) AS v) sa
  WHERE p.kind = 'investor'
  UNION ALL
  -- Other people: opening payables − what was paid to them.
  SELECT 'other', p.id, p.name,
         COALESCE((SELECT sum(amount) FROM money_opening_payables o WHERE o.party_id = p.id), 0)
         + COALESCE((SELECT sum(amount) FROM money_movements m WHERE m.party_id = p.id AND m.type = 'supplier_payment'
                     AND (v_start IS NULL OR m.entry_date >= v_start)), 0),
         NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, '[]'::jsonb
  FROM parties_payable p
  WHERE p.kind = 'other'
  UNION ALL
  -- Suppliers: each lot's unpaid rest + opening payables − supplier payments.
  SELECT 'supplier', s.id, s.name,
         COALESCE((SELECT sum(money_lot_owed(l.id)) FROM lots l WHERE l.supplier_id = s.id), 0)
         + COALESCE((SELECT sum(amount) FROM money_opening_payables o WHERE o.supplier_id = s.id), 0)
         + COALESCE((SELECT sum(amount) FROM money_movements m WHERE m.supplier_id = s.id AND m.type = 'supplier_payment'
                     AND (v_start IS NULL OR m.entry_date >= v_start)), 0),
         NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('lot_id', l.id, 'code', l.code, 'owed', money_lot_owed(l.id))
                                    ORDER BY l.lot_date, l.code)
                   FROM lots l WHERE l.supplier_id = s.id AND money_lot_owed(l.id) <> 0), '[]'::jsonb)
  FROM suppliers s
  UNION ALL
  -- Lots with no supplier picked.
  SELECT 'supplier', NULL::uuid, 'No supplier picked',
         COALESCE((SELECT sum(money_lot_owed(l.id)) FROM lots l WHERE l.supplier_id IS NULL), 0),
         NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('lot_id', l.id, 'code', l.code, 'owed', money_lot_owed(l.id))
                                    ORDER BY l.lot_date, l.code)
                   FROM lots l WHERE l.supplier_id IS NULL AND money_lot_owed(l.id) <> 0), '[]'::jsonb)
  WHERE EXISTS (SELECT 1 FROM lots l WHERE l.supplier_id IS NULL AND money_lot_owed(l.id) <> 0)
  UNION ALL
  -- Batch 58: courier fees counted in profit that no account has paid yet.
  SELECT 'courier', NULL::uuid, 'Courier (not billed yet)', x.amt,
         NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, '[]'::jsonb
  FROM (SELECT money_courier_not_billed() AS amt) x
  WHERE x.amt <> 0
  UNION ALL
  SELECT 'courier', NULL::uuid, 'Steadfast bills paid outside a payout', y.amt,
         NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, '[]'::jsonb
  FROM (SELECT money_courier_bills_owed() AS amt) y
  WHERE y.amt <> 0;
END;
$function$;

-- The money position and the balance check.
CREATE OR REPLACE FUNCTION money_position()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_start     date := money_start_date();
  v_ts        timestamptz := money_start_ts();
  v_today     date := inventory_dhaka_today();
  v_accounts  jsonb;
  v_acc_sum   numeric;
  v_sf        numeric;
  v_recv      numeric;
  v_adv       numeric;
  v_prev      numeric;
  v_stock     numeric;
  v_goods     numeric;
  v_goods_old numeric;
  v_open_val  numeric;
  v_short     numeric;
  v_give      numeric;
  v_give_inv  numeric;
  v_give_sup  numeric;
  v_give_oth  numeric;
  v_give_cour numeric;
  v_have      numeric;
  v_owe       numeric;
  v_open      jsonb;
  v_parts     jsonb;
  v_outside   numeric := 0;
  v_out_orders numeric := 0;
  v_out_unm   numeric := 0;
  v_rhs       numeric;
  v_diff      numeric;
  v_first     date;
  v_last_ok   date;
  v_sf_reported numeric;
  v_sf_at     timestamptz;
  v_unplaced  jsonb;
  v_corr      numeric := 0;
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('account_id', b.account_id, 'name', b.name, 'kind', b.kind,
                    'archived', b.archived, 'balance', b.balance)), '[]'::jsonb),
         COALESCE(sum(b.balance) FILTER (WHERE b.kind <> 'steadfast'), 0),
         COALESCE(sum(b.balance) FILTER (WHERE b.kind = 'steadfast'), 0)
  INTO v_accounts, v_acc_sum, v_sf
  FROM money_account_balances() b;

  -- Customers (per order: owed − paid; Cancelled / Returned owe nothing),
  -- open orders, and orders whose sale is inside the opening balances.
  WITH per AS (
    SELECT o.id, o.status, o.total, money_order_opening_kind(o.id) AS kind,
           (CASE WHEN o.status IN ('cancelled', 'returned') THEN 0 ELSE o.total END) AS basis,
           COALESCE((SELECT sum(CASE WHEN p.kind = 'refund' THEN -p.amount ELSE p.amount END)
                     FROM order_payments p WHERE p.order_id = o.id), 0) AS paid
    FROM orders o
  ), per2 AS (
    SELECT per.*, CASE WHEN per.kind = 'open' THEN money_order_goods_cost(per.id) ELSE 0 END AS goods
    FROM per
  )
  SELECT COALESCE(sum(GREATEST(basis - paid, 0)), 0),
         COALESCE(sum(GREATEST(paid - basis, 0)), 0),
         COALESCE(sum(total) FILTER (WHERE status IN ('pending', 'confirmed', 'shipped') AND kind NOT IN ('sold', 'closed')), 0),
         COALESCE(sum(goods) FILTER (WHERE status IN ('pending', 'confirmed', 'shipped')), 0),
         -- A sale inside the opening that changed later (e.g. returned).
         COALESCE(sum(basis - total) FILTER (WHERE kind = 'sold'), 0)
         -- Goods of an "open" order that never came back to a lot.
         - COALESCE(sum(goods) FILTER (WHERE status IN ('cancelled', 'returned')), 0)
  INTO v_recv, v_adv, v_open_val, v_goods_old, v_out_orders
  FROM per2;

  SELECT COALESCE(sum(amount), 0) INTO v_prev FROM customer_opening_dues;
  v_prev := v_prev - COALESCE((SELECT sum(amount) FROM customer_due_payments), 0);
  -- Batch 50: previous balances corrected later (no money moved).
  v_corr := COALESCE((SELECT sum(amount_change) FROM customer_previous_corrections), 0);
  v_prev := v_prev + v_corr;

  SELECT COALESCE(round(sum(qty_remaining * landed_unit_cost_bdt), 2), 0) INTO v_stock FROM lot_items;

  -- Goods on orders not delivered yet, at the lot row's landed cost (the
  -- same value the stock had before they were taken).
  SELECT COALESCE(round(sum((x.units - x.units_back) * li.landed_unit_cost_bdt), 2), 0) INTO v_goods
  FROM order_item_lots x
  JOIN lot_items li ON li.id = x.lot_item_id
  JOIN orders o ON o.id = x.order_id
  WHERE o.status IN ('pending', 'confirmed', 'shipped');
  v_goods := v_goods + v_goods_old;

  -- Sold without stock: the same cost profit uses for those units.
  SELECT COALESCE(sum(round(s.units * COALESCE(c.unit_cost_bdt, 0) / GREATEST(inventory_item_factor(oi), 1), 2)), 0)
  INTO v_short
  FROM (SELECT order_item_id, sum(units) AS units FROM stock_shortfalls WHERE status = 'open' GROUP BY order_item_id) s
  JOIN order_items oi ON oi.id = s.order_item_id
  JOIN orders o ON o.id = oi.order_id
  LEFT JOIN order_item_costs c ON c.order_item_id = oi.id
  WHERE o.status = 'delivered';

  SELECT COALESCE(sum(owed) FILTER (WHERE kind = 'investor'), 0),
         COALESCE(sum(owed) FILTER (WHERE kind = 'supplier'), 0),
         COALESCE(sum(owed) FILTER (WHERE kind = 'other'), 0),
         COALESCE(sum(owed) FILTER (WHERE kind = 'courier'), 0)
  INTO v_give_inv, v_give_sup, v_give_oth, v_give_cour
  FROM money_to_give_rows();
  v_give := v_give_inv + v_give_sup + v_give_oth + v_give_cour;

  v_have := v_acc_sum + v_sf + v_recv + v_prev + v_stock + v_goods;
  v_owe := v_give + v_adv + v_open_val + v_short;

  SELECT current_balance, balance_at INTO v_sf_reported, v_sf_at FROM steadfast_sync_state WHERE id = 1;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('payout_id', p.id, 'paid_at', p.paid_at, 'amount', p.total_amount,
                    'parcels', p.parcel_count) ORDER BY p.paid_at), '[]'::jsonb)
  INTO v_unplaced
  FROM steadfast_payouts p
  WHERE p.total_amount > 0
    AND NOT EXISTS (SELECT 1 FROM money_movements m WHERE m.payout_id = p.id)
    AND (v_start IS NULL OR p.paid_at >= v_ts);

  IF v_start IS NOT NULL THEN
    v_open := money_opening_net_worth();
    v_parts := money_profit_parts(v_start, v_today);
    -- Outside profit: sales inside the opening that changed later, and
    -- Steadfast parcels that match no order.
    SELECT COALESCE(sum(l.amount), 0) INTO v_out_unm
    FROM money_ledger l WHERE l.type IN ('steadfast_unmatched', 'steadfast_courier_only');
    v_outside := v_out_orders + v_out_unm;

    v_rhs := (v_open ->> 'total')::numeric + (v_parts ->> 'net_profit')::numeric
             - (v_parts ->> 'profit_share')::numeric - (v_parts ->> 'withdrawals')::numeric
             + (v_parts ->> 'owner_money_in')::numeric + (v_parts ->> 'not_shop_money')::numeric
             + (v_parts ->> 'count_differences')::numeric + v_outside + v_corr;
    v_diff := round((v_have - v_owe) - v_rhs, 2);

    INSERT INTO money_check_log (check_date, difference, checked_at) VALUES (v_today, v_diff, now())
    ON CONFLICT (check_date) DO UPDATE SET difference = EXCLUDED.difference, checked_at = now();
    -- Batch 58: to the paisa (was ±৳1).
    IF abs(v_diff) >= 0.01 THEN
      SELECT max(check_date) INTO v_last_ok FROM money_check_log WHERE abs(difference) < 0.01 AND check_date < v_today;
      SELECT min(check_date) INTO v_first FROM money_check_log
      WHERE abs(difference) >= 0.01 AND (v_last_ok IS NULL OR check_date > v_last_ok);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'start_date', v_start,
    'accounts', v_accounts,
    'accounts_total', v_acc_sum,
    'with_steadfast', v_sf,
    'steadfast_reported', v_sf_reported,
    'steadfast_reported_at', v_sf_at,
    'unplaced_payouts', v_unplaced,
    'to_receive', v_recv,
    'previous_balances', v_prev,
    'previous_corrections', v_corr,
    'customer_advances', v_adv,
    'stock_value', v_stock,
    'goods_on_open_orders', v_goods,
    'open_orders_value', v_open_val,
    'sold_without_stock', v_short,
    'to_give', v_give,
    'to_give_investors', v_give_inv,
    'to_give_suppliers', v_give_sup,
    'to_give_others', v_give_oth,
    'to_give_courier', v_give_cour,
    'have', v_have,
    'owe', v_owe,
    'net_worth', v_have - v_owe,
    'opening', v_open,
    'since_start', v_parts,
    'outside_orders', v_out_orders,
    'outside_fees', 0,
    'outside_unmatched', v_out_unm,
    'outside', v_outside,
    'expected', v_rhs,
    'difference', v_diff,
    'balanced', CASE WHEN v_start IS NULL THEN NULL ELSE abs(v_diff) < 0.01 END,
    'first_wrong', v_first);
END;
$function$;

-- ------------------------------------------------------------------
-- 6. Steadfast bill paid outside a payout: record the payment
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION money_courier_bill_status(p_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_bill     numeric;
  v_counts   boolean;
  v_recorded numeric;
  v_paid     jsonb;
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  SELECT COALESCE((SELECT bill_paid_separately FROM order_courier_costs WHERE order_id = p_order_id), 0) INTO v_bill;
  v_counts := EXISTS (SELECT 1 FROM money_courier_bill_rows() r WHERE r.order_id = p_order_id);
  SELECT COALESCE(-sum(m.amount), 0),
         COALESCE(jsonb_agg(jsonb_build_object('id', m.id, 'account', a.name, 'date', m.entry_date, 'amount', -m.amount)
                            ORDER BY m.entry_date, m.created_at), '[]'::jsonb)
  INTO v_recorded, v_paid
  FROM money_movements m JOIN money_accounts a ON a.id = m.account_id
  WHERE m.type = 'courier_bill_payment' AND m.order_id = p_order_id
    AND (money_start_date() IS NULL OR m.entry_date >= money_start_date());
  RETURN jsonb_build_object(
    'bill', v_bill,
    'counts', v_counts,
    'recorded', v_recorded,
    'owed', CASE WHEN v_counts THEN GREATEST(v_bill - v_recorded, 0) ELSE 0 END,
    'payments', v_paid);
END;
$function$;
REVOKE ALL ON FUNCTION money_courier_bill_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION money_courier_bill_status(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION money_record_courier_bill(p_order_id uuid, p_account uuid, p_date date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status jsonb;
  v_owed   numeric;
  v_acc    money_accounts%ROWTYPE;
  v_number text;
  v_row    money_movements%ROWTYPE;
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  SELECT order_number INTO v_number FROM orders WHERE id = p_order_id;
  IF v_number IS NULL THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;
  v_status := money_courier_bill_status(p_order_id);
  v_owed := (v_status ->> 'owed')::numeric;
  IF v_owed <= 0 THEN
    RAISE EXCEPTION 'Nothing is owed for this bill.';
  END IF;
  v_acc := money_check_account(p_account);
  PERFORM money_check_entry_date(p_date);
  INSERT INTO money_movements (entry_date, account_id, amount, type, order_id, note, reference, created_by, created_by_username)
  VALUES (p_date, v_acc.id, -v_owed, 'courier_bill_payment', p_order_id,
          'Steadfast bill for ' || v_number || ' paid outside the payout', v_number, auth.uid(), current_actor_username())
  RETURNING * INTO v_row;
  PERFORM write_activity('money.courier_bill', 'money', v_row.id::text, money_type_label(v_row.type),
    format('Steadfast bill for %s (%s) paid from %s', v_number, money_short(v_owed), v_acc.name),
    jsonb_build_object('order_id', p_order_id, 'amount', v_owed, 'account_id', v_acc.id, 'date', p_date));
  RETURN v_row.id;
END;
$function$;
REVOKE ALL ON FUNCTION money_record_courier_bill(uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION money_record_courier_bill(uuid, uuid, date) TO authenticated;

-- A recorded bill keeps its amount (the bill); account / date / note can
-- be changed. Otherwise as before.
CREATE OR REPLACE FUNCTION money_update_entry(p_id uuid, p_amount numeric, p_account uuid, p_date date, p_note text DEFAULT NULL::text, p_category uuid DEFAULT NULL::uuid, p_party uuid DEFAULT NULL::uuid, p_supplier uuid DEFAULT NULL::uuid, p_to_account uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old     money_movements%ROWTYPE;
  v_new     money_movements%ROWTYPE;
  v_other   money_movements%ROWTYPE;
  v_amount  numeric := round(p_amount, 2);
  v_note    text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_kind    text;
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  SELECT * INTO v_old FROM money_movements WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Entry not found.';
  END IF;
  IF v_old.type IN ('opening_balance') THEN
    RAISE EXCEPTION 'Opening balances change only by undoing the opening (Careful actions).';
  END IF;
  IF v_old.type IN ('steadfast_payout_in') THEN
    RAISE EXCEPTION 'Change the account of a payout on the Money page (Steadfast payouts).';
  END IF;
  IF v_old.type = 'lot_payment' THEN
    RAISE EXCEPTION 'Change a lot payment on the lot.';
  END IF;
  IF v_old.type = 'courier_bill_payment' AND v_amount IS DISTINCT FROM abs(v_old.amount) THEN
    RAISE EXCEPTION 'The amount is the Steadfast bill. To change it, delete this payment and record it again on the order.';
  END IF;
  IF money_start_date() IS NOT NULL AND v_old.entry_date < money_start_date() THEN
    RAISE EXCEPTION 'This entry is before your start date and is not part of the books.';
  END IF;
  IF v_amount IS NULL OR v_amount = 0 OR (v_old.type <> 'adjustment' AND v_amount < 0) THEN
    RAISE EXCEPTION 'Type an amount above 0.';
  END IF;
  IF abs(v_amount) > 1000000000 THEN
    RAISE EXCEPTION 'That amount is too large.';
  END IF;
  PERFORM money_check_entry_date(p_date);
  PERFORM money_check_account(p_account);

  IF v_old.type = 'expense' AND (p_category IS NULL OR NOT EXISTS (SELECT 1 FROM money_categories WHERE id = p_category)) THEN
    RAISE EXCEPTION 'Pick a category.';
  END IF;
  IF v_old.type IN ('investor_in', 'investor_profit_share', 'investor_capital_back') THEN
    SELECT kind INTO v_kind FROM parties_payable WHERE id = p_party;
    IF v_kind IS DISTINCT FROM 'investor' THEN
      RAISE EXCEPTION 'Pick the investor.';
    END IF;
  END IF;
  IF v_old.type = 'supplier_payment' AND (p_supplier IS NULL) = (p_party IS NULL) THEN
    RAISE EXCEPTION 'Pick who you paid.';
  END IF;

  IF v_old.type IN ('transfer_out', 'transfer_in') THEN
    SELECT * INTO v_other FROM money_movements
    WHERE transfer_id = v_old.transfer_id AND id <> v_old.id FOR UPDATE;
    IF p_to_account IS NULL THEN
      p_to_account := v_other.account_id;
    END IF;
    PERFORM money_check_account(p_to_account);
    IF p_to_account = p_account THEN
      RAISE EXCEPTION 'Pick two different accounts.';
    END IF;
    UPDATE money_movements
    SET entry_date = p_date, note = v_note, updated_at = now(), updated_by_username = current_actor_username(),
        account_id = CASE WHEN id = v_old.id THEN p_account ELSE p_to_account END,
        amount = CASE WHEN type = 'transfer_out' THEN -v_amount ELSE v_amount END
    WHERE transfer_id = v_old.transfer_id;
    -- The row that was edited keeps its side: an edit of the "in" row
    -- with account A and "to" B means money came into A from B.
    SELECT * INTO v_new FROM money_movements WHERE id = v_old.id;
    PERFORM write_activity('money.edit', 'money', v_old.transfer_id::text, 'Move money',
      format('Changed a move between accounts: %s → %s', money_entry_text(v_old), money_entry_text(v_new)),
      jsonb_build_object('before', to_jsonb(v_old), 'after', to_jsonb(v_new)));
    RETURN true;
  END IF;

  UPDATE money_movements
  SET entry_date = p_date, account_id = p_account,
      amount = CASE WHEN type = 'adjustment' THEN v_amount ELSE money_type_sign(type) * v_amount END,
      note = v_note,
      category_id = CASE WHEN type = 'expense' THEN p_category END,
      party_id = CASE WHEN type IN ('investor_in', 'investor_profit_share', 'investor_capital_back', 'supplier_payment') THEN p_party END,
      supplier_id = CASE WHEN type = 'supplier_payment' THEN p_supplier END,
      updated_at = now(), updated_by_username = current_actor_username()
  WHERE id = p_id
  RETURNING * INTO v_new;

  PERFORM write_activity('money.edit', 'money', v_old.id::text, money_type_label(v_old.type),
    format('Changed %s → %s', money_entry_text(v_old), money_entry_text(v_new)),
    jsonb_build_object('before', to_jsonb(v_old), 'after', to_jsonb(v_new)));
  RETURN true;
END;
$function$;

-- ------------------------------------------------------------------
-- 7. Customer credit (paid more than owed)
-- ------------------------------------------------------------------
DROP FUNCTION IF EXISTS money_customer_dues();
CREATE FUNCTION money_customer_dues()
 RETURNS TABLE(customer_key text, phone_key text, order_due numeric, previous_left numeric, latest_unpaid_order_id uuid, latest_unpaid_order_number text, last_reminder_at timestamp with time zone, last_reminder_amount numeric, reminders bigint, credit numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  RETURN QUERY
  WITH k AS (
    SELECT k.customer_key, k.order_id, k.due, o.created_at, o.order_number, bd_phone_key(o.customer_phone) AS pk,
           -- Paid above what the order asks (a Cancelled / Returned order asks nothing).
           GREATEST(COALESCE((SELECT sum(CASE WHEN p.kind = 'refund' THEN -p.amount ELSE p.amount END)
                              FROM order_payments p WHERE p.order_id = o.id), 0)
                    - CASE WHEN o.status IN ('cancelled', 'returned') THEN 0 ELSE o.total END, 0) AS over
    FROM order_customer_keys() k JOIN orders o ON o.id = k.order_id
  ), by_order AS (
    SELECT k.customer_key,
           sum(k.due) AS due,
           sum(k.over) AS over,
           (array_agg(k.pk ORDER BY k.created_at DESC) FILTER (WHERE k.pk IS NOT NULL))[1] AS pk,
           (array_agg(k.order_id ORDER BY k.created_at DESC) FILTER (WHERE k.due > 0))[1] AS last_id,
           (array_agg(k.order_number ORDER BY k.created_at DESC) FILTER (WHERE k.due > 0))[1] AS last_no
    FROM k GROUP BY k.customer_key
  ), prev_rows AS (
    SELECT d.phone_key, money_customer_key_for_phone(d.phone_key) AS customer_key, money_previous_left(d.phone_key) AS left_amount
    FROM (SELECT phone_key FROM customer_opening_dues
          UNION SELECT phone_key FROM customer_previous_corrections) d
  ), prev AS (
    -- Batch 55: one row per customer (a customer can now have more than one number).
    SELECT x.customer_key, sum(x.left_amount) AS left_amount,
           (array_agg(x.phone_key ORDER BY EXISTS (SELECT 1 FROM customer_phones cp WHERE cp.phone_key = x.phone_key), x.phone_key))[1] AS phone_key
    FROM prev_rows x GROUP BY x.customer_key
  ), keys AS (
    SELECT b.customer_key FROM by_order b
    UNION
    SELECT p.customer_key FROM prev p
  )
  SELECT ks.customer_key,
         COALESCE(CASE WHEN EXISTS (SELECT 1 FROM customer_phones cp WHERE cp.customer_key = ks.customer_key)
                       THEN customer_main_phone_key(ks.customer_key) END,
                  b.pk, p.phone_key, CASE WHEN ks.customer_key LIKE 'ph:%' THEN substr(ks.customer_key, 4) END),
         COALESCE(b.due, 0)::numeric,
         COALESCE(p.left_amount, 0)::numeric,
         b.last_id, b.last_no,
         r.at, r.amount, COALESCE(r.n, 0),
         (COALESCE(b.over, 0) + GREATEST(-COALESCE(p.left_amount, 0), 0))::numeric
  FROM keys ks
  LEFT JOIN by_order b ON b.customer_key = ks.customer_key
  LEFT JOIN prev p ON p.customer_key = ks.customer_key
  LEFT JOIN LATERAL (
    SELECT max(x.created_at) AS at,
           (array_agg(x.amount ORDER BY x.created_at DESC))[1] AS amount,
           count(*) AS n
    FROM customer_due_reminders x WHERE x.customer_key = ks.customer_key
  ) r ON true
  WHERE COALESCE(b.due, 0) <> 0 OR COALESCE(p.left_amount, 0) <> 0 OR r.n > 0 OR COALESCE(b.over, 0) <> 0;
END;
$function$;
REVOKE ALL ON FUNCTION money_customer_dues() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION money_customer_dues() TO authenticated;

-- ------------------------------------------------------------------
-- 8. The order's Profit card
-- ------------------------------------------------------------------
-- A cancelled order Steadfast charged for shows the charge (as the Money
-- page counts it). An item with no cost: the card shows the rest and says
-- how many items have no cost.
CREATE OR REPLACE FUNCTION order_profit(p_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order    orders%ROWTYPE;
  v_courier  order_courier_costs%ROWTYPE;
  v_known    boolean;
  v_sale     numeric;
  v_cost     numeric;
  v_prov     numeric;
  v_costed   boolean;
  v_missing  integer;
  v_delivery numeric;
  v_kept     numeric;
  v_profit   numeric;
  v_filled   numeric;
  v_cc       record;
BEGIN
  IF NOT staff_can('view_profit_costs') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;
  SELECT * INTO v_courier FROM order_courier_costs WHERE order_id = p_order_id;
  v_known := FOUND;
  -- Batch 53: the courier cost and how sure it is (order_courier_costs_for).
  SELECT * INTO v_cc FROM order_courier_costs_for(ARRAY[p_order_id]);

  SELECT COALESCE(sum(c.cost), 0), COALESCE(sum(c.provisional), 0), COALESCE(bool_and(c.costed), false),
         (count(*) FILTER (WHERE NOT c.costed))::integer
  INTO v_cost, v_prov, v_costed, v_missing
  FROM inventory_item_costs(ARRAY[p_order_id]) c;

  SELECT COALESCE(sum(amount_bdt), 0) INTO v_filled
  FROM cost_adjustments WHERE order_id = p_order_id AND reason IN ('shortfall_filled', 'given_back');

  IF v_order.status IN ('cancelled', 'returned') THEN
    v_sale := 0; v_cost := 0; v_prov := 0; v_delivery := 0; v_missing := 0;
    v_kept := CASE WHEN v_known THEN v_courier.total_kept ELSE 0 END;
  ELSE
    v_sale := GREATEST(v_order.subtotal - v_order.discount, 0);
    v_delivery := v_order.delivery_fee;
    v_kept := COALESCE(v_cc.amount, 0);
  END IF;
  v_profit := v_sale - v_cost + v_delivery - v_kept;

  RETURN jsonb_build_object(
    'status', v_order.status,
    'costed', v_costed OR v_order.status IN ('cancelled', 'returned'),
    'items_missing_cost', v_missing,
    'sale', v_sale,
    'cost', v_cost,
    'provisional', v_prov,
    'delivery', v_delivery,
    'courier', v_kept,
    'courier_known', v_known OR v_cc.kind = 'none',
    'courier_kind', CASE WHEN v_order.status IN ('cancelled', 'returned') AND NOT v_known
                         THEN CASE WHEN v_cc.kind IN ('none', 'not_booked') THEN v_cc.kind ELSE 'unknown' END
                         ELSE v_cc.kind END,
    'courier_charge', COALESCE(v_cc.delivery_bill, 0),
    'cod_fee', COALESCE(v_cc.cod_fee, 0),
    'bill_paid_separately', CASE WHEN v_known THEN v_courier.bill_paid_separately ELSE 0 END,
    'profit', v_profit,
    'margin', CASE WHEN v_sale > 0 THEN round(v_profit / v_sale * 100, 1) END,
    'counted_at', COALESCE(inventory_order_counted_at(p_order_id, v_order.status),
                           CASE WHEN v_order.status = 'cancelled' AND v_known THEN v_courier.paid_at END),
    'filled_adjustments', v_filled
  );
END;
$function$;

-- ------------------------------------------------------------------
-- 9. Locked months never change
-- ------------------------------------------------------------------
-- When a month is locked, each order counted in it is remembered
-- (money_lock_order_values). If its cost or courier changes later (a
-- real Steadfast bill, a lot filling a shortfall, a buying price typed
-- in), the difference is posted on that day as an adjustment; the
-- locked month keeps its numbers.
CREATE OR REPLACE FUNCTION money_lock_snapshot(p_month date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_month date := date_trunc('month', p_month)::date;
  v_n     integer;
BEGIN
  INSERT INTO money_lock_order_values (order_id, month, counted_date, sale, cost, delivery, courier, synced_at)
  SELECT p.order_id, v_month, money_dhaka_date(p.counted_at), p.sale, p.cost, p.delivery, p.courier, now()
  FROM money_order_parts_for(ARRAY(SELECT o.id FROM orders o WHERE o.status IN ('delivered', 'returned', 'cancelled'))) p
  WHERE p.counts AND p.counted_at IS NOT NULL
    AND date_trunc('month', money_dhaka_date(p.counted_at))::date = v_month
  ON CONFLICT (order_id) DO UPDATE
  SET month = EXCLUDED.month, counted_date = EXCLUDED.counted_date, sale = EXCLUDED.sale, cost = EXCLUDED.cost,
      delivery = EXCLUDED.delivery, courier = EXCLUDED.courier, synced_at = now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$;
REVOKE ALL ON FUNCTION money_lock_snapshot(date) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION money_lock_sync_order(p_order_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_s       money_lock_order_values%ROWTYPE;
  v_l       record;
  v_sale    numeric := 0;
  v_cost    numeric := 0;
  v_del     numeric := 0;
  v_cour    numeric := 0;
  v_number  text;
  v_status  text;
  v_parts   text[] := ARRAY[]::text[];
  v_amount  numeric;
BEGIN
  SELECT * INTO v_s FROM money_lock_order_values WHERE order_id = p_order_id;
  IF NOT FOUND OR NOT money_month_locked(v_s.counted_date) THEN
    RETURN;
  END IF;
  SELECT * INTO v_l FROM money_order_parts_for(ARRAY[p_order_id]);
  IF FOUND AND v_l.counts THEN
    v_sale := v_l.sale; v_cost := v_l.cost; v_del := v_l.delivery; v_cour := v_l.courier;
  END IF;
  IF round(v_sale - v_s.sale, 2) = 0 AND round(v_cost - v_s.cost, 2) = 0
     AND round(v_del - v_s.delivery, 2) = 0 AND round(v_cour - v_s.courier, 2) = 0 THEN
    RETURN;
  END IF;
  SELECT order_number, status INTO v_number, v_status FROM orders WHERE id = p_order_id;
  IF round(v_cour - v_s.courier, 2) <> 0 THEN
    v_parts := v_parts || format('Courier bill for %s (%s in a locked month): %s%s', v_number, COALESCE(v_status, 'counted'),
      CASE WHEN v_cour > v_s.courier THEN '+' ELSE '−' END, money_short(v_cour - v_s.courier));
  END IF;
  IF round(v_cost - v_s.cost, 2) <> 0 THEN
    v_parts := v_parts || format('Cost of goods for %s (%s in a locked month): %s%s', v_number, COALESCE(v_status, 'counted'),
      CASE WHEN v_cost > v_s.cost THEN '+' ELSE '−' END, money_short(v_cost - v_s.cost));
  END IF;
  IF round(v_sale - v_s.sale, 2) <> 0 OR round(v_del - v_s.delivery, 2) <> 0 THEN
    v_parts := v_parts || format('Sale for %s (%s in a locked month): %s%s', v_number, COALESCE(v_status, 'counted'),
      CASE WHEN v_sale + v_del > v_s.sale + v_s.delivery THEN '+' ELSE '−' END,
      money_short(v_sale + v_del - v_s.sale - v_s.delivery));
  END IF;
  v_amount := (v_sale - v_s.sale) - (v_cost - v_s.cost) + (v_del - v_s.delivery) - (v_cour - v_s.courier);
  INSERT INTO money_lock_adjustments (posted_date, affects_date, order_id, order_number, d_sale, d_cost, d_delivery,
                                      d_courier, amount, note, created_by_username)
  VALUES (inventory_dhaka_today(), v_s.counted_date, p_order_id, v_number, v_sale - v_s.sale, v_cost - v_s.cost,
          v_del - v_s.delivery, v_cour - v_s.courier, v_amount, array_to_string(v_parts, '; '),
          current_actor_username());
  UPDATE money_lock_order_values
  SET sale = v_sale, cost = v_cost, delivery = v_del, courier = v_cour, synced_at = now()
  WHERE order_id = p_order_id;
END;
$function$;
REVOKE ALL ON FUNCTION money_lock_sync_order(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION money_lock_sync_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_item  uuid;
  v_order uuid;
BEGIN
  IF NOT money_any_month_locked() THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'order_item_costs' THEN
    IF TG_OP = 'DELETE' THEN v_item := OLD.order_item_id; ELSE v_item := NEW.order_item_id; END IF;
    SELECT order_id INTO v_order FROM order_items WHERE id = v_item;
  ELSE
    IF TG_OP = 'DELETE' THEN v_order := OLD.order_id; ELSE v_order := NEW.order_id; END IF;
  END IF;
  IF v_order IS NOT NULL THEN
    PERFORM money_lock_sync_order(v_order);
  END IF;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION money_lock_sync_trigger() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zz_money_lock_sync ON order_item_costs;
CREATE TRIGGER zz_money_lock_sync AFTER INSERT OR UPDATE OR DELETE ON order_item_costs
  FOR EACH ROW EXECUTE FUNCTION money_lock_sync_trigger();
DROP TRIGGER IF EXISTS zz_money_lock_sync ON order_courier_costs;
CREATE TRIGGER zz_money_lock_sync AFTER INSERT OR UPDATE OR DELETE ON order_courier_costs
  FOR EACH ROW EXECUTE FUNCTION money_lock_sync_trigger();
DROP TRIGGER IF EXISTS zz_money_lock_sync ON order_courier_expected;
CREATE TRIGGER zz_money_lock_sync AFTER INSERT OR UPDATE OR DELETE ON order_courier_expected
  FOR EACH ROW EXECUTE FUNCTION money_lock_sync_trigger();

-- Months already locked before this migration: remember their orders now.
DO $$
DECLARE
  v_m date;
BEGIN
  FOR v_m IN SELECT month FROM money_month_locks WHERE locked LOOP
    IF NOT EXISTS (SELECT 1 FROM money_lock_order_values WHERE month = v_m) THEN
      PERFORM money_lock_snapshot(v_m);
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION money_lock_month(p_month date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_month date := date_trunc('month', p_month)::date;
  v_check jsonb;
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF NOT money_password_recent() THEN
    RAISE EXCEPTION 'Please confirm your password again.';
  END IF;
  IF money_month_locked(v_month) THEN
    RAISE EXCEPTION '% is already locked.', to_char(v_month, 'FMMonth YYYY');
  END IF;
  v_check := money_lock_checklist(v_month);
  IF NOT (v_check ->> 'ready')::boolean THEN
    RAISE EXCEPTION 'Not ready to lock %: %.', to_char(v_month, 'FMMonth YYYY'),
      (SELECT string_agg(i ->> 'title', ', ') FROM jsonb_array_elements(v_check -> 'items') i WHERE NOT (i ->> 'ok')::boolean);
  END IF;
  INSERT INTO money_month_locks (month, locked, locked_at, locked_by_username, checklist)
  VALUES (v_month, true, now(), current_actor_username(), v_check)
  ON CONFLICT (month) DO UPDATE SET locked = true, locked_at = now(), locked_by_username = current_actor_username(),
    checklist = EXCLUDED.checklist;
  -- Batch 58: remember what each order counted in the month added.
  PERFORM money_lock_snapshot(v_month);
  PERFORM write_activity('money.lock_month', 'money', v_month::text, to_char(v_month, 'FMMonth YYYY'),
    'Locked ' || to_char(v_month, 'FMMonth YYYY') || ': nothing dated in it can be added, changed or deleted', v_check);
  RETURN money_lock_checklist(v_month);
END;
$function$;

CREATE OR REPLACE FUNCTION money_unlock_month(p_month date, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_month  date := date_trunc('month', p_month)::date;
  v_reason text := btrim(COALESCE(p_reason, ''));
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Only the Super Admin can unlock a month.';
  END IF;
  IF NOT money_password_recent() THEN
    RAISE EXCEPTION 'Please confirm your password again.';
  END IF;
  IF length(v_reason) < 5 THEN
    RAISE EXCEPTION 'Write why you unlock it (at least a few words).';
  END IF;
  IF NOT money_month_locked(v_month) THEN
    RAISE EXCEPTION '% is not locked.', to_char(v_month, 'FMMonth YYYY');
  END IF;
  UPDATE money_month_locks
  SET locked = false, unlocked_at = now(), unlocked_by_username = current_actor_username(), unlock_reason = v_reason
  WHERE month = v_month;
  -- Batch 58: open again — its orders follow their live numbers from now on
  -- (adjustments already posted stay where they were posted).
  DELETE FROM money_lock_order_values WHERE month = v_month;
  PERFORM write_activity('money.unlock_month', 'money', v_month::text, to_char(v_month, 'FMMonth YYYY'),
    'Unlocked ' || to_char(v_month, 'FMMonth YYYY') || ' — reason: ' || v_reason, jsonb_build_object('reason', v_reason));
  RETURN money_lock_checklist(v_month);
END;
$function$;

-- Wording (Part 4): "All figures match".
CREATE OR REPLACE FUNCTION money_lock_checklist(p_month date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_month    date := date_trunc('month', p_month)::date;
  v_end      date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  v_from_ts  timestamptz := (date_trunc('month', p_month)::timestamp AT TIME ZONE 'Asia/Dhaka');
  v_to_ts    timestamptz := ((date_trunc('month', p_month) + interval '1 month')::timestamp AT TIME ZONE 'Asia/Dhaka');
  v_pos      jsonb;
  v_open     jsonb;
  v_n_open   integer;
  v_unplaced integer;
  v_unpl_amt numeric;
  v_plan     integer;
  v_counted  integer;
  v_items    jsonb := '[]'::jsonb;
  v_ok       boolean;
  v_lock     money_month_locks%ROWTYPE;
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_month IS NULL THEN
    RAISE EXCEPTION 'Pick a month.';
  END IF;
  SELECT * INTO v_lock FROM money_month_locks WHERE month = v_month;

  -- 0. Only a month that is over.
  v_ok := v_end < inventory_dhaka_today();
  v_items := v_items || jsonb_build_object('key', 'over', 'ok', v_ok, 'title', 'The month is over',
    'detail', CASE WHEN v_ok THEN to_char(v_month, 'FMMonth YYYY') || ' has ended.'
                   ELSE 'You can lock ' || to_char(v_month, 'FMMonth YYYY') || ' from ' || to_char(v_end + 1, 'DD Mon YYYY') || '.' END);

  -- 1. All figures match (the balance check).
  v_pos := money_position();
  v_ok := (v_pos ->> 'balanced')::boolean IS TRUE;
  v_items := v_items || jsonb_build_object('key', 'balance', 'ok', v_ok, 'title', 'All figures match',
    'detail', CASE WHEN v_pos ->> 'balanced' IS NULL THEN 'The opening balances are not confirmed yet, so there is no balance check.'
                   WHEN v_ok THEN 'The balance check is green.'
                   ELSE 'Figures don''t match: ' || CASE WHEN (v_pos ->> 'difference')::numeric < 0 THEN '−' ELSE '+' END
                        || money_short((v_pos ->> 'difference')::numeric) || '. Fix that first (Money page → Show the sums).' END);

  -- 2. No order from that month still being processed.
  SELECT count(*), COALESCE(jsonb_agg(order_number ORDER BY created_at) FILTER (WHERE rn <= 10), '[]'::jsonb)
  INTO v_n_open, v_open
  FROM (SELECT o.order_number, o.created_at, row_number() OVER (ORDER BY o.created_at) AS rn
        FROM orders o
        WHERE o.created_at >= v_from_ts AND o.created_at < v_to_ts
          AND o.status IN ('pending', 'confirmed', 'shipped')) x;
  v_items := v_items || jsonb_build_object('key', 'orders', 'ok', v_n_open = 0, 'title', 'No orders still processing',
    'detail', CASE WHEN v_n_open = 0 THEN 'Every order placed that month is delivered, returned or cancelled.'
                   ELSE v_n_open || ' order' || CASE WHEN v_n_open = 1 THEN ' is' ELSE 's are' END
                        || ' still To confirm, Confirmed or In transit.' END,
    'orders', v_open);

  -- 3. Steadfast payouts of that month placed in an account.
  SELECT count(*), COALESCE(sum(p.total_amount), 0) INTO v_unplaced, v_unpl_amt
  FROM steadfast_payouts p
  WHERE p.total_amount > 0 AND p.paid_at >= v_from_ts AND p.paid_at < v_to_ts
    AND NOT EXISTS (SELECT 1 FROM money_movements m WHERE m.payout_id = p.id)
    AND (money_start_date() IS NULL OR p.paid_at >= money_start_ts());
  v_items := v_items || jsonb_build_object('key', 'payouts', 'ok', v_unplaced = 0, 'title', 'Steadfast payouts recorded',
    'detail', CASE WHEN v_unplaced = 0 THEN 'Every payout of that month is placed in an account.'
                   ELSE v_unplaced || ' payout' || CASE WHEN v_unplaced = 1 THEN '' ELSE 's' END || ' (' || money_short(v_unpl_amt)
                        || ') not placed yet: Money page → Place.' END);

  -- 4. The month's stock count done.
  SELECT count(*), count(*) FILTER (WHERE EXISTS (SELECT 1 FROM stock_counts c WHERE c.plan_id = p.id))
  INTO v_plan, v_counted
  FROM stock_count_plans p WHERE p.month = v_month;
  -- A month without a count list (the count screen was never opened in
  -- it, e.g. before Inventory mode) does not block its lock for ever.
  v_ok := v_plan = 0 OR v_counted = v_plan;
  v_items := v_items || jsonb_build_object('key', 'count', 'ok', v_ok, 'title', 'Stock count done',
    'detail', CASE WHEN v_plan = 0 THEN 'No count list was made that month.'
                   WHEN v_ok THEN 'All ' || v_plan || ' products counted.'
                   ELSE v_counted || ' of ' || v_plan || ' products counted (Money → Monthly stock count).' END);

  RETURN jsonb_build_object(
    'month', v_month,
    'label', to_char(v_month, 'FMMonth YYYY'),
    'items', v_items,
    'ready', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_items) i WHERE NOT (i ->> 'ok')::boolean),
    'locked', COALESCE(v_lock.locked, false),
    'locked_at', v_lock.locked_at,
    'locked_by', v_lock.locked_by_username,
    'unlocked_at', v_lock.unlocked_at,
    'unlocked_by', v_lock.unlocked_by_username,
    'unlock_reason', v_lock.unlock_reason);
END;
$function$;

-- ------------------------------------------------------------------
-- 10. Deleting a delivered / returned order
-- ------------------------------------------------------------------
-- Only the Super Admin with the Safety Lock "Allow deleting orders at
-- any stage" on (unchanged); staff never. Batch 58: each such delete
-- writes an Activity Log line with the order number, total and payments.
CREATE OR REPLACE FUNCTION admin_delete_orders(p_order_ids uuid[])
 RETURNS TABLE(order_id uuid, order_number text, deleted boolean, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id        uuid;
  v_order     orders%ROWTYPE;
  v_line      record;
  v_is_admin  boolean := is_admin();
  v_lock_open boolean := false;
  v_early     boolean;
  v_pays      jsonb;
  v_paid      numeric;
BEGIN
  IF NOT (v_is_admin OR staff_can('delete_early_orders')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  IF v_is_admin THEN
    v_lock_open := EXISTS (
      SELECT 1 FROM admin_safety_locks
      WHERE user_id = auth.uid() AND delete_any_until > now()
    );
  END IF;

  FOREACH v_id IN ARRAY COALESCE(p_order_ids, '{}'::uuid[])
  LOOP
    SELECT * INTO v_order FROM orders WHERE id = v_id FOR UPDATE;

    IF NOT FOUND THEN
      order_id := v_id; order_number := NULL; deleted := false; reason := 'Order not found.';
      RETURN NEXT;
      CONTINUE;
    END IF;

    v_early := v_order.steadfast_consignment_id IS NULL
               AND v_order.status IN ('pending', 'confirmed', 'cancelled');

    IF NOT v_early AND NOT (v_is_admin AND v_lock_open) THEN
      order_id := v_id; order_number := v_order.order_number; deleted := false;
      reason := CASE WHEN v_is_admin
        THEN 'Locked: turn on "Allow deleting orders at any stage" in Safety Locks.'
        ELSE 'Only orders not booked on Steadfast and not sent (Pending, Confirmed or Cancelled) can be deleted.' END;
      RETURN NEXT;
      CONTINUE;
    END IF;

    IF v_order.status IN ('delivered', 'returned') THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object('amount', p.amount, 'kind', p.kind, 'method', p.method, 'paid_at', p.paid_at)
                                ORDER BY p.paid_at), '[]'::jsonb),
             COALESCE(sum(CASE WHEN p.kind = 'refund' THEN -p.amount ELSE p.amount END), 0)
      INTO v_pays, v_paid
      FROM order_payments p WHERE p.order_id = v_id;
      PERFORM write_activity('order.delete_counted', 'order', v_id::text, v_order.order_number,
        format('Deleted %s order %s: total %s, payments %s', v_order.status, v_order.order_number,
               money_short(v_order.total), money_short(v_paid)),
        jsonb_build_object('status', v_order.status, 'total', v_order.total, 'paid', v_paid, 'payments', v_pays,
                           'counted_at', inventory_order_counted_at(v_id, v_order.status)));
    END IF;

    IF NOT v_order.stock_released AND v_order.status <> 'cancelled' THEN
      PERFORM set_config('app.order_stock_change', 'on', true);
      -- Batch 39: lines sold in loose units never changed the stock number.
      FOR v_line IN SELECT * FROM order_items oi WHERE oi.order_id = v_id AND oi.sold_unit IS NULL
      LOOP
        IF v_line.variant_id IS NOT NULL THEN
          UPDATE product_variants SET stock_quantity = stock_quantity + (v_line.quantity - order_item_unstocked_qty(v_line.id))
            WHERE id = v_line.variant_id AND stock_quantity IS NOT NULL;
        ELSIF v_line.product_id IS NOT NULL THEN
          UPDATE products SET stock_quantity = stock_quantity + (v_line.quantity - order_item_unstocked_qty(v_line.id))
            WHERE id = v_line.product_id AND stock_quantity IS NOT NULL;
        END IF;
      END LOOP;
      PERFORM set_config('app.order_stock_change', 'off', true);
    END IF;

    DELETE FROM order_status_history h WHERE h.order_id = v_id;
    DELETE FROM order_items oi WHERE oi.order_id = v_id;
    DELETE FROM orders o WHERE o.id = v_id;

    order_id := v_id; order_number := v_order.order_number; deleted := true; reason := NULL;
    RETURN NEXT;
  END LOOP;
END;
$function$;

COMMIT;
