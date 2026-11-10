-- =============================================================================
-- Batch 42 — Dashboard, reports, monthly stock count and month lock
-- =============================================================================
-- Additive only: 3 new tables, 1 new column (stock_write_offs.added_back),
-- new functions and new triggers. Nothing is dropped or renamed, and no
-- existing function is replaced.
--
-- Every profit number comes from money_profit_parts() (Batch 41), which
-- itself uses inventory_sales_profit() (Batch 39). Every money number comes
-- from money_ledger / money_position() / money_summary() (Batch 41). The
-- reports below only slice those (by month, by category, by lot ...); they
-- never work profit out a second, different way.
--
-- Safe to run again.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- PART 1 — month lock: the table and the checks
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS money_month_locks (
  -- The first day of the month (2026-09-01 = September 2026).
  month                 date PRIMARY KEY CHECK (month = date_trunc('month', month)::date),
  locked                boolean NOT NULL DEFAULT true,
  locked_at             timestamptz,
  locked_by_username    text,
  -- The checklist as it was when the month was locked.
  checklist             jsonb NOT NULL DEFAULT '{}'::jsonb,
  unlocked_at           timestamptz,
  unlocked_by_username  text,
  unlock_reason         text
);

ALTER TABLE money_month_locks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON money_month_locks FROM anon, authenticated;
GRANT SELECT ON money_month_locks TO authenticated;
GRANT ALL ON money_month_locks TO service_role;
DROP POLICY IF EXISTS money_month_locks_read ON money_month_locks;
CREATE POLICY money_month_locks_read ON money_month_locks
  FOR SELECT TO authenticated USING (money_can_view());

-- Is the month of this date locked?
CREATE OR REPLACE FUNCTION money_month_locked(p_date date)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_date IS NOT NULL
     AND EXISTS (SELECT 1 FROM money_month_locks WHERE month = date_trunc('month', p_date)::date AND locked);
$$;

REVOKE ALL ON FUNCTION money_month_locked(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION money_month_locked(date) TO authenticated;

-- Any month locked at all? (Every lock trigger returns at once when not.)
CREATE OR REPLACE FUNCTION money_any_month_locked()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM money_month_locks WHERE locked);
$$;

REVOKE ALL ON FUNCTION money_any_month_locked() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION money_dhaka_date(p_at timestamptz)
RETURNS date
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (p_at AT TIME ZONE 'Asia/Dhaka')::date;
$$;

-- Refuses with one plain message when the date is in a locked month.
CREATE OR REPLACE FUNCTION money_lock_refuse(p_date date, p_what text)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF money_month_locked(p_date) THEN
    RAISE EXCEPTION '% is locked: % dated in it can''t be added, changed or deleted. Add a correction dated today with the note "correction for %".',
      to_char(p_date, 'FMMonth YYYY'), p_what, to_char(p_date, 'FMMonth YYYY');
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION money_lock_refuse(date, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- PART 2 — month lock: one trigger per kind of record
-- ---------------------------------------------------------------------------
-- What counts as an order's dates: the day it was placed and the day it
-- became Delivered / Returned (the day its profit counts). Only changes to
-- what money depends on are refused (status, prices, discount, delivery,
-- total, the date); a note, tracking number or courier field can still be
-- changed.
CREATE OR REPLACE FUNCTION money_lock_orders()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_at timestamptz;
BEGIN
  IF NOT money_any_month_locked() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM money_lock_refuse(money_dhaka_date(NEW.created_at), 'an order');
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.subtotal IS NOT DISTINCT FROM OLD.subtotal
     AND NEW.discount IS NOT DISTINCT FROM OLD.discount
     AND NEW.delivery_fee IS NOT DISTINCT FROM OLD.delivery_fee
     AND NEW.total IS NOT DISTINCT FROM OLD.total
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at THEN
    RETURN NEW;
  END IF;
  PERFORM money_lock_refuse(money_dhaka_date(OLD.created_at), 'order ' || OLD.order_number || ' (placed in it)');
  v_at := inventory_order_counted_at(OLD.id, OLD.status);
  IF v_at IS NOT NULL THEN
    PERFORM money_lock_refuse(money_dhaka_date(v_at), 'order ' || OLD.order_number || ' (' || OLD.status || ' in it)');
  END IF;
  IF TG_OP = 'UPDATE' THEN
    PERFORM money_lock_refuse(money_dhaka_date(NEW.created_at), 'an order');
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION money_lock_order_items()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order orders%ROWTYPE;
  v_at    timestamptz;
BEGIN
  IF NOT money_any_month_locked() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.order_id IS NOT DISTINCT FROM OLD.order_id
     AND NEW.quantity IS NOT DISTINCT FROM OLD.quantity
     AND NEW.unit_price IS NOT DISTINCT FROM OLD.unit_price
     AND NEW.line_total IS NOT DISTINCT FROM OLD.line_total THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_order FROM orders WHERE id = COALESCE(OLD.order_id, NEW.order_id);
  IF FOUND THEN
    PERFORM money_lock_refuse(money_dhaka_date(v_order.created_at), 'order ' || v_order.order_number || ' (placed in it)');
    v_at := inventory_order_counted_at(v_order.id, v_order.status);
    IF v_at IS NOT NULL THEN
      PERFORM money_lock_refuse(money_dhaka_date(v_at), 'order ' || v_order.order_number || ' (' || v_order.status || ' in it)');
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION money_lock_order_payments()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT money_any_month_locked() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.order_id IS NOT DISTINCT FROM OLD.order_id
     AND NEW.kind IS NOT DISTINCT FROM OLD.kind
     AND NEW.amount IS NOT DISTINCT FROM OLD.amount
     AND NEW.method IS NOT DISTINCT FROM OLD.method
     AND NEW.paid_at IS NOT DISTINCT FROM OLD.paid_at THEN
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    PERFORM money_lock_refuse(money_dhaka_date(OLD.paid_at), 'a payment');
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM money_lock_refuse(money_dhaka_date(NEW.paid_at), 'a payment');
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION money_lock_movements()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT money_any_month_locked() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.entry_date IS NOT DISTINCT FROM OLD.entry_date
     AND NEW.account_id IS NOT DISTINCT FROM OLD.account_id
     AND NEW.amount IS NOT DISTINCT FROM OLD.amount
     AND NEW.type IS NOT DISTINCT FROM OLD.type
     AND NEW.category_id IS NOT DISTINCT FROM OLD.category_id
     AND NEW.party_id IS NOT DISTINCT FROM OLD.party_id
     AND NEW.supplier_id IS NOT DISTINCT FROM OLD.supplier_id
     AND NEW.lot_id IS NOT DISTINCT FROM OLD.lot_id
     AND NEW.order_id IS NOT DISTINCT FROM OLD.order_id
     AND NEW.payout_id IS NOT DISTINCT FROM OLD.payout_id
     AND NEW.transfer_id IS NOT DISTINCT FROM OLD.transfer_id THEN
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    PERFORM money_lock_refuse(OLD.entry_date, 'a money entry');
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM money_lock_refuse(NEW.entry_date, 'a money entry');
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION money_lock_due_payments()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT money_any_month_locked() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP <> 'INSERT' THEN
    PERFORM money_lock_refuse(OLD.paid_date, 'a payment of a previous balance');
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM money_lock_refuse(NEW.paid_date, 'a payment of a previous balance');
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION money_lock_write_offs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT money_any_month_locked() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP <> 'INSERT' THEN
    PERFORM money_lock_refuse(OLD.write_date, 'a write-off');
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM money_lock_refuse(NEW.write_date, 'a write-off');
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION money_lock_cost_adjustments()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT money_any_month_locked() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP <> 'INSERT' THEN
    PERFORM money_lock_refuse(OLD.adj_date, 'a cost adjustment');
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM money_lock_refuse(NEW.adj_date, 'a cost adjustment');
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Lots: the lot's date. What sales and returns do to a lot row (units
-- left) is never refused: only the lot itself (what was bought, prices,
-- bills, expiry).
CREATE OR REPLACE FUNCTION money_lock_lots()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT money_any_month_locked() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.lot_date IS NOT DISTINCT FROM OLD.lot_date
     AND NEW.kind IS NOT DISTINCT FROM OLD.kind
     AND NEW.source_type IS NOT DISTINCT FROM OLD.source_type
     AND NEW.supplier_id IS NOT DISTINCT FROM OLD.supplier_id
     AND NEW.currency IS NOT DISTINCT FROM OLD.currency
     AND NEW.exchange_rate IS NOT DISTINCT FROM OLD.exchange_rate
     AND NEW.costs_pending IS NOT DISTINCT FROM OLD.costs_pending
     AND NEW.opening_weight_added_bdt IS NOT DISTINCT FROM OLD.opening_weight_added_bdt THEN
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    PERFORM money_lock_refuse(OLD.lot_date, 'lot ' || OLD.code);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM money_lock_refuse(NEW.lot_date, 'a lot');
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION money_lock_lot_items()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lot lots%ROWTYPE;
BEGIN
  IF NOT money_any_month_locked() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.lot_id IS NOT DISTINCT FROM OLD.lot_id
     AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
     AND NEW.variant_id IS NOT DISTINCT FROM OLD.variant_id
     AND NEW.qty IS NOT DISTINCT FROM OLD.qty
     AND NEW.unit_price_foreign IS NOT DISTINCT FROM OLD.unit_price_foreign
     AND NEW.unit_price_bdt IS NOT DISTINCT FROM OLD.unit_price_bdt
     AND NEW.buy_value_bdt IS NOT DISTINCT FROM OLD.buy_value_bdt
     AND NEW.landed_unit_cost_bdt IS NOT DISTINCT FROM OLD.landed_unit_cost_bdt
     AND NEW.alloc_weight_paisa IS NOT DISTINCT FROM OLD.alloc_weight_paisa
     AND NEW.alloc_other_paisa IS NOT DISTINCT FROM OLD.alloc_other_paisa
     AND NEW.expiry_date IS NOT DISTINCT FROM OLD.expiry_date
     AND NEW.pack_size IS NOT DISTINCT FROM OLD.pack_size THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_lot FROM lots WHERE id = COALESCE(OLD.lot_id, NEW.lot_id);
  IF FOUND THEN
    PERFORM money_lock_refuse(v_lot.lot_date, 'lot ' || v_lot.code);
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.lot_id IS DISTINCT FROM OLD.lot_id THEN
    SELECT * INTO v_lot FROM lots WHERE id = NEW.lot_id;
    IF FOUND THEN
      PERFORM money_lock_refuse(v_lot.lot_date, 'lot ' || v_lot.code);
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION money_lock_lot_costs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lot lots%ROWTYPE;
BEGIN
  IF NOT money_any_month_locked() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  SELECT * INTO v_lot FROM lots WHERE id = COALESCE(OLD.lot_id, NEW.lot_id);
  IF FOUND THEN
    PERFORM money_lock_refuse(v_lot.lot_date, 'the bills of lot ' || v_lot.code);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Opening balances: dated the start date.
CREATE OR REPLACE FUNCTION money_lock_opening()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT money_any_month_locked() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  PERFORM money_lock_refuse(money_start_date(), 'the opening balances');
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION money_lock_books()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT money_any_month_locked() THEN
    RETURN NEW;
  END IF;
  IF NEW.start_date IS NOT DISTINCT FROM OLD.start_date
     AND NEW.confirmed_at IS NOT DISTINCT FROM OLD.confirmed_at
     AND NEW.opening_steadfast IS NOT DISTINCT FROM OLD.opening_steadfast THEN
    RETURN NEW;
  END IF;
  PERFORM money_lock_refuse(OLD.start_date, 'the opening balances');
  PERFORM money_lock_refuse(NEW.start_date, 'the opening balances');
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['money_lock_orders', 'money_lock_order_items', 'money_lock_order_payments', 'money_lock_movements',
                           'money_lock_due_payments', 'money_lock_write_offs', 'money_lock_cost_adjustments', 'money_lock_lots',
                           'money_lock_lot_items', 'money_lock_lot_costs', 'money_lock_opening', 'money_lock_books'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %I() FROM PUBLIC, anon, authenticated', f);
  END LOOP;
END;
$$;

-- BEFORE triggers, named "zz_" so they run after the shop's own BEFORE
-- triggers have filled in any defaults.
DROP TRIGGER IF EXISTS zz_money_lock ON orders;
CREATE TRIGGER zz_money_lock BEFORE INSERT OR UPDATE OR DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION money_lock_orders();
DROP TRIGGER IF EXISTS zz_money_lock ON order_items;
CREATE TRIGGER zz_money_lock BEFORE INSERT OR UPDATE OR DELETE ON order_items
  FOR EACH ROW EXECUTE FUNCTION money_lock_order_items();
DROP TRIGGER IF EXISTS zz_money_lock ON order_payments;
CREATE TRIGGER zz_money_lock BEFORE INSERT OR UPDATE OR DELETE ON order_payments
  FOR EACH ROW EXECUTE FUNCTION money_lock_order_payments();
DROP TRIGGER IF EXISTS zz_money_lock ON money_movements;
CREATE TRIGGER zz_money_lock BEFORE INSERT OR UPDATE OR DELETE ON money_movements
  FOR EACH ROW EXECUTE FUNCTION money_lock_movements();
DROP TRIGGER IF EXISTS zz_money_lock ON customer_due_payments;
CREATE TRIGGER zz_money_lock BEFORE INSERT OR UPDATE OR DELETE ON customer_due_payments
  FOR EACH ROW EXECUTE FUNCTION money_lock_due_payments();
DROP TRIGGER IF EXISTS zz_money_lock ON stock_write_offs;
CREATE TRIGGER zz_money_lock BEFORE INSERT OR UPDATE OR DELETE ON stock_write_offs
  FOR EACH ROW EXECUTE FUNCTION money_lock_write_offs();
DROP TRIGGER IF EXISTS zz_money_lock ON cost_adjustments;
CREATE TRIGGER zz_money_lock BEFORE INSERT OR UPDATE OR DELETE ON cost_adjustments
  FOR EACH ROW EXECUTE FUNCTION money_lock_cost_adjustments();
DROP TRIGGER IF EXISTS zz_money_lock ON lots;
CREATE TRIGGER zz_money_lock BEFORE INSERT OR UPDATE OR DELETE ON lots
  FOR EACH ROW EXECUTE FUNCTION money_lock_lots();
DROP TRIGGER IF EXISTS zz_money_lock ON lot_items;
CREATE TRIGGER zz_money_lock BEFORE INSERT OR UPDATE OR DELETE ON lot_items
  FOR EACH ROW EXECUTE FUNCTION money_lock_lot_items();
DROP TRIGGER IF EXISTS zz_money_lock ON lot_costs;
CREATE TRIGGER zz_money_lock BEFORE INSERT OR UPDATE OR DELETE ON lot_costs
  FOR EACH ROW EXECUTE FUNCTION money_lock_lot_costs();
DROP TRIGGER IF EXISTS zz_money_lock ON customer_opening_dues;
CREATE TRIGGER zz_money_lock BEFORE INSERT OR UPDATE OR DELETE ON customer_opening_dues
  FOR EACH ROW EXECUTE FUNCTION money_lock_opening();
DROP TRIGGER IF EXISTS zz_money_lock ON money_opening_payables;
CREATE TRIGGER zz_money_lock BEFORE INSERT OR UPDATE OR DELETE ON money_opening_payables
  FOR EACH ROW EXECUTE FUNCTION money_lock_opening();
DROP TRIGGER IF EXISTS zz_money_lock ON money_books;
CREATE TRIGGER zz_money_lock BEFORE UPDATE ON money_books
  FOR EACH ROW EXECUTE FUNCTION money_lock_books();

-- ---------------------------------------------------------------------------
-- PART 3 — monthly stock count: tables
-- ---------------------------------------------------------------------------
-- Counted MORE than the system says: the extra units go back into the
-- newest lot of that product, and the write-off row is a gain (cost_bdt
-- below 0, added_back = true), so "Stock removed (write-offs)" in profit is
-- losses minus finds.
ALTER TABLE stock_write_offs ADD COLUMN IF NOT EXISTS added_back boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS stock_count_plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  month       date NOT NULL CHECK (month = date_trunc('month', month)::date),
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id  uuid REFERENCES product_variants(id) ON DELETE CASCADE,
  label       text NOT NULL DEFAULT '',
  -- Why it was picked: 'never' (never counted), 'oldest' (longest since
  -- its last count), 'value' (expensive stock), 'fast' (sells fast).
  why         text NOT NULL CHECK (why IN ('never', 'oldest', 'value', 'fast')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_count_plans_unit
  ON stock_count_plans (month, product_id, COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE IF NOT EXISTS stock_counts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  count_date          date NOT NULL,
  plan_id             uuid REFERENCES stock_count_plans(id) ON DELETE SET NULL,
  product_id          uuid REFERENCES products(id) ON DELETE SET NULL,
  variant_id          uuid REFERENCES product_variants(id) ON DELETE SET NULL,
  label               text NOT NULL DEFAULT '',
  stock_unit          text NOT NULL DEFAULT 'pcs',
  system_units        integer NOT NULL,
  counted_units       integer NOT NULL CHECK (counted_units >= 0),
  difference          integer NOT NULL,
  write_off_id        uuid REFERENCES stock_write_offs(id) ON DELETE SET NULL,
  note                text,
  created_by          uuid,
  created_by_username text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_counts_unit ON stock_counts (product_id, variant_id, count_date DESC);

ALTER TABLE stock_count_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_counts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON stock_count_plans, stock_counts FROM anon, authenticated;
GRANT SELECT ON stock_count_plans, stock_counts TO authenticated;
GRANT ALL ON stock_count_plans, stock_counts TO service_role;
DROP POLICY IF EXISTS stock_count_plans_read ON stock_count_plans;
CREATE POLICY stock_count_plans_read ON stock_count_plans FOR SELECT TO authenticated USING (money_can_view());
DROP POLICY IF EXISTS stock_counts_read ON stock_counts;
CREATE POLICY stock_counts_read ON stock_counts FOR SELECT TO authenticated USING (money_can_view());

-- "Product — Region · Size", the same label the write-offs use.
CREATE OR REPLACE FUNCTION report_unit_label(p_product_id uuid, p_variant_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.name || COALESCE(' — ' || NULLIF(concat_ws(' · ', NULLIF(btrim(v.region), ''), NULLIF(btrim(v.size), '')), ''), '')
  FROM products p LEFT JOIN product_variants v ON v.id = p_variant_id
  WHERE p.id = p_product_id;
$$;

REVOKE ALL ON FUNCTION report_unit_label(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Units each product (or option) sold from lots in the last p_days days
-- (orders not cancelled / returned, by the day they were placed).
CREATE OR REPLACE FUNCTION report_units_sold_since(p_days integer)
RETURNS TABLE (product_id uuid, variant_id uuid, units bigint, last_sold date)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT oi.product_id, oi.variant_id,
         COALESCE(sum(x.units - x.units_back) FILTER (WHERE o.created_at >= now() - make_interval(days => p_days)), 0)::bigint,
         max(money_dhaka_date(o.created_at))
  FROM order_item_lots x
  JOIN order_items oi ON oi.id = x.order_item_id
  JOIN orders o ON o.id = x.order_id
  WHERE o.status NOT IN ('cancelled', 'returned') AND oi.product_id IS NOT NULL
  GROUP BY oi.product_id, oi.variant_id;
$$;

REVOKE ALL ON FUNCTION report_units_sold_since(integer) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- PART 4 — monthly stock count: pick, read, save
-- ---------------------------------------------------------------------------
-- The month's list (made the first time it is asked for):
--   * how many: every product with stock in lots should be counted at
--     least once in about 6 months → ceil(products ÷ 6), at least 15 and
--     at most 20 (never more than there are);
--   * first the "rotation": never counted, then longest since the last
--     count (ceil(products ÷ 6) of them), so no product waits for ever;
--   * the rest: the most valuable stock and the fastest sellers not
--     counted in the last 60 days (they are counted more often).
CREATE OR REPLACE FUNCTION stock_count_pick(p_month date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_month    date := date_trunc('month', COALESCE(p_month, inventory_dhaka_today()))::date;
  v_total    integer;
  v_target   integer;
  v_rotation integer;
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM stock_count_plans WHERE month = v_month)
     AND v_month = date_trunc('month', inventory_dhaka_today())::date THEN
    CREATE TEMP TABLE IF NOT EXISTS _count_units (
      product_id uuid, variant_id uuid, label text, units bigint, value numeric, sold bigint,
      last_count date, rank_value double precision, rank_sold double precision
    ) ON COMMIT DROP;
    TRUNCATE _count_units;
    INSERT INTO _count_units (product_id, variant_id, label, units, value, sold, last_count)
    SELECT li.product_id, li.variant_id, report_unit_label(li.product_id, li.variant_id),
           sum(li.qty_remaining), sum(li.qty_remaining * li.landed_unit_cost_bdt),
           COALESCE(max(s.units), 0),
           (SELECT max(c.count_date) FROM stock_counts c
            WHERE c.product_id = li.product_id AND c.variant_id IS NOT DISTINCT FROM li.variant_id)
    FROM lot_items li
    JOIN products p ON p.id = li.product_id
    LEFT JOIN report_units_sold_since(90) s
      ON s.product_id = li.product_id AND s.variant_id IS NOT DISTINCT FROM li.variant_id
    GROUP BY li.product_id, li.variant_id
    HAVING sum(li.qty_remaining) > 0;

    UPDATE _count_units u SET rank_value = r.rv, rank_sold = r.rs
    FROM (SELECT product_id, variant_id, percent_rank() OVER (ORDER BY value) AS rv, percent_rank() OVER (ORDER BY sold) AS rs
          FROM _count_units) r
    WHERE r.product_id = u.product_id AND r.variant_id IS NOT DISTINCT FROM u.variant_id;

    SELECT count(*) INTO v_total FROM _count_units;
    v_rotation := ceil(v_total / 6.0)::integer;
    v_target := LEAST(v_total, LEAST(20, GREATEST(15, v_rotation)));
    v_rotation := LEAST(v_rotation, v_target);

    INSERT INTO stock_count_plans (month, product_id, variant_id, label, why)
    SELECT v_month, product_id, variant_id, label, CASE WHEN last_count IS NULL THEN 'never' ELSE 'oldest' END
    FROM _count_units
    ORDER BY last_count ASC NULLS FIRST, value DESC, label
    LIMIT v_rotation;

    INSERT INTO stock_count_plans (month, product_id, variant_id, label, why)
    SELECT v_month, u.product_id, u.variant_id, u.label, CASE WHEN u.rank_value >= u.rank_sold THEN 'value' ELSE 'fast' END
    FROM _count_units u
    WHERE NOT EXISTS (SELECT 1 FROM stock_count_plans p
                      WHERE p.month = v_month AND p.product_id = u.product_id AND p.variant_id IS NOT DISTINCT FROM u.variant_id)
      AND (u.last_count IS NULL OR u.last_count < inventory_dhaka_today() - 60)
    ORDER BY (COALESCE(u.rank_value, 0) + COALESCE(u.rank_sold, 0)) DESC, u.value DESC, u.label
    LIMIT v_target - v_rotation;

    -- Too few left after the 60-day rule: fill up with the oldest counts.
    INSERT INTO stock_count_plans (month, product_id, variant_id, label, why)
    SELECT v_month, u.product_id, u.variant_id, u.label, 'oldest'
    FROM _count_units u
    WHERE NOT EXISTS (SELECT 1 FROM stock_count_plans p
                      WHERE p.month = v_month AND p.product_id = u.product_id AND p.variant_id IS NOT DISTINCT FROM u.variant_id)
    ORDER BY u.last_count ASC NULLS FIRST, u.value DESC, u.label
    LIMIT GREATEST(v_target - (SELECT count(*) FROM stock_count_plans WHERE month = v_month), 0);
  END IF;

  RETURN jsonb_build_object(
    'month', v_month,
    'inventory_mode', inventory_mode_on(),
    'rows', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'plan_id', p.id, 'product_id', p.product_id, 'variant_id', p.variant_id,
               'label', COALESCE(report_unit_label(p.product_id, p.variant_id), p.label), 'why', p.why,
               'stock_unit', inventory_stock_unit(p.product_id, p.variant_id),
               'pack_size', inventory_pack_size(p.product_id, p.variant_id),
               'system_units', inventory_units_left(p.product_id, p.variant_id),
               'last_count', (SELECT max(c.count_date) FROM stock_counts c
                              WHERE c.product_id = p.product_id AND c.variant_id IS NOT DISTINCT FROM p.variant_id
                                AND (c.plan_id IS DISTINCT FROM p.id)),
               'counted', c.id IS NOT NULL, 'counted_units', c.counted_units, 'difference', c.difference,
               'counted_date', c.count_date)
             ORDER BY (c.id IS NOT NULL), p.label)
      FROM stock_count_plans p
      LEFT JOIN LATERAL (
        SELECT * FROM stock_counts c WHERE c.plan_id = p.id ORDER BY c.created_at DESC LIMIT 1
      ) c ON true
      WHERE p.month = v_month), '[]'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION stock_count_pick(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION stock_count_pick(date) TO authenticated;

-- Save counts: p_rows = [{product_id, variant_id, counted, note?}].
--   counted < system → a write-off "Count difference" (the units leave the
--                       lots, earliest expiry first, at their landed cost);
--   counted > system → the extra units go back into the newest lot of that
--                       product, as a write-off row with a gain
--                       (added_back, cost below 0);
--   equal            → just recorded.
-- Works only while Inventory mode is On (like Remove stock, Batch 41).
CREATE OR REPLACE FUNCTION stock_count_save(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row     jsonb;
  v_pid     uuid;
  v_vid     uuid;
  v_counted integer;
  v_system  integer;
  v_diff    integer;
  v_note    text;
  v_wo      uuid;
  v_lot     record;
  v_label   text;
  v_unit    text;
  v_plan    uuid;
  v_today   date := inventory_dhaka_today();
  v_out     jsonb := '[]'::jsonb;
  v_id      uuid;
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF NOT inventory_mode_on() THEN
    RAISE EXCEPTION 'The stock count works only while Inventory mode is On (stock then comes from lots).';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'Type at least one count.';
  END IF;

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    v_pid := NULLIF(v_row ->> 'product_id', '')::uuid;
    v_vid := NULLIF(v_row ->> 'variant_id', '')::uuid;
    v_counted := (v_row ->> 'counted')::integer;
    v_note := NULLIF(btrim(COALESCE(v_row ->> 'note', '')), '');
    IF v_pid IS NULL OR NOT EXISTS (SELECT 1 FROM products WHERE id = v_pid) THEN
      RAISE EXCEPTION 'Product not found.';
    END IF;
    IF v_vid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM product_variants WHERE id = v_vid AND product_id = v_pid) THEN
      RAISE EXCEPTION 'Option not found.';
    END IF;
    IF v_counted IS NULL OR v_counted < 0 THEN
      RAISE EXCEPTION 'Type what you counted (0 or more).';
    END IF;
    v_label := report_unit_label(v_pid, v_vid);
    v_unit := inventory_stock_unit(v_pid, v_vid);
    -- Lock the rows of this product while it is counted.
    PERFORM 1 FROM lot_items WHERE product_id = v_pid AND variant_id IS NOT DISTINCT FROM v_vid FOR UPDATE;
    v_system := inventory_units_left(v_pid, v_vid)::integer;
    v_diff := v_counted - v_system;
    v_wo := NULL;

    IF v_diff < 0 THEN
      v_wo := money_write_off_units(v_pid, v_vid, -v_diff, 'count_difference',
                                    COALESCE(v_note, format('Count: system %s, counted %s', v_system, v_counted)), NULL, NULL, NULL);
    ELSIF v_diff > 0 THEN
      SELECT li.id, li.landed_unit_cost_bdt AS cost, l.code INTO v_lot
      FROM lot_items li JOIN lots l ON l.id = li.lot_id
      WHERE li.product_id = v_pid AND li.variant_id IS NOT DISTINCT FROM v_vid
      ORDER BY l.lot_date DESC, l.created_at DESC, li.sort_order DESC
      LIMIT 1;
      IF NOT FOUND THEN
        RAISE EXCEPTION '"%" is in no lot yet, so the extra units have nowhere to go. Add it to a lot first.', v_label;
      END IF;
      v_wo := gen_random_uuid();
      INSERT INTO stock_movements (lot_item_id, movement_type, qty, reference, reason, created_by)
      VALUES (v_lot.id, 'adjustment', v_diff, 'Count ' || left(v_wo::text, 8),
              'Count difference: found ' || v_diff || ' more' || COALESCE(': ' || v_note, ''), auth.uid());
      INSERT INTO stock_write_offs (id, write_date, product_id, variant_id, label, units, reason, note, cost_bdt,
                                    lots, created_by, created_by_username, added_back)
      VALUES (v_wo, v_today, v_pid, v_vid, COALESCE(v_label, ''), v_diff, 'count_difference',
              COALESCE(v_note, format('Count: system %s, counted %s', v_system, v_counted)),
              -round(v_diff * v_lot.cost, 2),
              jsonb_build_array(jsonb_build_object('lot_item_id', v_lot.id, 'code', v_lot.code, 'units', v_diff, 'unit_cost', v_lot.cost)),
              auth.uid(), current_actor_username(), true);
      PERFORM write_activity('stock.count_found', 'product', v_pid::text, COALESCE(v_label, ''),
        format('Count: found %s %s more of %s than the system said — added back to %s (%s at landed cost)',
               v_diff, v_unit, COALESCE(v_label, ''), v_lot.code, money_short(v_diff * v_lot.cost)),
        jsonb_build_object('units', v_diff, 'lot', v_lot.code, 'cost', round(v_diff * v_lot.cost, 2)));
    END IF;

    -- The count belongs to this month's list, or to an earlier month's list
    -- not finished yet (finishing last month's list early in the next one).
    SELECT p.id INTO v_plan FROM stock_count_plans p
    WHERE p.product_id = v_pid AND p.variant_id IS NOT DISTINCT FROM v_vid
      AND (p.month = date_trunc('month', v_today)::date
           OR (NOT EXISTS (SELECT 1 FROM stock_counts c WHERE c.plan_id = p.id) AND NOT money_month_locked(p.month)))
    ORDER BY (p.month = date_trunc('month', v_today)::date) DESC, p.month DESC
    LIMIT 1;

    INSERT INTO stock_counts (count_date, plan_id, product_id, variant_id, label, stock_unit, system_units, counted_units,
                              difference, write_off_id, note, created_by, created_by_username)
    VALUES (v_today, v_plan, v_pid, v_vid, COALESCE(v_label, ''), v_unit, v_system, v_counted, v_diff, v_wo, v_note,
            auth.uid(), current_actor_username())
    RETURNING id INTO v_id;

    IF v_diff = 0 THEN
      PERFORM write_activity('stock.count', 'product', v_pid::text, COALESCE(v_label, ''),
        format('Count: %s %s of %s — the same as the system', v_counted, v_unit, COALESCE(v_label, '')),
        jsonb_build_object('units', v_counted));
    END IF;

    v_out := v_out || jsonb_build_object('count_id', v_id, 'product_id', v_pid, 'variant_id', v_vid, 'label', v_label,
                                         'system_units', v_system, 'counted_units', v_counted, 'difference', v_diff,
                                         'write_off_id', v_wo);
  END LOOP;
  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION stock_count_save(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION stock_count_save(jsonb) TO authenticated;

-- Any product's own count history (for "count any product any time").
CREATE OR REPLACE FUNCTION stock_count_history(p_limit integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', c.id, 'count_date', c.count_date, 'label', c.label, 'stock_unit', c.stock_unit,
                     'system_units', c.system_units, 'counted_units', c.counted_units, 'difference', c.difference,
                     'planned', c.plan_id IS NOT NULL, 'by', c.created_by_username, 'cost', w.cost_bdt)
                     ORDER BY c.created_at DESC)
    FROM (SELECT * FROM stock_counts ORDER BY created_at DESC LIMIT GREATEST(LEAST(COALESCE(p_limit, 100), 500), 1)) c
    LEFT JOIN stock_write_offs w ON w.id = c.write_off_id), '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION stock_count_history(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION stock_count_history(integer) TO authenticated;

-- ---------------------------------------------------------------------------
-- PART 5 — locking and unlocking a month
-- ---------------------------------------------------------------------------
-- The password typed again within 5 minutes (as Inventory mode, Batch 39).
CREATE OR REPLACE FUNCTION money_password_recent()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT max((e ->> 'timestamp')::bigint)
    FROM jsonb_array_elements(COALESCE(auth.jwt() -> 'amr', '[]'::jsonb)) e
    WHERE e ->> 'method' = 'password'), 0) >= extract(epoch FROM now())::bigint - 300;
$$;

REVOKE ALL ON FUNCTION money_password_recent() FROM PUBLIC, anon, authenticated;

-- Before locking: books balance ✓, no order from that month still being
-- processed, every Steadfast payout of that month placed in an account,
-- the month's stock count done.
CREATE OR REPLACE FUNCTION money_lock_checklist(p_month date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  -- 1. Books balance.
  v_pos := money_position();
  v_ok := (v_pos ->> 'balanced')::boolean IS TRUE;
  v_items := v_items || jsonb_build_object('key', 'balance', 'ok', v_ok, 'title', 'Books balance',
    'detail', CASE WHEN v_pos ->> 'balanced' IS NULL THEN 'The opening balances are not confirmed yet, so there is no balance check.'
                   WHEN v_ok THEN 'The balance check is green.'
                   ELSE 'The books are off by ' || money_short((v_pos ->> 'difference')::numeric) || '. Fix that first (Money page → Show the sums).' END);

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
$$;

REVOKE ALL ON FUNCTION money_lock_checklist(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION money_lock_checklist(date) TO authenticated;

CREATE OR REPLACE FUNCTION money_lock_month(p_month date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  PERFORM write_activity('money.lock_month', 'money', v_month::text, to_char(v_month, 'FMMonth YYYY'),
    'Locked ' || to_char(v_month, 'FMMonth YYYY') || ': nothing dated in it can be added, changed or deleted', v_check);
  RETURN money_lock_checklist(v_month);
END;
$$;

REVOKE ALL ON FUNCTION money_lock_month(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION money_lock_month(date) TO authenticated;

-- Unlock: the Super Admin only, with the password and a reason (Activity Log).
CREATE OR REPLACE FUNCTION money_unlock_month(p_month date, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  PERFORM write_activity('money.unlock_month', 'money', v_month::text, to_char(v_month, 'FMMonth YYYY'),
    'Unlocked ' || to_char(v_month, 'FMMonth YYYY') || ' — reason: ' || v_reason, jsonb_build_object('reason', v_reason));
  RETURN money_lock_checklist(v_month);
END;
$$;

REVOKE ALL ON FUNCTION money_unlock_month(date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION money_unlock_month(date, text) TO authenticated;

CREATE OR REPLACE FUNCTION money_locked_months()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object('month', month, 'label', to_char(month, 'FMMonth YYYY'), 'locked', locked,
                     'locked_at', locked_at, 'locked_by', locked_by_username, 'unlocked_at', unlocked_at,
                     'unlocked_by', unlocked_by_username, 'unlock_reason', unlock_reason) ORDER BY month DESC)
    FROM money_month_locks), '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION money_locked_months() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION money_locked_months() TO authenticated;

-- ---------------------------------------------------------------------------
-- PART 6 — reports (all only with "View profit & costs")
-- ---------------------------------------------------------------------------
-- Months of a range, each as [from, to] clipped to the range.
CREATE OR REPLACE FUNCTION report_months(p_from date, p_to date)
RETURNS TABLE (month date, m_from date, m_to date)
LANGUAGE sql
STABLE
AS $$
  SELECT m::date, GREATEST(m::date, p_from), LEAST((m + interval '1 month - 1 day')::date, p_to)
  FROM generate_series(date_trunc('month', p_from::timestamp), date_trunc('month', p_to::timestamp), interval '1 month') m;
$$;

-- Expenses by category for a range: the same rows money_profit_parts adds
-- up (type expense, in the range, from the start date on).
CREATE OR REPLACE FUNCTION report_expense_categories(p_from date, p_to date)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('category_id', c.id, 'name', c.name, 'amount', x.amount)
                            ORDER BY x.amount DESC, c.name), '[]'::jsonb)
  FROM (
    SELECT m.category_id, -sum(m.amount) AS amount
    FROM money_movements m
    WHERE m.type = 'expense' AND m.entry_date BETWEEN p_from AND p_to
      AND (money_start_date() IS NULL OR m.entry_date >= money_start_date())
    GROUP BY m.category_id
  ) x JOIN money_categories c ON c.id = x.category_id;
$$;

REVOKE ALL ON FUNCTION report_expense_categories(date, date) FROM PUBLIC, anon, authenticated;

-- Which months of a range are locked.
CREATE OR REPLACE FUNCTION report_locked_in(p_from date, p_to date)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(to_char(month, 'YYYY-MM-DD') ORDER BY month), '[]'::jsonb)
  FROM money_month_locks
  WHERE locked AND month BETWEEN date_trunc('month', p_from)::date AND p_to;
$$;

REVOKE ALL ON FUNCTION report_locked_in(date, date) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION report_check_range(p_from date, p_to date)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION 'Pick a date range.';
  END IF;
  IF p_to - p_from > 3700 THEN
    RAISE EXCEPTION 'Pick at most 10 years.';
  END IF;
END;
$$;

-- 1. Profit & loss: money_profit_parts for the range (the same function as
-- the Money page and the Dashboard), its expenses by category and, when the
-- range is longer than one month, the same for each month.
CREATE OR REPLACE FUNCTION report_profit_loss(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  v_parts := money_profit_parts(p_from, p_to);
  IF date_trunc('month', p_from) <> date_trunc('month', p_to) THEN
    FOR v_m IN SELECT * FROM report_months(p_from, p_to) LOOP
      v_p := money_profit_parts(v_m.m_from, v_m.m_to);
      v_months := v_months || (v_p || jsonb_build_object(
        'month', v_m.month, 'gross_profit', (v_p ->> 'sales')::numeric - (v_p ->> 'cost')::numeric,
        'expenses_by_category', report_expense_categories(v_m.m_from, v_m.m_to),
        'locked', money_month_locked(v_m.month)));
    END LOOP;
  END IF;
  RETURN jsonb_build_object(
    'from', p_from, 'to', p_to,
    'parts', v_parts || jsonb_build_object('gross_profit', (v_parts ->> 'sales')::numeric - (v_parts ->> 'cost')::numeric),
    'expenses_by_category', report_expense_categories(p_from, p_to),
    'months', v_months,
    'locked_months', report_locked_in(p_from, p_to),
    'start_date', money_start_date());
END;
$$;

REVOKE ALL ON FUNCTION report_profit_loss(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION report_profit_loss(date, date) TO authenticated;

-- 2. Sales (like Kaarbar): the orders PLACED in the range (not cancelled),
-- what was received on them and what is still unpaid (a Returned order
-- owes nothing, as in the customer dues). Profit counts an order on the
-- day it is delivered instead, so these totals are a different question
-- from Profit & loss.
CREATE OR REPLACE FUNCTION report_sales(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  PERFORM report_check_range(p_from, p_to);
  RETURN (
    WITH o AS (
      SELECT o.id, o.order_number, o.created_at, money_dhaka_date(o.created_at) AS day, o.status, o.source,
             o.customer_name, o.customer_phone, o.total,
             COALESCE((SELECT sum(CASE WHEN p.kind = 'refund' THEN -p.amount ELSE p.amount END)
                       FROM order_payments p WHERE p.order_id = o.id), 0) AS paid
      FROM orders o
      WHERE o.status <> 'cancelled' AND money_dhaka_date(o.created_at) BETWEEN p_from AND p_to
    ), r AS (
      SELECT o.*, CASE WHEN o.status = 'returned' THEN 0 ELSE o.total END AS owed_total,
             GREATEST((CASE WHEN o.status = 'returned' THEN 0 ELSE o.total END) - o.paid, 0) AS due
      FROM o
    )
    SELECT jsonb_build_object(
      'from', p_from, 'to', p_to,
      'totals', jsonb_build_object(
        'entries', (SELECT count(*) FROM r WHERE status <> 'returned'),
        'returned', (SELECT count(*) FROM r WHERE status = 'returned'),
        'total', (SELECT COALESCE(sum(owed_total), 0) FROM r),
        'received', (SELECT COALESCE(sum(paid), 0) FROM r),
        'unpaid', (SELECT COALESCE(sum(due), 0) FROM r)),
      'by_source', COALESCE((SELECT jsonb_agg(jsonb_build_object('source', source, 'entries', n, 'total', t) ORDER BY t DESC)
                             FROM (SELECT source, count(*) AS n, sum(owed_total) AS t FROM r WHERE status <> 'returned' GROUP BY source) s), '[]'::jsonb),
      'by_day', COALESCE((SELECT jsonb_agg(jsonb_build_object('day', day, 'entries', n, 'total', t) ORDER BY day)
                          FROM (SELECT day, count(*) AS n, sum(owed_total) AS t FROM r WHERE status <> 'returned' GROUP BY day) d), '[]'::jsonb),
      'orders', COALESCE((SELECT jsonb_agg(jsonb_build_object('order_id', id, 'order_number', order_number, 'day', day,
                          'status', status, 'source', source, 'customer_name', customer_name, 'total', owed_total,
                          'paid', paid, 'due', due) ORDER BY created_at DESC) FROM r), '[]'::jsonb),
      'locked_months', report_locked_in(p_from, p_to))
  );
END;
$$;

REVOKE ALL ON FUNCTION report_sales(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION report_sales(date, date) TO authenticated;

-- 3. Products: the per-product table of inventory_sales_profit for the
-- range (sales, cost, profit, margin — the same rows Sales profit shows),
-- plus for every product its stock left and when it last sold.
CREATE OR REPLACE FUNCTION report_products(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sp jsonb;
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  PERFORM report_check_range(p_from, p_to);
  v_sp := inventory_sales_profit(p_from, p_to);
  RETURN jsonb_build_object(
    'from', p_from, 'to', p_to,
    'totals', v_sp -> 'totals',
    'sold', v_sp -> 'products',
    'units', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'product_id', u.product_id, 'variant_id', u.variant_id,
               'label', u.product_name || COALESCE(' — ' || u.option_label, ''),
               'is_active', u.is_active, 'stock_unit', u.stock_unit, 'pack_size', u.pack_size,
               'units_left', u.lot_pieces_left,
               'stock_value', COALESCE((SELECT round(sum(li.qty_remaining * li.landed_unit_cost_bdt), 2) FROM lot_items li
                                        WHERE li.product_id = u.product_id AND li.variant_id IS NOT DISTINCT FROM u.variant_id), 0),
               'sold_60', COALESCE(s.units, 0), 'last_sold', s.last_sold,
               'has_cost', u.lot_rows > 0)
             ORDER BY u.product_name, u.option_label)
      FROM inventory_stock_units() u
      LEFT JOIN report_units_sold_since(60) s ON s.product_id = u.product_id AND s.variant_id IS NOT DISTINCT FROM u.variant_id), '[]'::jsonb),
    'locked_months', report_locked_in(p_from, p_to));
END;
$$;

REVOKE ALL ON FUNCTION report_products(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION report_products(date, date) TO authenticated;

-- Each delivered order line's sale after the order discount, shared over
-- the lines by line total in whole paisa (largest remainder) — exactly as
-- inventory_sales_profit shares it for its per-product table.
CREATE OR REPLACE FUNCTION report_line_sales()
RETURNS TABLE (order_item_id uuid, order_id uuid, sale numeric, units integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH d AS (
    SELECT id, discount FROM orders WHERE status = 'delivered'
  ), lines AS (
    SELECT c.*, d.discount AS order_discount, d.id AS oid
    FROM inventory_item_costs((SELECT COALESCE(array_agg(id), '{}') FROM d)) c
    JOIN d ON d.id = c.order_id
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
  )
  SELECT r.order_item_id, r.order_id,
         (r.lp - r.d_floor - CASE WHEN r.d_rank <= r.d_left THEN 1 ELSE 0 END) / 100.0,
         r.units
  FROM ranked r;
$$;

REVOKE ALL ON FUNCTION report_line_sales() FROM PUBLIC, anon, authenticated;

-- 4. Lots: per lot, all time — units bought / sold / on open orders /
-- removed / left, what was paid (buy price, trip costs = weight + other
-- bills), landed cost, and the sales and profit of its delivered units (a
-- line's sale is shared over its lots by units).
CREATE OR REPLACE FUNCTION report_lots()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  RETURN (
    WITH ls AS (SELECT * FROM report_line_sales()),
    taken AS (
      SELECT li.lot_id, o.status,
             sum(x.units - x.units_back) AS units,
             sum((x.units - x.units_back) * x.unit_cost_bdt) AS cost,
             sum(CASE WHEN ls.units > 0 THEN ls.sale * (x.units - x.units_back) / ls.units ELSE 0 END) AS sale
      FROM order_item_lots x
      JOIN lot_items li ON li.id = x.lot_item_id
      JOIN orders o ON o.id = x.order_id
      LEFT JOIN ls ON ls.order_item_id = x.order_item_id
      GROUP BY li.lot_id, o.status
    ),
    moves AS (
      SELECT li.lot_id,
             sum(m.qty) FILTER (WHERE m.movement_type IN ('opening', 'purchase')) AS bought,
             -sum(m.qty) FILTER (WHERE m.movement_type = 'adjustment' AND m.qty < 0) AS removed,
             sum(m.qty) FILTER (WHERE m.movement_type = 'adjustment' AND m.qty > 0) AS found
      FROM stock_movements m JOIN lot_items li ON li.id = m.lot_item_id
      GROUP BY li.lot_id
    ),
    items AS (
      SELECT lot_id, sum(qty_remaining) AS left_units, sum(buy_value_bdt) AS buy_value,
             round(sum(qty_remaining * landed_unit_cost_bdt), 2) AS left_value,
             count(*) AS rows_n
      FROM lot_items GROUP BY lot_id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'lot_id', l.id, 'code', l.code, 'kind', l.kind, 'lot_date', l.lot_date,
             'supplier', COALESCE(s.name, NULLIF(l.supplier, ''), ''), 'costs_pending', l.costs_pending,
             'rows', COALESCE(i.rows_n, 0),
             'units_bought', COALESCE(mv.bought, 0),
             'units_sold', COALESCE((SELECT sum(t.units) FROM taken t WHERE t.lot_id = l.id AND t.status = 'delivered'), 0),
             'units_on_orders', COALESCE((SELECT sum(t.units) FROM taken t WHERE t.lot_id = l.id AND t.status IN ('pending', 'confirmed', 'shipped')), 0),
             'units_removed', COALESCE(mv.removed, 0),
             'units_found', COALESCE(mv.found, 0),
             'units_left', COALESCE(i.left_units, 0),
             'buy_value', round(COALESCE(i.buy_value, 0), 2),
             'trip_weight', COALESCE((SELECT sum(amount_bdt) FROM lot_costs c WHERE c.lot_id = l.id AND c.cost_type = 'weight'), 0),
             'trip_other', COALESCE((SELECT sum(amount_bdt) FROM lot_costs c WHERE c.lot_id = l.id AND c.cost_type = 'other'), 0),
             'landed_total', COALESCE((SELECT round(sum(li.qty * li.landed_unit_cost_bdt), 2) FROM lot_items li WHERE li.lot_id = l.id), 0),
             'left_value', COALESCE(i.left_value, 0),
             'sales', COALESCE((SELECT round(sum(t.sale), 2) FROM taken t WHERE t.lot_id = l.id AND t.status = 'delivered'), 0),
             'cost_sold', COALESCE((SELECT round(sum(t.cost), 2) FROM taken t WHERE t.lot_id = l.id AND t.status = 'delivered'), 0),
             'locked', money_month_locked(l.lot_date))
           ORDER BY l.lot_date DESC, l.code DESC), '[]'::jsonb)
    FROM lots l
    LEFT JOIN suppliers s ON s.id = l.supplier_id
    LEFT JOIN moves mv ON mv.lot_id = l.id
    LEFT JOIN items i ON i.lot_id = l.id
  );
END;
$$;

REVOKE ALL ON FUNCTION report_lots() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION report_lots() TO authenticated;

-- 5. Stock: every lot row with units left (expiry, landed cost, value), and
-- per product how fast it sells (units from lots on orders placed in the
-- last 90 days ÷ 3 = a month). "Will it sell in time": sold earliest
-- expiry first, the units up to and including this row must sell before
-- its expiry month ends at that speed.
CREATE OR REPLACE FUNCTION report_stock_rows()
RETURNS TABLE (
  lot_item_id uuid, product_id uuid, variant_id uuid, label text, stock_unit text, pack_size integer,
  lot_code text, lot_date date, expiry_date date, units integer, unit_cost numeric, value numeric,
  per_month numeric, units_before integer, sells_in_time boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH rows AS (
    SELECT li.id, li.product_id, li.variant_id, report_unit_label(li.product_id, li.variant_id) AS label,
           inventory_stock_unit(li.product_id, li.variant_id) AS su, inventory_pack_size(li.product_id, li.variant_id) AS ps,
           l.code, l.lot_date, li.expiry_date, li.qty_remaining, li.landed_unit_cost_bdt, li.sort_order, l.kind
    FROM lot_items li JOIN lots l ON l.id = li.lot_id
    WHERE li.qty_remaining > 0
  ), speed AS (
    SELECT product_id, variant_id, round(units / 3.0, 1) AS per_month FROM report_units_sold_since(90)
  ), ordered AS (
    SELECT r.*, COALESCE(s.per_month, 0) AS per_month,
           sum(r.qty_remaining) OVER (PARTITION BY r.product_id, r.variant_id
                                      ORDER BY r.expiry_date ASC NULLS LAST, r.lot_date, (r.kind = 'opening') DESC, length(r.code), r.code, r.sort_order
                                      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS through
    FROM rows r
    LEFT JOIN speed s ON s.product_id = r.product_id AND s.variant_id IS NOT DISTINCT FROM r.variant_id
  )
  SELECT o.id, o.product_id, o.variant_id, o.label, o.su, o.ps, o.code, o.lot_date, o.expiry_date, o.qty_remaining,
         round(o.landed_unit_cost_bdt, 2), round(o.qty_remaining * o.landed_unit_cost_bdt, 2), o.per_month,
         (o.through - o.qty_remaining)::integer,
         CASE WHEN o.expiry_date IS NULL THEN NULL
              ELSE o.per_month * GREATEST(((date_trunc('month', o.expiry_date) + interval '1 month - 1 day')::date - inventory_dhaka_today()), 0) / 30.4
                   >= o.through END
  FROM ordered o;
$$;

REVOKE ALL ON FUNCTION report_stock_rows() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION report_stock()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  RETURN jsonb_build_object(
    'today', inventory_dhaka_today(),
    'rows', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.label, r.expiry_date NULLS LAST, r.lot_code) FROM report_stock_rows() r), '[]'::jsonb),
    'total_value', COALESCE((SELECT round(sum(qty_remaining * landed_unit_cost_bdt), 2) FROM lot_items), 0));
END;
$$;

REVOKE ALL ON FUNCTION report_stock() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION report_stock() TO authenticated;

-- 7. Customers: what each customer owes (the same per-customer dues as
-- Customers → To receive, Batch 41) with its age — 0–30 / 31–60 / over 60
-- days, by the day each unpaid order was placed; a previous balance (from
-- Kaarbar) counts from the start date. Top customers for the range: what
-- they bought (orders delivered in the range) and the profit on them (the
-- same order rows as Sales profit; orders without a lot cost add no profit).
CREATE OR REPLACE FUNCTION report_customers(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
             sum((x ->> 'profit')::numeric) FILTER (WHERE (x ->> 'costed')::boolean) AS profit,
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
        WHERE s.orders > 0), '[]'::jsonb));
  END;
$$;

REVOKE ALL ON FUNCTION report_customers(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION report_customers(date, date) TO authenticated;

-- 8. Day book: every money movement of the range, per account, with the
-- balance before the range and the running balance after each line (the
-- same money_ledger the account balances add up).
CREATE OR REPLACE FUNCTION report_day_book(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  PERFORM report_check_range(p_from, p_to);
  RETURN (
    WITH before AS (
      SELECT account_id, sum(amount) AS amt FROM money_ledger WHERE entry_date < p_from GROUP BY account_id
    ), lines AS (
      SELECT l.*, sum(l.amount) OVER (PARTITION BY l.account_id ORDER BY l.entry_date, l.created_at, l.source_id
                                      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS run
      FROM money_ledger l WHERE l.entry_date BETWEEN p_from AND p_to
    )
    SELECT jsonb_build_object(
      'from', p_from, 'to', p_to,
      'accounts', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'account_id', a.id, 'name', a.name, 'kind', a.kind,
                 'opening', COALESCE(b.amt, 0),
                 'money_in', COALESCE((SELECT sum(amount) FROM lines x WHERE x.account_id = a.id AND x.amount > 0), 0),
                 'money_out', COALESCE((SELECT -sum(amount) FROM lines x WHERE x.account_id = a.id AND x.amount < 0), 0),
                 'closing', COALESCE(b.amt, 0) + COALESCE((SELECT sum(amount) FROM lines x WHERE x.account_id = a.id), 0),
                 'lines', COALESCE((
                   SELECT jsonb_agg(jsonb_build_object('date', x.entry_date, 'type', x.type, 'amount', x.amount,
                            'balance', COALESCE(b.amt, 0) + x.run, 'note', x.note, 'reference', x.reference,
                            'category', (SELECT c.name FROM money_categories c WHERE c.id = x.category_id),
                            'by', x.created_by_username, 'source', x.source, 'source_id', x.source_id)
                          ORDER BY x.entry_date, x.created_at, x.source_id)
                   FROM lines x WHERE x.account_id = a.id), '[]'::jsonb))
               ORDER BY (a.kind = 'steadfast'), a.sort_order, a.created_at)
        FROM money_accounts a LEFT JOIN before b ON b.account_id = a.id
        WHERE NOT a.archived OR b.amt IS NOT NULL OR EXISTS (SELECT 1 FROM lines x WHERE x.account_id = a.id)), '[]'::jsonb),
      'locked_months', report_locked_in(p_from, p_to))
  );
END;
$$;

REVOKE ALL ON FUNCTION report_day_book(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION report_day_book(date, date) TO authenticated;

-- 9. Investors: capital in, returned, still owed (money_to_give_rows, as
-- the Investors page) and what moved in the range.
CREATE OR REPLACE FUNCTION report_investors(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  PERFORM report_check_range(p_from, p_to);
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'id', g.id, 'name', g.name, 'capital_in', g.capital_in, 'capital_back', g.capital_back, 'owed', g.owed,
             'share_all', g.share_all,
             'in_range', COALESCE((SELECT sum(m.amount) FROM money_movements m WHERE m.party_id = g.id AND m.type = 'investor_in'
                                     AND m.entry_date BETWEEN p_from AND p_to
                                     AND (money_start_date() IS NULL OR m.entry_date >= money_start_date())), 0),
             'back_range', COALESCE((SELECT -sum(m.amount) FROM money_movements m WHERE m.party_id = g.id AND m.type = 'investor_capital_back'
                                     AND m.entry_date BETWEEN p_from AND p_to
                                     AND (money_start_date() IS NULL OR m.entry_date >= money_start_date())), 0),
             'share_range', COALESCE((SELECT -sum(m.amount) FROM money_movements m WHERE m.party_id = g.id AND m.type = 'investor_profit_share'
                                     AND m.entry_date BETWEEN p_from AND p_to
                                     AND (money_start_date() IS NULL OR m.entry_date >= money_start_date())), 0))
           ORDER BY g.name)
    FROM money_to_give_rows() g WHERE g.kind = 'investor'), '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION report_investors(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION report_investors(date, date) TO authenticated;

-- 10. Charts: the last 12 months (this month included) — Your profit and
-- Net profit (money_profit_parts per month), and money in vs money out
-- (money_ledger; moves between accounts and Steadfast payouts are only
-- money changing place, so they are left out, as are opening balances).
CREATE OR REPLACE FUNCTION report_charts()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_to   date := inventory_dhaka_today();
  v_from date := (date_trunc('month', inventory_dhaka_today()) - interval '11 months')::date;
  v_out  jsonb := '[]'::jsonb;
  v_m    record;
  v_p    jsonb;
  v_in   numeric;
  v_outm numeric;
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  FOR v_m IN SELECT * FROM report_months(v_from, v_to) LOOP
    v_p := money_profit_parts(v_m.m_from, v_m.m_to);
    SELECT COALESCE(sum(amount) FILTER (WHERE amount > 0), 0), COALESCE(-sum(amount) FILTER (WHERE amount < 0), 0)
    INTO v_in, v_outm
    FROM money_ledger
    WHERE entry_date BETWEEN v_m.m_from AND v_m.m_to
      AND type NOT IN ('transfer_in', 'transfer_out', 'steadfast_payout_in', 'steadfast_payout_out', 'opening_balance');
    v_out := v_out || jsonb_build_object('month', v_m.month, 'your_profit', (v_p ->> 'your_profit')::numeric,
                                         'net_profit', (v_p ->> 'net_profit')::numeric, 'money_in', v_in, 'money_out', v_outm,
                                         'locked', money_month_locked(v_m.month));
  END LOOP;
  RETURN jsonb_build_object('from', v_from, 'to', v_to, 'months', v_out);
END;
$$;

REVOKE ALL ON FUNCTION report_charts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION report_charts() TO authenticated;

-- ---------------------------------------------------------------------------
-- PART 7 — the Dashboard
-- ---------------------------------------------------------------------------
-- money_summary for the period (the SAME call as the Money page: profit,
-- return on money, money now, balance check), Your profit for the previous
-- period (money_profit_parts) and the "Needs attention" counts.
CREATE OR REPLACE FUNCTION money_dashboard(p_from date, p_to date, p_prev_from date, p_prev_to date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today   date := inventory_dhaka_today();
  v_month   date := date_trunc('month', inventory_dhaka_today())::date;
  v_summary jsonb;
  v_prev    jsonb;
  v_expiring integer;
  v_short   integer;
  v_dues30  integer;
  v_dues30_amt numeric;
  v_no_cost integer;
  v_no_weight integer;
  v_plan    integer;
  v_counted integer;
  v_has_stock boolean;
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  v_summary := money_summary(p_from, p_to);
  IF p_prev_from IS NOT NULL AND p_prev_to IS NOT NULL AND p_prev_to >= p_prev_from THEN
    v_prev := money_profit_parts(p_prev_from, p_prev_to);
  END IF;

  -- Expiring before they sell: within 90 days and not selling fast enough.
  SELECT count(DISTINCT (product_id, variant_id)) INTO v_expiring
  FROM report_stock_rows()
  WHERE expiry_date IS NOT NULL AND expiry_date <= v_today + 90 AND sells_in_time IS FALSE;

  SELECT count(*) INTO v_short FROM stock_shortfalls WHERE status = 'open';

  SELECT count(*), COALESCE(sum(due), 0) INTO v_dues30, v_dues30_amt
  FROM (SELECT k.customer_key, sum(k.due) AS due
        FROM order_customer_keys() k JOIN orders o ON o.id = k.order_id
        WHERE k.due > 0 AND money_dhaka_date(o.created_at) < v_today - 30
        GROUP BY k.customer_key) x;

  SELECT count(*) FILTER (WHERE is_active AND lot_rows = 0), count(*) FILTER (WHERE is_active AND weight_grams IS NULL)
  INTO v_no_cost, v_no_weight
  FROM inventory_stock_units();

  SELECT count(*), count(*) FILTER (WHERE EXISTS (SELECT 1 FROM stock_counts c WHERE c.plan_id = p.id))
  INTO v_plan, v_counted
  FROM stock_count_plans p WHERE p.month = v_month;
  v_has_stock := EXISTS (SELECT 1 FROM lot_items WHERE qty_remaining > 0);

  RETURN jsonb_build_object(
    'summary', v_summary,
    'previous', CASE WHEN v_prev IS NULL THEN NULL ELSE jsonb_build_object(
      'from', p_prev_from, 'to', p_prev_to, 'your_profit', (v_prev ->> 'your_profit')::numeric,
      'net_profit', (v_prev ->> 'net_profit')::numeric) END,
    'attention', jsonb_build_object(
      'expiring', v_expiring,
      'sold_without_stock', v_short,
      'dues_over_30', v_dues30,
      'dues_over_30_amount', v_dues30_amt,
      'no_buy_price', v_no_cost,
      'no_weight', v_no_weight,
      'count_planned', v_plan,
      'count_done', v_counted,
      'count_due', v_has_stock AND inventory_mode_on() AND (v_plan = 0 OR v_counted < v_plan),
      'last_month_locked', money_month_locked((v_month - interval '1 month')::date),
      'last_month', (v_month - interval '1 month')::date));
END;
$$;

REVOKE ALL ON FUNCTION money_dashboard(date, date, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION money_dashboard(date, date, date, date) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
