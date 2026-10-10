-- ============================================================
-- Batch 39 — Inventory: units, sales from lots, order profit, Inventory
-- mode On (reports/batch-39.txt).
--
--   Units       products / product_variants get stock_unit ('pcs' | 'ml'
--               | 'g', default 'pcs') and pack_size (whole number, default
--               1). Lots keep stock and cost PER UNIT. With pack size 1
--               (almost every product) nothing changes. order_items gets
--               sold_unit: NULL = whole packs (every order so far), or the
--               unit word when the admin sold loose units ("150 pcs").
--   Suppliers   a list (suppliers) instead of free text; lots.supplier_id.
--               The old lots.supplier text stays and is kept filled.
--   Sales       while Inventory mode is On, every order line takes units
--               from lots (earliest expiry first) and records where they
--               came from in order_item_lots. Cancel, return, edits and
--               deletes give the units back to the same lot rows. The
--               shop's stock number is kept equal to the whole packs left
--               in lots, so checkout's existing checks keep working.
--               This is done by triggers on order_items and orders, so
--               place_order(), cancel_order() and the delete function need
--               no change of their own.
--   Shortfalls  admin only: "Not in stock — sell anyway?" records the
--               missing units in stock_shortfalls; the next lot fills them
--               and the cost difference goes to cost_adjustments.
--   Late bills  sold units keep their locked cost; the extra for sold
--               units goes to cost_adjustments (dated the bill's date).
--   Profit      order_profit() and inventory_sales_profit(), only with
--               "View profit & costs".
--   Returned    a new order status, set by admin_mark_order_returned().
--   Mode        inventory_set_mode() turns Inventory mode On (only once
--               the opening stock L-000 is confirmed) or Off, with the
--               Super Admin's password re-confirmed. The guard trigger
--               refuses any other way of changing it.
--
-- With Inventory mode Off every existing function behaves exactly as
-- before: no order line takes anything from lots, and nothing changes a
-- product's stock number that did not change it before. (Order lines sold
-- in loose units are new; while Off they do not change the stock number.)
--
-- Additive: new tables, new columns with defaults, new functions and
-- triggers. Existing order / stock functions are replaced with the same
-- behaviour while Off (allowed for this batch). The orders.status check
-- is widened to allow 'returned'. Nothing is dropped or renamed.
-- Safe to run more than once.
-- ============================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- PART 0 — units and pack size
-- ---------------------------------------------------------------------------
ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_unit text NOT NULL DEFAULT 'pcs';
ALTER TABLE products ADD COLUMN IF NOT EXISTS pack_size integer NOT NULL DEFAULT 1;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS stock_unit text NOT NULL DEFAULT 'pcs';
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS pack_size integer NOT NULL DEFAULT 1;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS sold_unit text;

ALTER TABLE lot_items ADD COLUMN IF NOT EXISTS entry_unit text NOT NULL DEFAULT 'pack';
ALTER TABLE lot_items ADD COLUMN IF NOT EXISTS pack_size integer NOT NULL DEFAULT 1;
-- The row's exact buy value in taka (what was entered × its price). With
-- pack size 1 this is qty × unit_price_bdt, as in Batch 38.
ALTER TABLE lot_items ADD COLUMN IF NOT EXISTS buy_value_bdt numeric(18,4) NOT NULL DEFAULT 0;
ALTER TABLE lot_items ADD COLUMN IF NOT EXISTS weight_guessed boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_pack_check') THEN
    ALTER TABLE products ADD CONSTRAINT products_pack_check
      CHECK (stock_unit IN ('pcs', 'ml', 'g') AND pack_size BETWEEN 1 AND 1000000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_variants_pack_check') THEN
    ALTER TABLE product_variants ADD CONSTRAINT product_variants_pack_check
      CHECK (stock_unit IN ('pcs', 'ml', 'g') AND pack_size BETWEEN 1 AND 1000000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_items_sold_unit_check') THEN
    ALTER TABLE order_items ADD CONSTRAINT order_items_sold_unit_check
      CHECK (sold_unit IS NULL OR sold_unit IN ('pcs', 'ml', 'g'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lot_items_units_check') THEN
    ALTER TABLE lot_items ADD CONSTRAINT lot_items_units_check
      CHECK (entry_unit IN ('pack', 'unit') AND pack_size BETWEEN 1 AND 1000000
             AND (entry_unit = 'unit' OR qty % pack_size = 0));
  END IF;
  -- Batch 39 Part 2.5: "Returned" is a status of its own.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_status_check'
                 AND pg_get_constraintdef(oid) LIKE '%returned%') THEN
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
    ALTER TABLE orders ADD CONSTRAINT orders_status_check
      CHECK (status IN ('pending', 'confirmed', 'shipped', 'delivered', 'cancelled', 'returned'));
  END IF;
END $$;

-- Existing lot rows: pack size 1, so the buy value is qty × price.
UPDATE lot_items SET buy_value_bdt = qty * unit_price_bdt
WHERE buy_value_bdt = 0 AND unit_price_bdt <> 0;

-- New product / option columns get no column grant (like weight in Batch
-- 38): the shop (anon / customers) can never read them. Staff read them
-- through inventory_pack_units() and change them with inventory_set_pack().

-- ---------------------------------------------------------------------------
-- PART 1 — suppliers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suppliers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (btrim(name) <> ''),
  country     text NOT NULL DEFAULT '',
  note        text NOT NULL DEFAULT '',
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS suppliers_name_unique ON suppliers (lower(btrim(name)));

ALTER TABLE lots ADD COLUMN IF NOT EXISTS supplier_id uuid REFERENCES suppliers(id) ON DELETE SET NULL;

-- The free-text suppliers typed so far become the list (one per name,
-- whatever the capitals; the country of the latest lot).
INSERT INTO suppliers (name, country)
SELECT DISTINCT ON (lower(btrim(supplier))) btrim(supplier), country
FROM lots
WHERE btrim(supplier) <> ''
ORDER BY lower(btrim(supplier)), lot_date DESC, created_at DESC
ON CONFLICT ((lower(btrim(name)))) DO NOTHING;

UPDATE lots l SET supplier_id = s.id
FROM suppliers s
WHERE l.supplier_id IS NULL AND btrim(l.supplier) <> '' AND lower(btrim(l.supplier)) = lower(btrim(s.name));

-- ---------------------------------------------------------------------------
-- PART 2 — the sales tables
-- ---------------------------------------------------------------------------
-- Where each order line's units came from, with the cost locked when they
-- left. units_back = units given back (cancel, return, edit). adjust_bdt =
-- cost adjustments recorded for these units since (late bill, shortfall
-- filled); given back with the units.
CREATE TABLE IF NOT EXISTS order_item_lots (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq            bigint GENERATED ALWAYS AS IDENTITY,
  order_id       uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_item_id  uuid NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  lot_item_id    uuid NOT NULL REFERENCES lot_items(id) ON DELETE RESTRICT,
  units          integer NOT NULL CHECK (units > 0),
  units_back     integer NOT NULL DEFAULT 0,
  unit_cost_bdt  numeric(16,6) NOT NULL,
  adjust_bdt     numeric(16,6) NOT NULL DEFAULT 0,
  shortfall_id   uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (units_back >= 0 AND units_back <= units)
);

CREATE INDEX IF NOT EXISTS idx_order_item_lots_item ON order_item_lots (order_item_id);
CREATE INDEX IF NOT EXISTS idx_order_item_lots_order ON order_item_lots (order_id);
CREATE INDEX IF NOT EXISTS idx_order_item_lots_lot_item ON order_item_lots (lot_item_id);

-- Units sold without stock (admin only, after "sell anyway").
CREATE TABLE IF NOT EXISTS stock_shortfalls (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                   uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_item_id              uuid NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  product_id                 uuid NOT NULL,
  variant_id                 uuid,
  units                      integer NOT NULL CHECK (units > 0),
  -- The latest landed cost per unit of the product (0 if never bought).
  provisional_unit_cost_bdt  numeric(16,6) NOT NULL DEFAULT 0,
  status                     text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'filled', 'cancelled')),
  filled_lot_item_id         uuid REFERENCES lot_items(id) ON DELETE SET NULL,
  real_unit_cost_bdt         numeric(16,6),
  filled_at                  timestamptz,
  created_by                 uuid,
  created_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_shortfalls_unit ON stock_shortfalls (product_id, variant_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_stock_shortfalls_item ON stock_shortfalls (order_item_id);

-- Cost changes that belong to the day they happened, not to the order:
--   late_bill         a lot's cost per unit changed after some units were sold
--   shortfall_filled  real cost − provisional cost of units sold without stock
--   given_back        the above, undone for units that came back
CREATE TABLE IF NOT EXISTS cost_adjustments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  adj_date       date NOT NULL,
  amount_bdt     numeric(14,2) NOT NULL,
  reason         text NOT NULL CHECK (reason IN ('late_bill', 'shortfall_filled', 'given_back')),
  lot_id         uuid REFERENCES lots(id) ON DELETE SET NULL,
  lot_item_id    uuid REFERENCES lot_items(id) ON DELETE SET NULL,
  order_id       uuid REFERENCES orders(id) ON DELETE SET NULL,
  order_item_id  uuid REFERENCES order_items(id) ON DELETE SET NULL,
  note           text NOT NULL DEFAULT '',
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cost_adjustments_date ON cost_adjustments (adj_date);

-- Who can read: only "View profit & costs" (like lots). No write grant:
-- only the functions below write.
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_item_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_shortfalls ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_adjustments ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON suppliers, order_item_lots, stock_shortfalls, cost_adjustments FROM anon, authenticated;
GRANT SELECT ON suppliers, order_item_lots, stock_shortfalls, cost_adjustments TO authenticated;
GRANT ALL ON suppliers, order_item_lots, stock_shortfalls, cost_adjustments TO service_role;

DROP POLICY IF EXISTS suppliers_read ON suppliers;
CREATE POLICY suppliers_read ON suppliers
  FOR SELECT TO authenticated USING (staff_can('view_profit_costs'));
DROP POLICY IF EXISTS order_item_lots_read ON order_item_lots;
CREATE POLICY order_item_lots_read ON order_item_lots
  FOR SELECT TO authenticated USING (staff_can('view_profit_costs'));
DROP POLICY IF EXISTS stock_shortfalls_read ON stock_shortfalls;
CREATE POLICY stock_shortfalls_read ON stock_shortfalls
  FOR SELECT TO authenticated USING (staff_can('view_profit_costs'));
DROP POLICY IF EXISTS cost_adjustments_read ON cost_adjustments;
CREATE POLICY cost_adjustments_read ON cost_adjustments
  FOR SELECT TO authenticated USING (staff_can('view_profit_costs'));

-- ---------------------------------------------------------------------------
-- PART 3 — Inventory mode
-- ---------------------------------------------------------------------------
-- On when the setting is 'true'. The automated tests (Batch 39) can also
-- turn it on inside ONE database transaction that is always undone, with
-- the transaction-only flag inventory.test_mode. Only a direct database
-- connection can set that flag; the website / API cannot.
CREATE OR REPLACE FUNCTION inventory_mode_on()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT value FROM app_settings WHERE key = 'inventory_mode'), 'false') = 'true'
      OR COALESCE(current_setting('inventory.test_mode', true), '') = 'on';
$$;

GRANT EXECUTE ON FUNCTION inventory_mode_on() TO authenticated;

-- Replaces the Batch 38 guard: the switch changes only through
-- inventory_set_mode() (password re-confirmed, written to the Activity Log),
-- and On only once the opening stock (L-000) is confirmed. Saving other
-- settings with the same value is fine.
CREATE OR REPLACE FUNCTION inventory_mode_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.key <> 'inventory_mode' THEN
    RETURN NEW;
  END IF;
  IF NEW.value IS NULL OR NEW.value NOT IN ('true', 'false') THEN
    RAISE EXCEPTION 'Inventory mode must be true or false.';
  END IF;
  IF (TG_OP = 'INSERT' AND NEW.value = 'true')
     OR (TG_OP = 'UPDATE' AND NEW.value IS DISTINCT FROM OLD.value) THEN
    IF COALESCE(current_setting('inventory.mode_change', true), '') <> 'on' THEN
      RAISE EXCEPTION 'Inventory mode changes only from Settings → Inventory mode (password needed).';
    END IF;
    IF NEW.value = 'true' AND NOT EXISTS (SELECT 1 FROM lots WHERE kind = 'opening') THEN
      RAISE EXCEPTION 'Inventory mode can be turned On only after the opening stock (L-000) is confirmed.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS app_settings_inventory_mode_guard ON app_settings;
CREATE TRIGGER app_settings_inventory_mode_guard
  BEFORE INSERT OR UPDATE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION inventory_mode_guard();

-- ---------------------------------------------------------------------------
-- PART 4 — helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION inventory_dhaka_today()
RETURNS date
LANGUAGE sql
STABLE
AS $$
  SELECT (now() AT TIME ZONE 'Asia/Dhaka')::date;
$$;

CREATE OR REPLACE FUNCTION inventory_pack_size(p_product_id uuid, p_variant_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    CASE WHEN p_variant_id IS NULL THEN (SELECT pack_size FROM products WHERE id = p_product_id)
         ELSE (SELECT pack_size FROM product_variants WHERE id = p_variant_id) END,
    1);
$$;

CREATE OR REPLACE FUNCTION inventory_stock_unit(p_product_id uuid, p_variant_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    CASE WHEN p_variant_id IS NULL THEN (SELECT stock_unit FROM products WHERE id = p_product_id)
         ELSE (SELECT stock_unit FROM product_variants WHERE id = p_variant_id) END,
    'pcs');
$$;

-- Units left in lots for one product / option.
CREATE OR REPLACE FUNCTION inventory_units_left(p_product_id uuid, p_variant_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(sum(qty_remaining), 0)::bigint
  FROM lot_items
  WHERE product_id = p_product_id AND variant_id IS NOT DISTINCT FROM p_variant_id;
$$;

-- The latest landed cost per unit (the newest lot with this product), or 0.
CREATE OR REPLACE FUNCTION inventory_latest_unit_cost(p_product_id uuid, p_variant_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT li.landed_unit_cost_bdt
    FROM lot_items li JOIN lots l ON l.id = li.lot_id
    WHERE li.product_id = p_product_id AND li.variant_id IS NOT DISTINCT FROM p_variant_id
    ORDER BY l.lot_date DESC, l.created_at DESC, li.sort_order DESC
    LIMIT 1), 0);
$$;

-- Units one quantity of an order line stands for: 1 when sold in loose
-- units, else the pack size.
CREATE OR REPLACE FUNCTION inventory_item_factor(p_item order_items)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE WHEN p_item.sold_unit IS NOT NULL THEN 1
              ELSE inventory_pack_size(p_item.product_id, p_item.variant_id) END;
$$;

-- Units an order line holds now: taken from lots and not given back, plus
-- units sold without stock that are still open.
CREATE OR REPLACE FUNCTION inventory_item_held(p_item_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (COALESCE((SELECT sum(units - units_back) FROM order_item_lots WHERE order_item_id = p_item_id), 0)
        + COALESCE((SELECT sum(units) FROM stock_shortfalls WHERE order_item_id = p_item_id AND status = 'open'), 0))::integer;
$$;

-- "CeraVe Cream (AU · 50 ml)" from an order line.
CREATE OR REPLACE FUNCTION inventory_item_label(p_item order_items)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_item.product_name || COALESCE(' (' || p_item.variant_label || ')', '');
$$;

-- One line of stock news for an order, written to the Activity Log as ONE
-- entry per order action when the transaction ends (inventory_flush_log).
CREATE OR REPLACE FUNCTION inventory_log(p_order_id uuid, p_order_number text, p_line text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_all   jsonb := COALESCE(NULLIF(current_setting('inventory.pending_log', true), ''), '{}')::jsonb;
  v_entry jsonb;
BEGIN
  v_entry := COALESCE(v_all -> p_order_id::text, jsonb_build_object('number', p_order_number, 'lines', '[]'::jsonb));
  v_entry := jsonb_set(v_entry, '{lines}', (v_entry -> 'lines') || to_jsonb(p_line));
  v_all := jsonb_set(v_all, ARRAY[p_order_id::text], v_entry);
  PERFORM set_config('inventory.pending_log', v_all::text, true);
END;
$$;

CREATE OR REPLACE FUNCTION inventory_flush_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_text  text := NULLIF(current_setting('inventory.pending_log', true), '');
  v_key   text;
  v_entry jsonb;
BEGIN
  IF v_text IS NULL OR v_text = '{}' THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('inventory.pending_log', '', true);
  BEGIN
    FOR v_key, v_entry IN SELECT key, value FROM jsonb_each(v_text::jsonb) LOOP
      PERFORM write_activity('inventory.order_stock', 'order', v_key, v_entry ->> 'number',
        format('%s: %s', v_entry ->> 'number',
               (SELECT string_agg(x, '; ') FROM jsonb_array_elements_text(v_entry -> 'lines') x)),
        jsonb_build_object('lines', v_entry -> 'lines'));
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    -- The log line must never stop an order from saving.
    NULL;
  END;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS stock_movements_flush_log ON stock_movements;
CREATE CONSTRAINT TRIGGER stock_movements_flush_log
  AFTER INSERT ON stock_movements
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION inventory_flush_log();

DROP TRIGGER IF EXISTS stock_shortfalls_flush_log ON stock_shortfalls;
CREATE CONSTRAINT TRIGGER stock_shortfalls_flush_log
  AFTER INSERT OR UPDATE ON stock_shortfalls
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION inventory_flush_log();

-- ---------------------------------------------------------------------------
-- PART 5 — the shop's stock number follows the lots (only while On)
-- ---------------------------------------------------------------------------
-- Whole packs left = floor(units left ÷ pack size). A product with options
-- keeps its stock on the options, so its own row is never touched.
CREATE OR REPLACE FUNCTION inventory_sync_unit(p_product_id uuid, p_variant_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_packs     integer;
  v_prev_sync text := COALESCE(current_setting('inventory.syncing', true), '');
  v_prev_flag text := COALESCE(current_setting('app.order_stock_change', true), '');
BEGIN
  IF p_product_id IS NULL OR NOT inventory_mode_on() THEN
    RETURN;
  END IF;
  IF p_variant_id IS NULL AND EXISTS (SELECT 1 FROM product_variants WHERE product_id = p_product_id) THEN
    RETURN;
  END IF;
  v_packs := GREATEST(floor(inventory_units_left(p_product_id, p_variant_id)::numeric
                            / inventory_pack_size(p_product_id, p_variant_id))::integer, 0);
  -- Not a staff edit: no "last edited by", no Activity Log line per change.
  PERFORM set_config('inventory.syncing', 'on', true);
  PERFORM set_config('app.order_stock_change', 'on', true);
  IF p_variant_id IS NULL THEN
    UPDATE products
    SET stock_quantity = v_packs,
        stock_status = CASE
          WHEN v_packs <= 0 THEN 'out_of_stock'
          WHEN stock_status = 'out_of_stock' THEN 'in_stock'
          ELSE stock_status
        END
    WHERE id = p_product_id
      AND (stock_quantity IS DISTINCT FROM v_packs
           OR (v_packs <= 0) IS DISTINCT FROM (stock_status = 'out_of_stock'));
  ELSE
    UPDATE product_variants
    SET stock_quantity = v_packs, in_stock = (v_packs > 0)
    WHERE id = p_variant_id
      AND (stock_quantity IS DISTINCT FROM v_packs OR in_stock IS DISTINCT FROM (v_packs > 0));
  END IF;
  PERFORM set_config('inventory.syncing', v_prev_sync, true);
  PERFORM set_config('app.order_stock_change', v_prev_flag, true);
END;
$$;

CREATE OR REPLACE FUNCTION inventory_sync_all()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_unit record;
  v_n    integer := 0;
BEGIN
  FOR v_unit IN
    SELECT p.id AS product_id, NULL::uuid AS variant_id FROM products p
    WHERE NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id)
    UNION ALL
    SELECT v.product_id, v.id FROM product_variants v
  LOOP
    PERFORM inventory_sync_unit(v_unit.product_id, v_unit.variant_id);
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$$;

-- Lots changed → the shop's stock number follows.
CREATE OR REPLACE FUNCTION inventory_lot_item_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT inventory_mode_on() THEN
    RETURN NULL;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    PERFORM inventory_sync_unit(OLD.product_id, OLD.variant_id);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM inventory_sync_unit(NEW.product_id, NEW.variant_id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS lot_items_shop_stock ON lot_items;
CREATE TRIGGER lot_items_shop_stock
  AFTER INSERT OR DELETE OR UPDATE OF qty_remaining, product_id, variant_id ON lot_items
  FOR EACH ROW EXECUTE FUNCTION inventory_lot_item_sync();

-- While On, nothing else can change the shop's stock number: any other
-- change (the old +/- in order functions, a typed number) is replaced by
-- the lots' number. While Off this returns straight away.
CREATE OR REPLACE FUNCTION inventory_force_product_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_packs integer;
BEGIN
  IF COALESCE(current_setting('inventory.syncing', true), '') = 'on' OR NOT inventory_mode_on() THEN
    RETURN NEW;
  END IF;
  IF NEW.stock_quantity IS NOT DISTINCT FROM OLD.stock_quantity
     AND NEW.stock_status IS NOT DISTINCT FROM OLD.stock_status THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM product_variants WHERE product_id = NEW.id) THEN
    RETURN NEW;
  END IF;
  v_packs := GREATEST(floor(inventory_units_left(NEW.id, NULL)::numeric / GREATEST(NEW.pack_size, 1))::integer, 0);
  NEW.stock_quantity := v_packs;
  NEW.stock_status := CASE
    WHEN v_packs <= 0 THEN 'out_of_stock'
    WHEN NEW.stock_status = 'out_of_stock' THEN 'in_stock'
    ELSE NEW.stock_status
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS products_inventory_stock ON products;
CREATE TRIGGER products_inventory_stock
  BEFORE UPDATE OF stock_quantity, stock_status ON products
  FOR EACH ROW EXECUTE FUNCTION inventory_force_product_stock();

CREATE OR REPLACE FUNCTION inventory_force_variant_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_packs integer;
BEGIN
  IF COALESCE(current_setting('inventory.syncing', true), '') = 'on' OR NOT inventory_mode_on() THEN
    RETURN NEW;
  END IF;
  IF NEW.stock_quantity IS NOT DISTINCT FROM OLD.stock_quantity AND NEW.in_stock IS NOT DISTINCT FROM OLD.in_stock THEN
    RETURN NEW;
  END IF;
  v_packs := GREATEST(floor(inventory_units_left(NEW.product_id, NEW.id)::numeric / GREATEST(NEW.pack_size, 1))::integer, 0);
  NEW.stock_quantity := v_packs;
  NEW.in_stock := v_packs > 0;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS product_variants_inventory_stock ON product_variants;
CREATE TRIGGER product_variants_inventory_stock
  BEFORE UPDATE OF stock_quantity, in_stock ON product_variants
  FOR EACH ROW EXECUTE FUNCTION inventory_force_variant_stock();

-- ---------------------------------------------------------------------------
-- PART 6 — taking units and giving them back
-- ---------------------------------------------------------------------------
-- Takes p_units for an order line from the lot rows of its product /
-- option: earliest expiry first (no expiry last), then the oldest lot, then
-- the lowest lot code. FOR UPDATE: two orders at the same moment wait for
-- each other, so they can never take the same units. Not enough units:
--   inventory.short_ok = 'on'   (admin said "sell anyway") → the rest is
--                               recorded in stock_shortfalls;
--   inventory.short_warn = 'on' (admin screens) → STOCK_WARNING:<json>,
--                               which the screen turns into "Not in stock
--                               — sell anyway?";
--   otherwise (the website)     → "Only N of "X" left in stock."
CREATE OR REPLACE FUNCTION inventory_take_units(p_item order_items, p_units integer, p_order_number text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_need  integer := p_units;
  v_row   record;
  v_take  integer;
  v_unit  text;
  v_parts text[] := '{}';
  v_have  integer;
BEGIN
  IF p_units IS NULL OR p_units <= 0 OR p_item.product_id IS NULL THEN
    RETURN;
  END IF;
  v_unit := inventory_stock_unit(p_item.product_id, p_item.variant_id);

  FOR v_row IN
    SELECT li.id, li.qty_remaining, li.landed_unit_cost_bdt, l.code
    FROM lot_items li
    JOIN lots l ON l.id = li.lot_id
    WHERE li.product_id = p_item.product_id
      AND li.variant_id IS NOT DISTINCT FROM p_item.variant_id
      AND li.qty_remaining > 0
    ORDER BY li.expiry_date ASC NULLS LAST, l.lot_date ASC,
             (l.kind = 'opening') DESC, length(l.code), l.code, li.sort_order
    FOR UPDATE OF li
  LOOP
    EXIT WHEN v_need <= 0;
    v_take := LEAST(v_need, v_row.qty_remaining);
    CONTINUE WHEN v_take <= 0;
    INSERT INTO stock_movements (lot_item_id, movement_type, qty, reference, reason, created_by)
    VALUES (v_row.id, 'sale', -v_take, p_order_number, NULL, auth.uid());
    INSERT INTO order_item_lots (order_id, order_item_id, lot_item_id, units, unit_cost_bdt)
    VALUES (p_item.order_id, p_item.id, v_row.id, v_take, v_row.landed_unit_cost_bdt);
    v_parts := v_parts || format('%s %s', v_take, v_row.code);
    v_need := v_need - v_take;
  END LOOP;

  IF v_need > 0 THEN
    v_have := p_units - v_need;
    IF COALESCE(current_setting('inventory.short_ok', true), '') = 'on' THEN
      INSERT INTO stock_shortfalls (order_id, order_item_id, product_id, variant_id, units,
                                    provisional_unit_cost_bdt, created_by)
      VALUES (p_item.order_id, p_item.id, p_item.product_id, p_item.variant_id, v_need,
              inventory_latest_unit_cost(p_item.product_id, p_item.variant_id), auth.uid());
      v_parts := v_parts || format('%s not in stock (sold anyway)', v_need);
    ELSIF COALESCE(current_setting('inventory.short_warn', true), '') = 'on' THEN
      RAISE EXCEPTION 'STOCK_WARNING:%', jsonb_build_array(jsonb_build_object(
        'product_name', p_item.product_name,
        'variant_label', p_item.variant_label,
        'available', v_have,
        'requested', p_units,
        'unit', v_unit))::text;
    ELSE
      RAISE EXCEPTION 'Only % of "%" left in stock.',
        floor(inventory_units_left(p_item.product_id, p_item.variant_id)::numeric
              / inventory_pack_size(p_item.product_id, p_item.variant_id))::integer,
        p_item.product_name;
    END IF;
  END IF;

  PERFORM inventory_log(p_item.order_id, p_order_number,
    format('%s: %s %s taken (%s)', inventory_item_label(p_item), p_units, v_unit, array_to_string(v_parts, ', ')));
END;
$$;

-- Gives units of an order line back: open shortfalls first (they are
-- always the newest part), then the units taken most recently, each to the
-- exact lot row it came from. p_units NULL = everything the line holds.
-- Cost adjustments recorded for those units are undone in proportion.
CREATE OR REPLACE FUNCTION inventory_give_back(p_item_id uuid, p_units integer, p_type text, p_reason text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item  order_items%ROWTYPE;
  v_ref   text;
  v_left  integer := COALESCE(p_units, 2147483647);
  v_sf    stock_shortfalls%ROWTYPE;
  v_oil   order_item_lots%ROWTYPE;
  v_n     integer;
  v_net   integer;
  v_rev   numeric;
  v_back  integer := 0;
  v_open  integer := 0;
  v_code  text;
  v_lot   uuid;
  v_parts text[] := '{}';
BEGIN
  SELECT * INTO v_item FROM order_items WHERE id = p_item_id;
  IF NOT FOUND OR v_left <= 0 THEN
    RETURN 0;
  END IF;
  SELECT order_number INTO v_ref FROM orders WHERE id = v_item.order_id;

  FOR v_sf IN
    SELECT * FROM stock_shortfalls
    WHERE order_item_id = p_item_id AND status = 'open'
    ORDER BY created_at DESC, id DESC
    FOR UPDATE
  LOOP
    EXIT WHEN v_left <= 0;
    v_n := LEAST(v_left, v_sf.units);
    IF v_n = v_sf.units THEN
      UPDATE stock_shortfalls SET status = 'cancelled' WHERE id = v_sf.id;
    ELSE
      UPDATE stock_shortfalls SET units = units - v_n WHERE id = v_sf.id;
    END IF;
    v_open := v_open + v_n;
    v_left := v_left - v_n;
  END LOOP;

  FOR v_oil IN
    SELECT * FROM order_item_lots
    WHERE order_item_id = p_item_id AND units > units_back
    ORDER BY seq DESC
    FOR UPDATE
  LOOP
    EXIT WHEN v_left <= 0;
    v_net := v_oil.units - v_oil.units_back;
    v_n := LEAST(v_left, v_net);
    INSERT INTO stock_movements (lot_item_id, movement_type, qty, reference, reason, created_by)
    VALUES (v_oil.lot_item_id, p_type, v_n, v_ref, p_reason, auth.uid());
    v_rev := CASE WHEN v_oil.adjust_bdt <> 0 THEN v_oil.adjust_bdt * v_n / v_net ELSE 0 END;
    UPDATE order_item_lots
    SET units_back = units_back + v_n, adjust_bdt = adjust_bdt - v_rev
    WHERE id = v_oil.id;
    SELECT l.code, l.id INTO v_code, v_lot FROM lot_items li JOIN lots l ON l.id = li.lot_id WHERE li.id = v_oil.lot_item_id;
    IF round(v_rev, 2) <> 0 THEN
      INSERT INTO cost_adjustments (adj_date, amount_bdt, reason, lot_id, lot_item_id, order_id, order_item_id, note, created_by)
      VALUES (inventory_dhaka_today(), -round(v_rev, 2), 'given_back', v_lot, v_oil.lot_item_id,
              v_item.order_id, v_item.id,
              format('%s: %s units back to %s (%s)', COALESCE(v_ref, 'order'), v_n, v_code, p_reason), auth.uid());
    END IF;
    v_parts := v_parts || format('%s %s', v_n, v_code);
    v_back := v_back + v_n;
    v_left := v_left - v_n;
  END LOOP;

  IF v_back > 0 OR v_open > 0 THEN
    PERFORM inventory_log(v_item.order_id, COALESCE(v_ref, 'order'),
      format('%s: %s%s%s', inventory_item_label(v_item),
             CASE WHEN v_back > 0 THEN format('%s back to lots (%s)', v_back, array_to_string(v_parts, ', ')) ELSE '' END,
             CASE WHEN v_back > 0 AND v_open > 0 THEN ', ' ELSE '' END,
             CASE WHEN v_open > 0 THEN format('%s not-in-stock units cancelled', v_open) ELSE '' END));
  END IF;
  RETURN v_back;
END;
$$;

-- A lot (or the opening stock) just added units: open "sold without stock"
-- units of its products are filled first, oldest first, from that lot's
-- rows. Each fill writes the sale movement from the new lot, locks the
-- order line's cost at the PROVISIONAL cost (what the order already
-- counted) and records the difference (real − provisional) × units in
-- cost_adjustments, dated today.
CREATE OR REPLACE FUNCTION inventory_fill_shortfalls(p_lot_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sf      record;
  v_row     record;
  v_need    integer;
  v_n       integer;
  v_done    integer;
  v_cost    numeric;
  v_first   uuid;
  v_filled  integer := 0;
  v_diff    numeric;
  v_code    text;
  v_item    order_items%ROWTYPE;
BEGIN
  SELECT code INTO v_code FROM lots WHERE id = p_lot_id;
  FOR v_sf IN
    SELECT s.*, o.order_number
    FROM stock_shortfalls s
    JOIN orders o ON o.id = s.order_id
    WHERE s.status = 'open'
      AND EXISTS (SELECT 1 FROM lot_items li
                  WHERE li.lot_id = p_lot_id AND li.product_id = s.product_id
                    AND li.variant_id IS NOT DISTINCT FROM s.variant_id AND li.qty_remaining > 0)
    ORDER BY s.created_at, s.id
    FOR UPDATE OF s
  LOOP
    v_need := v_sf.units;
    v_cost := 0;
    v_first := NULL;
    SELECT * INTO v_item FROM order_items WHERE id = v_sf.order_item_id;
    FOR v_row IN
      SELECT li.id, li.qty_remaining, li.landed_unit_cost_bdt
      FROM lot_items li
      WHERE li.lot_id = p_lot_id AND li.product_id = v_sf.product_id
        AND li.variant_id IS NOT DISTINCT FROM v_sf.variant_id AND li.qty_remaining > 0
      ORDER BY li.expiry_date ASC NULLS LAST, li.sort_order
      FOR UPDATE
    LOOP
      EXIT WHEN v_need <= 0;
      v_n := LEAST(v_need, v_row.qty_remaining);
      v_diff := (v_row.landed_unit_cost_bdt - v_sf.provisional_unit_cost_bdt) * v_n;
      INSERT INTO stock_movements (lot_item_id, movement_type, qty, reference, reason, created_by)
      VALUES (v_row.id, 'sale', -v_n, v_sf.order_number, 'Sold without stock — filled', auth.uid());
      INSERT INTO order_item_lots (order_id, order_item_id, lot_item_id, units, unit_cost_bdt, adjust_bdt, shortfall_id)
      VALUES (v_sf.order_id, v_sf.order_item_id, v_row.id, v_n, v_sf.provisional_unit_cost_bdt, v_diff, v_sf.id);
      IF round(v_diff, 2) <> 0 THEN
        INSERT INTO cost_adjustments (adj_date, amount_bdt, reason, lot_id, lot_item_id, order_id, order_item_id, note, created_by)
        VALUES (inventory_dhaka_today(), round(v_diff, 2), 'shortfall_filled', p_lot_id, v_row.id,
                v_sf.order_id, v_sf.order_item_id,
                format('%s: %s units sold without stock, filled from %s (real ৳%s vs provisional ৳%s per unit)',
                       v_sf.order_number, v_n, v_code, round(v_row.landed_unit_cost_bdt, 2),
                       round(v_sf.provisional_unit_cost_bdt, 2)),
                auth.uid());
      END IF;
      v_cost := v_cost + v_row.landed_unit_cost_bdt * v_n;
      v_first := COALESCE(v_first, v_row.id);
      v_need := v_need - v_n;
    END LOOP;

    v_done := v_sf.units - v_need;
    EXIT WHEN v_done = 0;
    IF v_need > 0 THEN
      -- Partly filled: this row becomes the filled part, a new open row
      -- keeps the rest (same date, so it stays first in line).
      INSERT INTO stock_shortfalls (order_id, order_item_id, product_id, variant_id, units,
                                    provisional_unit_cost_bdt, status, created_by, created_at)
      VALUES (v_sf.order_id, v_sf.order_item_id, v_sf.product_id, v_sf.variant_id, v_need,
              v_sf.provisional_unit_cost_bdt, 'open', v_sf.created_by, v_sf.created_at);
    END IF;
    UPDATE stock_shortfalls
    SET units = v_done, status = 'filled', filled_at = now(), filled_lot_item_id = v_first,
        real_unit_cost_bdt = round(v_cost / v_done, 6)
    WHERE id = v_sf.id;
    v_filled := v_filled + v_done;
    PERFORM inventory_log(v_sf.order_id, v_sf.order_number,
      format('%s: %s not-in-stock units filled from %s', inventory_item_label(v_item), v_done, v_code));
    EXIT WHEN v_need > 0;
  END LOOP;
  RETURN v_filled;
END;
$$;

-- ---------------------------------------------------------------------------
-- PART 7 — the triggers that make every order path use the lots
-- ---------------------------------------------------------------------------
-- order_items:
--   INSERT            a line of an order that holds stock takes its units
--                     (only while On);
--   UPDATE quantity   more → takes the extra (only while On);
--                     less → gives back the most recently taken units;
--   DELETE            gives back everything the line holds (removed from
--                     an order, or the order deleted).
-- Giving back always runs (whatever the mode) for units that came from
-- lots: they go back to the rows they came from.
CREATE OR REPLACE FUNCTION inventory_order_item_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order  orders%ROWTYPE;
  v_holds  boolean;
  v_held   integer;
  v_factor integer;
  v_delta  integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF inventory_item_held(OLD.id) > 0 THEN
      PERFORM inventory_give_back(OLD.id, NULL, 'cancel', 'Removed from the order');
    END IF;
    RETURN OLD;
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = NEW.order_id;
  v_holds := FOUND AND NOT v_order.stock_released AND v_order.status NOT IN ('cancelled', 'returned');

  IF TG_OP = 'INSERT' THEN
    IF v_holds AND inventory_mode_on() THEN
      PERFORM inventory_take_units(NEW, NEW.quantity * inventory_item_factor(NEW), v_order.order_number);
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.quantity = OLD.quantity THEN
    RETURN NEW;
  END IF;
  v_held := inventory_item_held(NEW.id);
  v_factor := CASE
    WHEN NEW.sold_unit IS NOT NULL THEN 1
    WHEN v_held > 0 AND OLD.quantity > 0 AND v_held % OLD.quantity = 0 THEN v_held / OLD.quantity
    ELSE inventory_pack_size(NEW.product_id, NEW.variant_id)
  END;
  v_delta := (NEW.quantity - OLD.quantity) * v_factor;
  IF v_delta < 0 AND v_held > 0 THEN
    PERFORM inventory_give_back(NEW.id, LEAST(-v_delta, v_held), 'cancel',
      format('Quantity %s → %s', OLD.quantity, NEW.quantity));
  ELSIF v_delta > 0 AND v_holds AND inventory_mode_on() THEN
    PERFORM inventory_take_units(NEW, v_delta, v_order.order_number);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS order_items_inventory_take ON order_items;
CREATE TRIGGER order_items_inventory_take
  AFTER INSERT OR UPDATE OF quantity ON order_items
  FOR EACH ROW EXECUTE FUNCTION inventory_order_item_changed();

DROP TRIGGER IF EXISTS order_items_inventory_give_back ON order_items;
CREATE TRIGGER order_items_inventory_give_back
  BEFORE DELETE ON order_items
  FOR EACH ROW EXECUTE FUNCTION inventory_order_item_changed();

-- orders.stock_released:
--   false → true  (cancelled or returned) every line gives its units back,
--                  as 'return' when the order is Returned, else 'cancel';
--   true → false  (reopened) every line takes its units again (only while
--                  On); a line that is short stops the reopen.
CREATE OR REPLACE FUNCTION inventory_order_released()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item order_items%ROWTYPE;
BEGIN
  IF NEW.stock_released AND NOT OLD.stock_released THEN
    FOR v_item IN SELECT * FROM order_items WHERE order_id = NEW.id ORDER BY id LOOP
      PERFORM inventory_give_back(v_item.id, NULL,
        CASE WHEN NEW.status = 'returned' THEN 'return' ELSE 'cancel' END,
        CASE WHEN NEW.status = 'returned' THEN 'Order returned' ELSE 'Order cancelled' END);
    END LOOP;
  ELSIF OLD.stock_released AND NOT NEW.stock_released AND inventory_mode_on() THEN
    FOR v_item IN SELECT * FROM order_items WHERE order_id = NEW.id ORDER BY id LOOP
      PERFORM inventory_take_units(v_item, v_item.quantity * inventory_item_factor(v_item), NEW.order_number);
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS orders_inventory_released ON orders;
CREATE TRIGGER orders_inventory_released
  AFTER UPDATE OF stock_released ON orders
  FOR EACH ROW EXECUTE FUNCTION inventory_order_released();

REVOKE ALL ON FUNCTION inventory_dhaka_today() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION inventory_pack_size(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION inventory_stock_unit(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION inventory_units_left(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION inventory_latest_unit_cost(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION inventory_item_factor(order_items) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION inventory_item_held(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION inventory_item_label(order_items) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION inventory_log(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION inventory_flush_log() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION inventory_sync_unit(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION inventory_sync_all() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION inventory_lot_item_sync() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION inventory_force_product_stock() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION inventory_force_variant_stock() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION inventory_take_units(order_items, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION inventory_give_back(uuid, integer, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION inventory_fill_shortfalls(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION inventory_order_item_changed() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION inventory_order_released() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION inventory_mode_guard() FROM PUBLIC, anon, authenticated;

-- ===========================================================================
-- PART 7b — existing order / stock functions (same behaviour while Off)
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- order_edit_stock — skipped while Inventory mode is On
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.order_edit_stock(p_product_id uuid, p_variant_id uuid, p_change integer, p_label text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_stock integer;
BEGIN
  IF p_change IS NULL OR p_change = 0 THEN
    RETURN;
  END IF;
  -- Batch 39: while Inventory mode is On, the order_items triggers take
  -- and give back units in lots, and the shop's number follows the lots.
  IF inventory_mode_on() THEN
    RETURN;
  END IF;
  IF p_variant_id IS NOT NULL THEN
    SELECT stock_quantity INTO v_stock FROM product_variants WHERE id = p_variant_id FOR UPDATE;
    IF NOT FOUND OR v_stock IS NULL THEN
      RETURN;
    END IF;
    IF v_stock + p_change < 0 THEN
      RAISE EXCEPTION 'Only % in stock for %.', GREATEST(v_stock, 0), p_label;
    END IF;
    UPDATE product_variants SET stock_quantity = stock_quantity + p_change WHERE id = p_variant_id;
  ELSIF p_product_id IS NOT NULL THEN
    SELECT stock_quantity INTO v_stock FROM products WHERE id = p_product_id FOR UPDATE;
    IF NOT FOUND OR v_stock IS NULL THEN
      RETURN;
    END IF;
    IF v_stock + p_change < 0 THEN
      RAISE EXCEPTION 'Only % in stock for %.', GREATEST(v_stock, 0), p_label;
    END IF;
    UPDATE products SET stock_quantity = stock_quantity + p_change WHERE id = p_product_id;
  END IF;
END;
$function$;

-- ---------------------------------------------------------------------------
-- cancel_order — loose-unit lines skipped (lots: orders_inventory_released trigger)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.cancel_order(p_order_id uuid, p_note text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid      uuid := auth.uid();
  v_order    orders%ROWTYPE;
  v_line     record;
  v_is_staff boolean := staff_can('change_order_status');
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'You must be signed in.';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;

  IF (v_order.customer_id IS NULL OR v_order.customer_id <> v_uid) AND NOT v_is_staff THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;

  IF v_is_staff THEN
    IF v_order.status NOT IN ('pending', 'confirmed') THEN
      RAISE EXCEPTION 'Only a pending or confirmed order can be cancelled.';
    END IF;
  ELSE
    IF v_order.status <> 'pending' THEN
      RAISE EXCEPTION 'This order can no longer be cancelled — please contact us.';
    END IF;
  END IF;

  IF NOT v_order.stock_released THEN
    PERFORM set_config('app.order_stock_change', 'on', true);
    -- Batch 39: lines sold in loose units never changed the stock number.
    FOR v_line IN SELECT * FROM order_items WHERE order_id = p_order_id AND sold_unit IS NULL
    LOOP
      IF v_line.variant_id IS NOT NULL THEN
        UPDATE product_variants SET stock_quantity = stock_quantity + v_line.quantity
          WHERE id = v_line.variant_id AND stock_quantity IS NOT NULL;
      ELSIF v_line.product_id IS NOT NULL THEN
        UPDATE products SET stock_quantity = stock_quantity + v_line.quantity
          WHERE id = v_line.product_id AND stock_quantity IS NOT NULL;
      END IF;
    END LOOP;
    PERFORM set_config('app.order_stock_change', 'off', true);
  END IF;

  UPDATE orders SET status = 'cancelled', stock_released = true, updated_at = now() WHERE id = p_order_id;
  INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, note)
  VALUES (p_order_id, v_order.status, 'cancelled', v_uid, p_note);

  RETURN true;
END;
$function$;

-- ---------------------------------------------------------------------------
-- admin_delete_orders — loose-unit lines skipped (lots: order_items delete trigger)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_delete_orders(p_order_ids uuid[])
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

    IF NOT v_early AND NOT v_lock_open THEN
      order_id := v_id; order_number := v_order.order_number; deleted := false;
      reason := CASE WHEN v_is_admin
        THEN 'Locked: turn on "Allow deleting orders at any stage" in Safety Locks.'
        ELSE 'Only orders not booked on Steadfast and not sent (Pending, Confirmed or Cancelled) can be deleted.' END;
      RETURN NEXT;
      CONTINUE;
    END IF;

    IF NOT v_order.stock_released AND v_order.status <> 'cancelled' THEN
      PERFORM set_config('app.order_stock_change', 'on', true);
      -- Batch 39: lines sold in loose units never changed the stock number.
      FOR v_line IN SELECT * FROM order_items oi WHERE oi.order_id = v_id AND oi.sold_unit IS NULL
      LOOP
        IF v_line.variant_id IS NOT NULL THEN
          UPDATE product_variants SET stock_quantity = stock_quantity + v_line.quantity
            WHERE id = v_line.variant_id AND stock_quantity IS NOT NULL;
        ELSIF v_line.product_id IS NOT NULL THEN
          UPDATE products SET stock_quantity = stock_quantity + v_line.quantity
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

-- ---------------------------------------------------------------------------
-- admin_reopen_order — loose-unit lines skipped (lots: orders_inventory_released trigger)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_reopen_order(p_order_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order  orders%ROWTYPE;
  v_line   record;
  v_back   text;
BEGIN
  IF NOT staff_can('change_order_status') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;
  IF v_order.status <> 'cancelled' THEN
    RAISE EXCEPTION 'Only a cancelled order can be reopened.';
  END IF;

  -- The status it had just before the latest cancel.
  SELECT h.old_status INTO v_back
  FROM order_status_history h
  WHERE h.order_id = p_order_id AND h.new_status = 'cancelled'
  ORDER BY h.changed_at DESC
  LIMIT 1;
  IF v_back IS NULL OR v_back NOT IN ('pending', 'confirmed', 'shipped', 'delivered') THEN
    v_back := 'pending';
  END IF;

  -- Take the stock again, exactly like a new order does; any line that is
  -- short stops the whole reopen (nothing is changed).
  IF v_order.stock_released THEN
    PERFORM set_config('app.order_stock_change', 'on', true);
    -- Batch 39: lines sold in loose units never changed the stock number.
    FOR v_line IN SELECT * FROM order_items oi WHERE oi.order_id = p_order_id AND oi.sold_unit IS NULL
    LOOP
      PERFORM order_edit_stock(
        v_line.product_id, v_line.variant_id, -v_line.quantity,
        v_line.product_name || COALESCE(' (' || v_line.variant_label || ')', '')
      );
    END LOOP;
    PERFORM set_config('app.order_stock_change', 'off', true);
  END IF;

  UPDATE orders SET status = v_back, stock_released = false, updated_at = now() WHERE id = p_order_id;
  INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, note)
  VALUES (p_order_id, 'cancelled', v_back, auth.uid(), 'Reopened (stock taken again)');

  RETURN v_back;
END;
$function$;

-- ---------------------------------------------------------------------------
-- admin_restock — refused while Inventory mode is On
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_restock(p_product_id uuid, p_variant_id uuid, p_mode text, p_amount integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_name   text;
  v_option text;
  v_before integer;
  v_after  integer;
BEGIN
  IF NOT staff_can('edit_products') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF inventory_mode_on() THEN
    RAISE EXCEPTION 'Inventory mode is On: stock comes from lots. Add a lot instead (Inventory → New lot).';
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('add', 'set') THEN
    RAISE EXCEPTION 'Choose Add or Set to.';
  END IF;
  IF p_amount IS NULL OR p_amount < 0 OR p_amount > 100000 OR (p_mode = 'add' AND p_amount = 0) THEN
    RAISE EXCEPTION 'Enter a whole number of 0 or more.';
  END IF;

  SELECT name INTO v_name FROM products WHERE id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product not found.';
  END IF;

  PERFORM set_config('app.activity_quiet', 'on', true);
  IF p_variant_id IS NULL THEN
    SELECT stock_quantity INTO v_before FROM products WHERE id = p_product_id;
    v_after := CASE WHEN p_mode = 'add' THEN COALESCE(v_before, 0) + p_amount ELSE p_amount END;
    UPDATE products
    SET stock_quantity = v_after,
        stock_status = CASE
          WHEN v_after <= 0 THEN 'out_of_stock'
          WHEN stock_status = 'out_of_stock' THEN 'in_stock'
          ELSE stock_status
        END
    WHERE id = p_product_id;
  ELSE
    SELECT stock_quantity, concat_ws(' · ', region, size) INTO v_before, v_option
    FROM product_variants WHERE id = p_variant_id AND product_id = p_product_id FOR UPDATE;
    IF NOT FOUND THEN
      PERFORM set_config('app.activity_quiet', 'off', true);
      RAISE EXCEPTION 'Option not found.';
    END IF;
    v_after := CASE WHEN p_mode = 'add' THEN COALESCE(v_before, 0) + p_amount ELSE p_amount END;
    UPDATE product_variants SET stock_quantity = v_after, in_stock = (v_after > 0) WHERE id = p_variant_id;
  END IF;
  PERFORM set_config('app.activity_quiet', 'off', true);

  -- "Last updated by" (the stamp trigger fills in who and when).
  UPDATE products SET last_edited_at = now() WHERE id = p_product_id;

  PERFORM write_activity('product.restock', 'product', p_product_id::text, v_name,
    format('Restock%s: %s → %s',
           CASE WHEN v_option IS NOT NULL AND v_option <> '' THEN ' (' || v_option || ')' ELSE '' END,
           COALESCE(v_before::text, 'not counted'), v_after),
    jsonb_build_object(
      'stock_quantity', jsonb_build_object('from', v_before, 'to', v_after),
      'mode', p_mode, 'amount', p_amount,
      'option', COALESCE(v_option, '')));

  RETURN jsonb_build_object('before', v_before, 'after', v_after);
END;
$function$;

-- ---------------------------------------------------------------------------
-- system_update_steadfast_status — never turns a Returned order into Delivered
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.system_update_steadfast_status(p_order_id uuid, p_courier_status text, p_mark_delivered boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_status text;
BEGIN
  SELECT status INTO v_old_status FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;

  UPDATE orders SET steadfast_status = p_courier_status, updated_at = now()
  WHERE id = p_order_id;

  IF p_mark_delivered AND v_old_status NOT IN ('delivered', 'cancelled', 'returned') THEN
    UPDATE orders SET status = 'delivered', updated_at = now() WHERE id = p_order_id;
    INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, note)
    VALUES (p_order_id, v_old_status, 'delivered', NULL, 'Steadfast (auto): ডেলিভারি সম্পন্ন হয়েছে');
  END IF;

  RETURN true;
END;
$function$;

-- ---------------------------------------------------------------------------
-- admin_update_steadfast_status — never turns a Returned order into Delivered
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_update_steadfast_status(p_order_id uuid, p_courier_status text, p_mark_delivered boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_status text;
BEGIN
  IF NOT (staff_can('book_steadfast') OR staff_can('change_order_status')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  SELECT status INTO v_old_status FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;

  UPDATE orders SET steadfast_status = p_courier_status, updated_at = now()
  WHERE id = p_order_id;

  IF p_mark_delivered AND v_old_status NOT IN ('delivered', 'cancelled', 'returned') THEN
    UPDATE orders SET status = 'delivered', updated_at = now() WHERE id = p_order_id;
    INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, note)
    VALUES (p_order_id, v_old_status, 'delivered', auth.uid(), 'Steadfast: delivered');
  END IF;

  RETURN true;
END;
$function$;

-- ---------------------------------------------------------------------------
-- admin_set_order_status — a Returned order keeps its status
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_set_order_status(p_order_id uuid, p_new_status text, p_note text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old_status text;
BEGIN
  IF NOT staff_can('change_order_status') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_new_status NOT IN ('pending', 'confirmed', 'shipped', 'delivered', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid status.';
  END IF;

  SELECT status INTO v_old_status FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;
  IF v_old_status = 'returned' THEN
    RAISE EXCEPTION 'A returned order can''t change status.';
  END IF;

  IF p_new_status = 'cancelled' AND v_old_status <> 'cancelled' THEN
    PERFORM cancel_order(p_order_id, p_note);
    RETURN true;
  END IF;

  UPDATE orders SET status = p_new_status, updated_at = now() WHERE id = p_order_id;
  INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, note)
  VALUES (p_order_id, v_old_status, p_new_status, auth.uid(), p_note);

  RETURN true;
END;
$function$;

-- ---------------------------------------------------------------------------
-- admin_create_order — loose units; while On: stock check in units, "sell anyway" = shortfalls
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_create_order(p_source text, p_items jsonb, p_full_name text, p_phone text, p_division text, p_district text, p_thana text, p_address_line text, p_delivery_zone text, p_delivery_fee numeric, p_order_discount numeric DEFAULT 0, p_discount_reason text DEFAULT NULL::text, p_discount_note text DEFAULT NULL::text, p_payment_method text DEFAULT 'cod'::text, p_bkash_trx_id text DEFAULT NULL::text, p_bkash_sender text DEFAULT NULL::text, p_linked_customer_id uuid DEFAULT NULL::uuid, p_mark_delivered boolean DEFAULT false, p_admin_note text DEFAULT NULL::text, p_allow_negative_stock boolean DEFAULT false)
 RETURNS TABLE(order_id uuid, order_number text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_item             jsonb;
  v_product_id       uuid;
  v_variant_id       uuid;
  v_quantity         integer;
  v_sold_price_in    numeric(10,2);
  v_list_price       numeric(10,2);
  v_unit_price       numeric(10,2);
  v_product_name     text;
  v_variant_label    text;
  v_image_url        text;
  v_is_active        boolean;
  v_stock_quantity   integer;
  v_region           text;
  v_size             text;
  v_reason           text;
  v_reason_note      text;
  v_subtotal         numeric(10,2) := 0;
  v_list_value       numeric(10,2) := 0;
  v_free_value       numeric(10,2) := 0;
  v_delivery_fee     numeric(10,2);
  v_discount         numeric(10,2);
  v_total            numeric(10,2);
  v_order_id         uuid;
  v_order_number     text;
  v_item_count       integer := 0;
  v_warnings         jsonb := '[]'::jsonb;
  v_payment_status   text;
  v_initial_status   text;
  v_is_admin         boolean := is_admin();
  v_sold_unit        text;
  v_pack             integer;
  v_mode_on          boolean := inventory_mode_on();
BEGIN
  IF NOT staff_can('create_orders') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  IF p_source NOT IN ('web', 'facebook', 'whatsapp', 'phone', 'shop', 'family', 'other') THEN
    RAISE EXCEPTION 'Invalid order source.';
  END IF;
  IF p_delivery_zone NOT IN ('inside_dhaka', 'outside_dhaka', 'hand_delivered') THEN
    RAISE EXCEPTION 'Invalid delivery zone.';
  END IF;
  IF p_payment_method NOT IN ('cod', 'bkash', 'cash', 'due') THEN
    RAISE EXCEPTION 'Invalid payment method.';
  END IF;
  IF p_full_name IS NULL OR trim(p_full_name) = '' THEN
    RAISE EXCEPTION 'Customer name is required.';
  END IF;
  IF p_address_line IS NULL OR trim(p_address_line) = '' THEN
    RAISE EXCEPTION 'Delivery address is required.';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Add at least one item.';
  END IF;
  IF NOT v_is_admin AND COALESCE(p_order_discount, 0) <> 0 THEN
    RAISE EXCEPTION 'Only the Super Admin can give a discount.';
  END IF;

  v_delivery_fee := CASE WHEN p_delivery_zone = 'hand_delivered' THEN 0
                          ELSE GREATEST(COALESCE(p_delivery_fee, 0), 0) END;
  v_discount := GREATEST(COALESCE(p_order_discount, 0), 0);

  CREATE TEMP TABLE IF NOT EXISTS _admin_order_lines (
    product_id        uuid,
    variant_id        uuid,
    product_name      text,
    variant_label     text,
    image_url         text,
    list_price        numeric(10,2),
    unit_price        numeric(10,2),
    quantity          integer,
    line_total        numeric(10,2),
    reason            text,
    reason_note       text,
    is_tracked_stock  boolean,
    stock_available   integer,
    sold_unit         text,
    units             integer
  ) ON COMMIT DROP;
  TRUNCATE _admin_order_lines;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_item_count := v_item_count + 1;
    v_product_id := (v_item->>'product_id')::uuid;
    v_variant_id := NULLIF(v_item->>'variant_id', '')::uuid;
    v_quantity   := (v_item->>'quantity')::integer;
    v_sold_price_in := NULLIF(v_item->>'sold_price', '')::numeric;
    v_reason      := NULLIF(trim(COALESCE(v_item->>'reason', '')), '');
    v_reason_note := NULLIF(trim(COALESCE(v_item->>'reason_note', '')), '');
    -- Batch 39: 'pcs' / 'ml' / 'g' = sold in loose units, quantity = units.
    v_sold_unit   := NULLIF(trim(COALESCE(v_item->>'sold_unit', '')), '');

    IF v_reason IS NOT NULL AND v_reason NOT IN
      ('family', 'gift', 'free_sample', 'personal_use', 'promotion', 'other') THEN
      v_reason := 'other';
    END IF;

    IF v_product_id IS NULL OR v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Invalid item at position %.', v_item_count;
    END IF;

    IF v_variant_id IS NOT NULL THEN
      SELECT
        CASE WHEN pv.offer_price IS NOT NULL AND pv.offer_price < pv.retail_price
             THEN pv.offer_price ELSE pv.retail_price END,
        pv.stock_quantity, pv.region, pv.size,
        COALESCE(pv.image_url, p.image_url), p.name, p.is_active
      INTO v_list_price, v_stock_quantity, v_region, v_size,
           v_image_url, v_product_name, v_is_active
      FROM product_variants pv
      JOIN products p ON p.id = pv.product_id
      WHERE pv.id = v_variant_id AND pv.product_id = v_product_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'One of the chosen items no longer exists.';
      END IF;
      v_variant_label := NULLIF(trim(both ' ' from concat_ws(' · ', NULLIF(v_region, ''), NULLIF(v_size, ''))), '');
    ELSE
      SELECT
        CASE WHEN p.offer_price IS NOT NULL AND p.offer_price < p.retail_price
             THEN p.offer_price ELSE p.retail_price END,
        p.stock_quantity, p.image_url, p.name, p.is_active
      INTO v_list_price, v_stock_quantity, v_image_url, v_product_name, v_is_active
      FROM products p
      WHERE p.id = v_product_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'One of the chosen items no longer exists.';
      END IF;
      v_variant_label := NULL;
    END IF;

    IF NOT v_is_active THEN
      RAISE EXCEPTION '"%" is not active — reactivate it first if you really want to sell it.', v_product_name;
    END IF;

    v_pack := inventory_pack_size(v_product_id, v_variant_id);
    IF v_sold_unit IS NOT NULL THEN
      IF v_pack <= 1 THEN
        RAISE EXCEPTION '"%" is sold in whole packs only (its pack size is 1).', v_product_name;
      END IF;
      v_sold_unit := inventory_stock_unit(v_product_id, v_variant_id);
      -- The list price of one unit.
      v_list_price := round(v_list_price / v_pack, 2);
    END IF;

    IF NOT v_is_admin AND v_sold_price_in IS NOT NULL AND v_sold_price_in <> v_list_price THEN
      RAISE EXCEPTION 'Only the Super Admin can change prices.';
    END IF;

    v_unit_price := COALESCE(v_sold_price_in, v_list_price);
    IF v_unit_price < 0 THEN
      RAISE EXCEPTION 'Price cannot be negative.';
    END IF;
    IF v_unit_price < v_list_price AND v_reason IS NULL THEN
      v_reason := 'other';
    END IF;

    -- While On the check is in units, for all lines together (below).
    IF NOT v_mode_on AND v_sold_unit IS NULL AND v_stock_quantity IS NOT NULL AND v_stock_quantity < v_quantity THEN
      v_warnings := v_warnings || jsonb_build_object(
        'product_name', v_product_name,
        'variant_label', v_variant_label,
        'available', v_stock_quantity,
        'requested', v_quantity
      );
    END IF;

    INSERT INTO _admin_order_lines (
      product_id, variant_id, product_name, variant_label, image_url,
      list_price, unit_price, quantity, line_total, reason, reason_note,
      is_tracked_stock, stock_available, sold_unit, units
    ) VALUES (
      v_product_id, v_variant_id, v_product_name, v_variant_label, v_image_url,
      v_list_price, v_unit_price, v_quantity, v_unit_price * v_quantity, v_reason, v_reason_note,
      (v_stock_quantity IS NOT NULL AND v_sold_unit IS NULL), v_stock_quantity, v_sold_unit,
      v_quantity * CASE WHEN v_sold_unit IS NULL THEN v_pack ELSE 1 END
    );

    v_subtotal   := v_subtotal + (v_unit_price * v_quantity);
    v_list_value := v_list_value + (v_list_price * v_quantity);
    IF v_unit_price = 0 THEN
      v_free_value := v_free_value + (v_list_price * v_quantity);
    END IF;
  END LOOP;

  -- Batch 39: while Inventory mode is On, units in lots (all lines of the
  -- same product / option together).
  IF v_mode_on THEN
    SELECT v_warnings || COALESCE(jsonb_agg(jsonb_build_object(
             'product_name', w.product_name, 'variant_label', w.variant_label,
             'available', w.available, 'requested', w.requested, 'unit', w.unit)), '[]'::jsonb)
    INTO v_warnings
    FROM (
      SELECT min(l.product_name) AS product_name, min(l.variant_label) AS variant_label,
             sum(l.units) AS requested,
             inventory_units_left(l.product_id, l.variant_id) AS available,
             inventory_stock_unit(l.product_id, l.variant_id) AS unit
      FROM _admin_order_lines l
      GROUP BY l.product_id, l.variant_id
    ) w
    WHERE w.requested > w.available;
  END IF;

  IF jsonb_array_length(v_warnings) > 0 AND NOT p_allow_negative_stock THEN
    RAISE EXCEPTION 'STOCK_WARNING:%', v_warnings::text;
  END IF;

  v_total := GREATEST(v_subtotal + v_delivery_fee - v_discount, 0);

  v_payment_status := CASE
    WHEN p_payment_method = 'cash' THEN 'paid'
    WHEN p_payment_method = 'bkash' AND p_bkash_trx_id IS NOT NULL AND trim(p_bkash_trx_id) <> '' THEN 'paid'
    WHEN p_payment_method = 'bkash' THEN 'pending_verification'
    ELSE 'unpaid'
  END;

  v_initial_status := CASE WHEN p_mark_delivered THEN 'delivered' ELSE 'confirmed' END;

  INSERT INTO orders (
    order_number, customer_id, source, customer_name, customer_phone,
    division, district, thana, address_line,
    delivery_zone, delivery_fee, subtotal, discount, discount_reason, discount_note,
    list_value, free_value, total,
    payment_method, bkash_trx_id, bkash_sender, payment_status,
    status, admin_note
  ) VALUES (
    next_order_number(), p_linked_customer_id, p_source, trim(p_full_name), COALESCE(p_phone, ''),
    COALESCE(p_division, ''), COALESCE(p_district, ''), COALESCE(p_thana, ''), trim(p_address_line),
    p_delivery_zone, v_delivery_fee, v_subtotal, v_discount,
    NULLIF(trim(COALESCE(p_discount_reason, '')), ''), NULLIF(trim(COALESCE(p_discount_note, '')), ''),
    v_list_value, v_free_value, v_total,
    p_payment_method, NULLIF(trim(COALESCE(p_bkash_trx_id, '')), ''), NULLIF(trim(COALESCE(p_bkash_sender, '')), ''),
    v_payment_status,
    v_initial_status, NULLIF(trim(COALESCE(p_admin_note, '')), '')
  )
  RETURNING id, orders.order_number INTO v_order_id, v_order_number;

  -- Batch 39: the order_items trigger takes the units from lots (while On).
  -- Short: STOCK_WARNING (the screen asks), or recorded as "sold without
  -- stock" after the admin said "sell anyway".
  PERFORM set_config('inventory.short_warn', 'on', true);
  PERFORM set_config('inventory.short_ok', CASE WHEN p_allow_negative_stock THEN 'on' ELSE '' END, true);
  INSERT INTO order_items (
    order_id, product_id, variant_id, product_name, variant_label, image_url,
    list_price, unit_price, quantity, line_total, reason, reason_note, sold_unit
  )
  SELECT
    v_order_id, product_id, variant_id, product_name, variant_label, image_url,
    list_price, unit_price, quantity, line_total, reason, reason_note, sold_unit
  FROM _admin_order_lines;
  PERFORM set_config('inventory.short_warn', '', true);
  PERFORM set_config('inventory.short_ok', '', true);

  PERFORM set_config('app.order_stock_change', 'on', true);
  UPDATE product_variants pv SET stock_quantity = pv.stock_quantity - l.quantity
    FROM _admin_order_lines l
    WHERE l.variant_id IS NOT NULL AND l.is_tracked_stock AND pv.id = l.variant_id;
  UPDATE products p SET stock_quantity = p.stock_quantity - l.quantity
    FROM _admin_order_lines l
    WHERE l.variant_id IS NULL AND l.is_tracked_stock AND p.id = l.product_id;
  PERFORM set_config('app.order_stock_change', 'off', true);

  INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, note)
  VALUES (
    v_order_id, NULL, v_initial_status, auth.uid(),
    format('Entered manually — source: %s', p_source)
  );

  RETURN QUERY SELECT v_order_id, v_order_number;
END;
$function$;

-- ---------------------------------------------------------------------------
-- admin_edit_order — loose units on new lines; while On: "sell anyway" for edits
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_edit_order(p_order_id uuid, p_changes jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_admin     boolean := is_admin();
  v_order        orders%ROWTYPE;
  v_notes        text[] := '{}';
  v_courier      text[] := '{}';
  v_moves_stock  boolean;
  v_booked       boolean;
  v_name         text;
  v_phone        text;
  v_alt          text;
  v_division     text;
  v_district     text;
  v_thana        text;
  v_address      text;
  v_cnote        text;
  v_fee          numeric(10,2);
  v_discount     numeric(10,2);
  v_dnote        text;
  v_item         jsonb;
  v_old          order_items%ROWTYPE;
  v_keep         uuid[];
  v_qty          integer;
  v_price        numeric(10,2);
  v_product_id   uuid;
  v_variant_id   uuid;
  v_list         numeric(10,2);
  v_pname        text;
  v_vlabel       text;
  v_image        text;
  v_active       boolean;
  v_region       text;
  v_size         text;
  v_label        text;
  v_subtotal     numeric(10,2);
  v_list_value   numeric(10,2);
  v_free         numeric(10,2);
  v_total        numeric(10,2);
  v_note         text;
  v_outdated     text[];
  v_sold_unit    text;
  v_pack         integer;
BEGIN
  IF NOT staff_can('edit_orders') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' THEN
    RAISE EXCEPTION 'Nothing to change.';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;

  v_moves_stock := v_order.status <> 'cancelled' AND NOT v_order.stock_released;
  v_booked := v_order.steadfast_consignment_id IS NOT NULL
    AND v_order.status NOT IN ('delivered', 'cancelled')
    AND COALESCE(v_order.steadfast_status, '') NOT IN ('delivered', 'partial_delivered', 'cancelled');

  -- ---------- customer and address ----------
  v_name := CASE WHEN p_changes ? 'customer_name' THEN trim(COALESCE(p_changes ->> 'customer_name', '')) ELSE v_order.customer_name END;
  v_phone := CASE WHEN p_changes ? 'customer_phone' THEN trim(COALESCE(p_changes ->> 'customer_phone', '')) ELSE v_order.customer_phone END;
  v_alt := CASE WHEN p_changes ? 'alt_phone' THEN NULLIF(trim(COALESCE(p_changes ->> 'alt_phone', '')), '') ELSE v_order.alt_phone END;
  v_division := CASE WHEN p_changes ? 'division' THEN trim(COALESCE(p_changes ->> 'division', '')) ELSE v_order.division END;
  v_district := CASE WHEN p_changes ? 'district' THEN trim(COALESCE(p_changes ->> 'district', '')) ELSE v_order.district END;
  v_thana := CASE WHEN p_changes ? 'thana' THEN trim(COALESCE(p_changes ->> 'thana', '')) ELSE v_order.thana END;
  v_address := CASE WHEN p_changes ? 'address_line' THEN trim(COALESCE(p_changes ->> 'address_line', '')) ELSE v_order.address_line END;
  v_cnote := CASE WHEN p_changes ? 'courier_note' THEN NULLIF(trim(COALESCE(p_changes ->> 'courier_note', '')), '') ELSE v_order.courier_note END;

  IF v_name = '' THEN
    RAISE EXCEPTION 'Customer name is required.';
  END IF;
  IF v_address = '' THEN
    RAISE EXCEPTION 'Delivery address is required.';
  END IF;

  IF v_name IS DISTINCT FROM v_order.customer_name THEN
    v_notes := v_notes || format('Name %s → %s', v_order.customer_name, v_name);
    v_courier := v_courier || 'Name'::text;
  END IF;
  IF v_phone IS DISTINCT FROM v_order.customer_phone THEN
    v_notes := v_notes || format('Phone %s → %s', COALESCE(NULLIF(v_order.customer_phone, ''), '(none)'), COALESCE(NULLIF(v_phone, ''), '(none)'));
    v_courier := v_courier || 'Phone'::text;
  END IF;
  IF v_alt IS DISTINCT FROM v_order.alt_phone THEN
    v_notes := v_notes || format('Alternative phone %s → %s', COALESCE(v_order.alt_phone, '(none)'), COALESCE(v_alt, '(none)'));
    v_courier := v_courier || 'Alternative phone'::text;
  END IF;
  IF v_division IS DISTINCT FROM v_order.division OR v_district IS DISTINCT FROM v_order.district
     OR v_thana IS DISTINCT FROM v_order.thana OR v_address IS DISTINCT FROM v_order.address_line THEN
    v_notes := v_notes || format('Address %s → %s',
      concat_ws(', ', NULLIF(v_order.address_line, ''), NULLIF(v_order.thana, ''), NULLIF(v_order.district, '')),
      concat_ws(', ', NULLIF(v_address, ''), NULLIF(v_thana, ''), NULLIF(v_district, '')));
    v_courier := v_courier || 'Address'::text;
  END IF;
  IF v_cnote IS DISTINCT FROM v_order.courier_note THEN
    v_notes := v_notes || format('Courier note %s → %s', COALESCE(v_order.courier_note, '(none)'), COALESCE(v_cnote, '(none)'));
    v_courier := v_courier || 'Note'::text;
  END IF;

  -- ---------- delivery fee and discount ----------
  v_fee := v_order.delivery_fee;
  IF p_changes ? 'delivery_fee' THEN
    v_fee := round(NULLIF(p_changes ->> 'delivery_fee', '')::numeric, 2);
    IF v_fee IS NULL OR v_fee < 0 THEN
      RAISE EXCEPTION 'Delivery fee must be 0 or more.';
    END IF;
  END IF;

  v_discount := v_order.discount;
  v_dnote := v_order.discount_note;
  IF p_changes ? 'discount' THEN
    v_discount := round(COALESCE(NULLIF(p_changes ->> 'discount', '')::numeric, 0), 2);
    IF v_discount < 0 THEN
      RAISE EXCEPTION 'Discount must be 0 or more.';
    END IF;
  END IF;
  IF p_changes ? 'discount_note' THEN
    v_dnote := NULLIF(trim(COALESCE(p_changes ->> 'discount_note', '')), '');
  END IF;
  IF NOT v_is_admin AND (v_discount IS DISTINCT FROM v_order.discount OR v_dnote IS DISTINCT FROM v_order.discount_note) THEN
    RAISE EXCEPTION 'Only the Super Admin can change the discount.';
  END IF;

  -- ---------- items ----------
  IF p_changes ? 'items' THEN
    IF jsonb_typeof(p_changes -> 'items') IS DISTINCT FROM 'array' OR jsonb_array_length(p_changes -> 'items') = 0 THEN
      RAISE EXCEPTION 'An order needs at least one item.';
    END IF;

    SELECT COALESCE(array_agg((e ->> 'id')::uuid), '{}'::uuid[]) INTO v_keep
    FROM jsonb_array_elements(p_changes -> 'items') e
    WHERE NULLIF(e ->> 'id', '') IS NOT NULL;

    PERFORM set_config('app.order_stock_change', 'on', true);
    -- Batch 39: while On the order_items triggers take / give back units in
    -- lots. Short: STOCK_WARNING (the screen asks "sell anyway?") unless
    -- the admin already said yes (allow_short).
    PERFORM set_config('inventory.short_warn', 'on', true);
    PERFORM set_config('inventory.short_ok',
      CASE WHEN COALESCE((p_changes ->> 'allow_short')::boolean, false) THEN 'on' ELSE '' END, true);

    -- Lines left out: removed, their stock put back.
    FOR v_old IN SELECT * FROM order_items WHERE order_id = p_order_id AND NOT (id = ANY (v_keep)) LOOP
      v_label := v_old.product_name || COALESCE(' (' || v_old.variant_label || ')', '');
      IF v_moves_stock AND v_old.sold_unit IS NULL THEN
        PERFORM order_edit_stock(v_old.product_id, v_old.variant_id, v_old.quantity, v_label);
      END IF;
      DELETE FROM order_items WHERE id = v_old.id;
      v_notes := v_notes || format('Removed %s ×%s%s', v_label, v_old.quantity, COALESCE(' ' || v_old.sold_unit, ''));
    END LOOP;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_changes -> 'items') LOOP
      v_qty := NULLIF(v_item ->> 'quantity', '')::integer;
      IF v_qty IS NULL OR v_qty <= 0 THEN
        RAISE EXCEPTION 'Quantity must be 1 or more.';
      END IF;
      v_price := round(NULLIF(v_item ->> 'unit_price', '')::numeric, 2);
      IF v_price IS NOT NULL AND v_price < 0 THEN
        RAISE EXCEPTION 'Price must be 0 or more.';
      END IF;

      IF NULLIF(v_item ->> 'id', '') IS NOT NULL THEN
        SELECT * INTO v_old FROM order_items WHERE id = (v_item ->> 'id')::uuid AND order_id = p_order_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'One of the items is no longer on this order. Close the sheet and try again.';
        END IF;
        v_label := v_old.product_name || COALESCE(' (' || v_old.variant_label || ')', '');
        IF v_qty <> v_old.quantity THEN
          IF v_moves_stock AND v_old.sold_unit IS NULL THEN
            PERFORM order_edit_stock(v_old.product_id, v_old.variant_id, v_old.quantity - v_qty, v_label);
          END IF;
          v_notes := v_notes || format('Quantity of %s %s → %s%s', v_label, v_old.quantity, v_qty, COALESCE(' ' || v_old.sold_unit, ''));
        END IF;
        v_price := COALESCE(v_price, v_old.unit_price);
        IF v_price <> v_old.unit_price THEN
          IF NOT v_is_admin THEN
            RAISE EXCEPTION 'Only the Super Admin can change prices.';
          END IF;
          v_notes := v_notes || format('Price of %s %s → %s', v_label, taka_text(v_old.unit_price), taka_text(v_price));
        END IF;
        UPDATE order_items SET
          quantity = v_qty,
          unit_price = v_price,
          line_total = v_price * v_qty,
          reason = CASE WHEN v_price < list_price THEN COALESCE(reason, 'other') ELSE NULL END
        WHERE id = v_old.id;
      ELSE
        v_product_id := NULLIF(v_item ->> 'product_id', '')::uuid;
        v_variant_id := NULLIF(v_item ->> 'variant_id', '')::uuid;
        IF v_product_id IS NULL THEN
          RAISE EXCEPTION 'Choose a product for the new item.';
        END IF;
        IF v_variant_id IS NOT NULL THEN
          SELECT
            CASE WHEN pv.offer_price IS NOT NULL AND pv.offer_price < pv.retail_price THEN pv.offer_price ELSE pv.retail_price END,
            pv.region, pv.size, COALESCE(pv.image_url, p.image_url), p.name, p.is_active
          INTO v_list, v_region, v_size, v_image, v_pname, v_active
          FROM product_variants pv JOIN products p ON p.id = pv.product_id
          WHERE pv.id = v_variant_id AND pv.product_id = v_product_id;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'That product option no longer exists.';
          END IF;
          v_vlabel := NULLIF(trim(both ' ' from concat_ws(' · ', NULLIF(v_region, ''), NULLIF(v_size, ''))), '');
        ELSE
          SELECT
            CASE WHEN p.offer_price IS NOT NULL AND p.offer_price < p.retail_price THEN p.offer_price ELSE p.retail_price END,
            p.image_url, p.name, p.is_active
          INTO v_list, v_image, v_pname, v_active
          FROM products p WHERE p.id = v_product_id;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'That product no longer exists.';
          END IF;
          v_vlabel := NULL;
        END IF;
        IF NOT v_active THEN
          RAISE EXCEPTION '"%" is not active — reactivate it first if you really want to sell it.', v_pname;
        END IF;
        -- Batch 39: 'pcs' / 'ml' / 'g' = a new line sold in loose units.
        v_sold_unit := NULLIF(trim(COALESCE(v_item ->> 'sold_unit', '')), '');
        v_pack := inventory_pack_size(v_product_id, v_variant_id);
        IF v_sold_unit IS NOT NULL THEN
          IF v_pack <= 1 THEN
            RAISE EXCEPTION '"%" is sold in whole packs only (its pack size is 1).', v_pname;
          END IF;
          v_sold_unit := inventory_stock_unit(v_product_id, v_variant_id);
          v_list := round(v_list / v_pack, 2);
        END IF;
        v_price := COALESCE(v_price, v_list);
        IF v_price <> v_list AND NOT v_is_admin THEN
          RAISE EXCEPTION 'Only the Super Admin can change prices.';
        END IF;
        v_label := v_pname || COALESCE(' (' || v_vlabel || ')', '');
        IF v_moves_stock AND v_sold_unit IS NULL THEN
          PERFORM order_edit_stock(v_product_id, v_variant_id, -v_qty, v_label);
        END IF;
        INSERT INTO order_items (
          order_id, product_id, variant_id, product_name, variant_label, image_url,
          list_price, unit_price, quantity, line_total, reason, sold_unit
        ) VALUES (
          p_order_id, v_product_id, v_variant_id, v_pname, v_vlabel, v_image,
          v_list, v_price, v_qty, v_price * v_qty,
          CASE WHEN v_price < v_list THEN 'other' END, v_sold_unit
        );
        v_notes := v_notes || format('Added %s ×%s%s (%s each)', v_label, v_qty, COALESCE(' ' || v_sold_unit, ''), taka_text(v_price));
      END IF;
    END LOOP;

    PERFORM set_config('app.order_stock_change', 'off', true);
    PERFORM set_config('inventory.short_warn', '', true);
    PERFORM set_config('inventory.short_ok', '', true);
  END IF;

  -- ---------- totals ----------
  SELECT COALESCE(sum(line_total), 0),
         COALESCE(sum(list_price * quantity), 0),
         COALESCE(sum(CASE WHEN unit_price = 0 THEN list_price * quantity ELSE 0 END), 0)
  INTO v_subtotal, v_list_value, v_free
  FROM order_items WHERE order_id = p_order_id;

  IF v_fee IS DISTINCT FROM v_order.delivery_fee THEN
    v_notes := v_notes || format('Delivery fee %s → %s', taka_text(v_order.delivery_fee), taka_text(v_fee));
  END IF;
  v_discount := LEAST(v_discount, v_subtotal);
  IF v_discount IS DISTINCT FROM v_order.discount THEN
    v_notes := v_notes || format('Discount %s → %s%s', taka_text(v_order.discount), taka_text(v_discount),
      COALESCE(' (' || v_dnote || ')', ''));
  ELSIF v_dnote IS DISTINCT FROM v_order.discount_note THEN
    v_notes := v_notes || format('Discount reason %s → %s', COALESCE(v_order.discount_note, '(none)'), COALESCE(v_dnote, '(none)'));
  END IF;
  v_total := GREATEST(v_subtotal + v_fee - v_discount, 0);

  IF cardinality(v_notes) = 0 THEN
    RETURN jsonb_build_object('changed', 0, 'total', v_order.total, 'steadfast_outdated', to_jsonb(v_order.steadfast_outdated));
  END IF;

  IF v_total IS DISTINCT FROM v_order.total THEN
    v_notes := v_notes || format('Total %s → %s', taka_text(v_order.total), taka_text(v_total));
  END IF;

  v_outdated := v_order.steadfast_outdated;
  IF v_booked AND cardinality(v_courier) > 0 THEN
    SELECT COALESCE(array_agg(f ORDER BY array_position(ARRAY['Name', 'Phone', 'Alternative phone', 'Address', 'Note'], f)), '{}'::text[])
    INTO v_outdated
    FROM (SELECT DISTINCT unnest(v_order.steadfast_outdated || v_courier) AS f) x;
  END IF;

  PERFORM set_config('app.activity_quiet', 'on', true);
  UPDATE orders SET
    customer_name   = v_name,
    customer_phone  = v_phone,
    alt_phone       = v_alt,
    division        = v_division,
    district        = v_district,
    thana           = v_thana,
    address_line    = v_address,
    courier_note    = v_cnote,
    delivery_fee    = v_fee,
    discount        = v_discount,
    discount_reason = CASE
                        WHEN v_discount = 0 THEN NULL
                        WHEN v_order.promo_code IS NULL THEN COALESCE(v_order.discount_reason, 'other')
                        ELSE v_order.discount_reason
                      END,
    discount_note   = CASE WHEN v_discount = 0 THEN NULL ELSE v_dnote END,
    subtotal        = v_subtotal,
    list_value      = v_list_value,
    free_value      = v_free,
    total           = v_total,
    steadfast_outdated = v_outdated,
    updated_at      = now()
  WHERE id = p_order_id;
  PERFORM set_config('app.activity_quiet', 'off', true);

  FOREACH v_note IN ARRAY v_notes LOOP
    PERFORM order_history_line(p_order_id, v_order.status, v_note);
  END LOOP;

  PERFORM write_activity('order.edited', 'order', p_order_id::text, v_order.order_number,
    format('%s: %s', v_order.order_number, array_to_string(v_notes, '; ')),
    jsonb_build_object(
      'changes', to_jsonb(v_notes),
      'total', jsonb_build_object('from', v_order.total, 'to', v_total),
      'steadfast_consignment_id', v_order.steadfast_consignment_id));

  PERFORM order_payments_sync(p_order_id);

  RETURN jsonb_build_object('changed', cardinality(v_notes), 'total', v_total, 'steadfast_outdated', to_jsonb(v_outdated));
END;
$function$;

-- ---------------------------------------------------------------------------
-- PART 8 — landed cost per UNIT, missing weights guessed, late bills
-- ---------------------------------------------------------------------------
-- (Re)calculates one purchase lot. Replaces the Batch 38 version; with pack
-- size 1 and every weight filled in, the result is exactly the same.
--   entered   = packs (entry_unit 'pack') or units (entry_unit 'unit')
--   price     = unit_price_foreign × exchange_rate, per entered pack / unit
--               (4 decimals)
--   buy_value_bdt = entered × price (exact); unit_price_bdt = per unit
--   Weight bills, shared by grams: grams of a row = units × (weight per
--   pack ÷ pack size). Rows without a weight get a weight guessed from
--   their buy value, using the lot's own grams per taka of the rows that
--   have one (marked weight_guessed). No row with a weight → the whole
--   weight bill is shared by buy value.
--   Other bills, shared by buy value (every value 0 → by units).
--   Largest-remainder method in whole paisa: exact to the paisa.
--   landed_unit_cost_bdt = (buy value + shares) ÷ units.
-- The same rule is in src/lib/inventory/allocation.ts (the preview).
--
-- Late bills (Batch 39): units already sold keep the cost locked when they
-- left. If a row's cost per unit changes while some of its units are out,
-- (new − old) × units out is written to cost_adjustments, dated
-- p_adjust_date (the bill's date; today if none). Unsold units simply take
-- the new cost.
DROP FUNCTION IF EXISTS inventory_allocate_lot(uuid);
CREATE OR REPLACE FUNCTION inventory_allocate_lot(p_lot_id uuid, p_adjust_date date DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lot          lots%ROWTYPE;
  v_weight_paisa numeric;
  v_other_paisa  numeric;
  v_old          jsonb;
  v_l            numeric := 1;
  v_pack         record;
  v_g            numeric;
  v_v            numeric;
  v_has_w        boolean;
  v_has_unw      boolean;
  v_mode         text;
  v_row          record;
  v_out          bigint;
  v_amount       numeric;
BEGIN
  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id FOR UPDATE;
  IF NOT FOUND OR v_lot.kind <> 'purchase' THEN
    RETURN;
  END IF;

  SELECT COALESCE(jsonb_object_agg(id::text, landed_unit_cost_bdt), '{}'::jsonb) INTO v_old
  FROM lot_items WHERE lot_id = p_lot_id;

  SELECT COALESCE(sum(round(amount_bdt * 100)) FILTER (WHERE cost_type = 'weight'), 0),
         COALESCE(sum(round(amount_bdt * 100)) FILTER (WHERE cost_type = 'other'), 0)
  INTO v_weight_paisa, v_other_paisa
  FROM lot_costs WHERE lot_id = p_lot_id;

  UPDATE lot_items
  SET buy_value_bdt = (CASE WHEN entry_unit = 'pack' THEN qty / pack_size ELSE qty END)
                      * round(unit_price_foreign * v_lot.exchange_rate, 4),
      unit_price_bdt = round((CASE WHEN entry_unit = 'pack' THEN qty / pack_size ELSE qty END)
                             * round(unit_price_foreign * v_lot.exchange_rate, 4) / qty, 4)
  WHERE lot_id = p_lot_id;

  -- A common multiple of the pack sizes keeps every row's grams a whole
  -- number: grams × 100 × (L ÷ pack size) × units.
  FOR v_pack IN SELECT DISTINCT pack_size FROM lot_items WHERE lot_id = p_lot_id AND weight_grams_used IS NOT NULL LOOP
    v_l := lcm(v_l, v_pack.pack_size::numeric);
  END LOOP;

  SELECT COALESCE(sum(qty * round(weight_grams_used * 100) * (v_l / pack_size)) FILTER (WHERE weight_grams_used IS NOT NULL), 0),
         COALESCE(sum(round(buy_value_bdt * 10000)) FILTER (WHERE weight_grams_used IS NOT NULL), 0),
         COALESCE(bool_or(weight_grams_used IS NOT NULL), false),
         COALESCE(bool_or(weight_grams_used IS NULL), false)
  INTO v_g, v_v, v_has_w, v_has_unw
  FROM lot_items WHERE lot_id = p_lot_id;

  v_mode := CASE
    WHEN v_weight_paisa = 0 THEN 'none'
    WHEN NOT v_has_unw THEN 'grams'
    WHEN v_has_w AND v_v > 0 AND v_g > 0 THEN 'guess'
    ELSE 'value'
  END;

  WITH base AS (
    SELECT li.id, li.qty, li.sort_order, li.weight_grams_used IS NULL AS no_weight,
           CASE WHEN li.weight_grams_used IS NULL THEN 0
                ELSE li.qty * round(li.weight_grams_used * 100) * (v_l / li.pack_size) END AS grams,
           round(li.buy_value_bdt * 10000) AS vb
    FROM lot_items li
    WHERE li.lot_id = p_lot_id
  ), totals AS (
    SELECT sum(vb) AS vt, sum(qty) AS qt FROM base
  ), basis AS (
    SELECT b.id, b.qty, b.sort_order, b.no_weight,
           CASE v_mode
             WHEN 'none'  THEN 0
             WHEN 'grams' THEN b.grams
             -- guessed grams = value × (G ÷ V); everything × V stays whole
             WHEN 'guess' THEN CASE WHEN b.no_weight THEN b.vb * v_g ELSE b.grams * v_v END
             ELSE CASE WHEN t.vt > 0 THEN b.vb ELSE b.qty END
           END AS wb,
           CASE WHEN t.vt > 0 THEN b.vb ELSE b.qty END AS ob,
           CASE WHEN t.vt > 0 THEN t.vt ELSE t.qt END AS ot
    FROM base b CROSS JOIN totals t
  ), wsum AS (
    SELECT sum(wb) AS wt FROM basis
  ), shares AS (
    SELECT b.id, b.qty, b.sort_order, b.no_weight,
           CASE WHEN w.wt > 0 THEN div(v_weight_paisa * b.wb, w.wt) ELSE 0 END AS w_floor,
           CASE WHEN w.wt > 0 THEN mod(v_weight_paisa * b.wb, w.wt) ELSE 0 END AS w_rem,
           CASE WHEN b.ot > 0 THEN div(v_other_paisa * b.ob, b.ot) ELSE 0 END AS o_floor,
           CASE WHEN b.ot > 0 THEN mod(v_other_paisa * b.ob, b.ot) ELSE 0 END AS o_rem
    FROM basis b CROSS JOIN wsum w
  ), ranked AS (
    SELECT s.*,
           row_number() OVER (ORDER BY w_rem DESC, sort_order, id) AS w_rank,
           row_number() OVER (ORDER BY o_rem DESC, sort_order, id) AS o_rank,
           CASE WHEN v_mode = 'none' THEN 0 ELSE v_weight_paisa - sum(w_floor) OVER () END AS w_left,
           v_other_paisa - sum(o_floor) OVER () AS o_left
    FROM shares s
  ), final AS (
    SELECT id, qty, no_weight,
           (w_floor + CASE WHEN w_rank <= w_left THEN 1 ELSE 0 END)::bigint AS w_paisa,
           (o_floor + CASE WHEN o_rank <= o_left THEN 1 ELSE 0 END)::bigint AS o_paisa
    FROM ranked
  )
  UPDATE lot_items li
  SET alloc_weight_paisa = f.w_paisa,
      alloc_other_paisa = f.o_paisa,
      alloc_weight_bdt = round(f.w_paisa::numeric / f.qty / 100, 6),
      alloc_other_bdt = round(f.o_paisa::numeric / f.qty / 100, 6),
      landed_unit_cost_bdt = round(li.buy_value_bdt / f.qty + f.w_paisa::numeric / f.qty / 100 + f.o_paisa::numeric / f.qty / 100, 6),
      weight_guessed = (v_mode IN ('guess', 'value') AND f.no_weight)
  FROM final f
  WHERE li.id = f.id;

  -- Late bill / changed cost: units already out keep their locked cost.
  FOR v_row IN
    SELECT li.id, li.landed_unit_cost_bdt AS new_cost, (v_old ->> li.id::text)::numeric AS old_cost
    FROM lot_items li
    WHERE li.lot_id = p_lot_id
      AND v_old ? li.id::text
      AND li.landed_unit_cost_bdt <> (v_old ->> li.id::text)::numeric
  LOOP
    SELECT COALESCE(sum(units - units_back), 0) INTO v_out
    FROM order_item_lots WHERE lot_item_id = v_row.id AND units > units_back;
    CONTINUE WHEN v_out = 0;
    UPDATE order_item_lots
    SET adjust_bdt = adjust_bdt + (v_row.new_cost - v_row.old_cost) * (units - units_back)
    WHERE lot_item_id = v_row.id AND units > units_back;
    v_amount := round((v_row.new_cost - v_row.old_cost) * v_out, 2);
    IF v_amount <> 0 THEN
      INSERT INTO cost_adjustments (adj_date, amount_bdt, reason, lot_id, lot_item_id, note, created_by)
      VALUES (COALESCE(p_adjust_date, inventory_dhaka_today()), v_amount, 'late_bill', p_lot_id, v_row.id,
              format('%s: cost per unit ৳%s → ৳%s for %s units already sold',
                     v_lot.code, round(v_row.old_cost, 2), round(v_row.new_cost, 2), v_out),
              auth.uid());
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION inventory_allocate_lot(uuid, date) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- PART 9 — suppliers, pack size
-- ---------------------------------------------------------------------------
-- "+ Add new" in the lot form. The same name (any capitals) gives back the
-- supplier that already exists.
CREATE OR REPLACE FUNCTION inventory_save_supplier(p_name text, p_country text DEFAULT '', p_note text DEFAULT '')
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id   uuid;
  v_name text := btrim(COALESCE(p_name, ''));
BEGIN
  IF NOT staff_can('view_profit_costs') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF v_name = '' THEN
    RAISE EXCEPTION 'Enter the supplier''s name.';
  END IF;
  IF length(v_name) > 120 THEN
    RAISE EXCEPTION 'The supplier''s name is too long.';
  END IF;
  SELECT id INTO v_id FROM suppliers WHERE lower(btrim(name)) = lower(v_name);
  IF FOUND THEN
    RETURN v_id;
  END IF;
  INSERT INTO suppliers (name, country, note, created_by)
  VALUES (v_name, btrim(COALESCE(p_country, '')), btrim(COALESCE(p_note, '')), auth.uid())
  RETURNING id INTO v_id;
  PERFORM write_activity('inventory.supplier_added', 'supplier', v_id::text, v_name,
    format('Added supplier "%s"', v_name), jsonb_build_object('country', btrim(COALESCE(p_country, ''))));
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION inventory_save_supplier(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory_save_supplier(text, text, text) TO authenticated;

-- Removes a supplier added by mistake. Only one that no lot uses.
CREATE OR REPLACE FUNCTION inventory_delete_supplier(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text;
BEGIN
  IF NOT staff_can('view_profit_costs') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  SELECT name INTO v_name FROM suppliers WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Supplier not found.';
  END IF;
  IF EXISTS (SELECT 1 FROM lots WHERE supplier_id = p_id) THEN
    RAISE EXCEPTION 'A lot uses "%"; it can''t be removed.', v_name;
  END IF;
  DELETE FROM suppliers WHERE id = p_id;
  PERFORM write_activity('inventory.supplier_removed', 'supplier', p_id::text, v_name,
    format('Removed supplier "%s"', v_name), '{}'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION inventory_delete_supplier(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory_delete_supplier(uuid) TO authenticated;

-- Stock unit and pack size of every sellable unit, for staff screens
-- (product editor, manual order, order edit). Never for shoppers.
CREATE OR REPLACE FUNCTION inventory_pack_units()
RETURNS TABLE (product_id uuid, variant_id uuid, stock_unit text, pack_size integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_staff() THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT p.id, NULL::uuid, p.stock_unit, p.pack_size FROM products p
  WHERE NOT EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id)
  UNION ALL
  SELECT v.product_id, v.id, v.stock_unit, v.pack_size FROM product_variants v;
END;
$$;

REVOKE ALL ON FUNCTION inventory_pack_units() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory_pack_units() TO authenticated;

-- Product editor: "Stock unit" and "Pack size". Staff with "Edit products"
-- (or "View profit & costs"). The product / option activity triggers log
-- the change like any other product edit.
CREATE OR REPLACE FUNCTION inventory_set_pack(p_product_id uuid, p_variant_id uuid, p_unit text, p_pack_size integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_unit text := lower(btrim(COALESCE(p_unit, '')));
BEGIN
  IF NOT (staff_can('edit_products') OR staff_can('view_profit_costs')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF v_unit NOT IN ('pcs', 'ml', 'g') THEN
    RAISE EXCEPTION 'Stock unit must be pcs, ml or g.';
  END IF;
  IF p_pack_size IS NULL OR p_pack_size < 1 OR p_pack_size > 1000000 THEN
    RAISE EXCEPTION 'Pack size must be a whole number from 1 to 1000000.';
  END IF;
  PERFORM inventory_check_unit(p_product_id, p_variant_id, 'Pack size');
  IF p_variant_id IS NULL THEN
    UPDATE products SET stock_unit = v_unit, pack_size = p_pack_size
    WHERE id = p_product_id AND (stock_unit IS DISTINCT FROM v_unit OR pack_size IS DISTINCT FROM p_pack_size);
  ELSE
    UPDATE product_variants SET stock_unit = v_unit, pack_size = p_pack_size
    WHERE id = p_variant_id AND (stock_unit IS DISTINCT FROM v_unit OR pack_size IS DISTINCT FROM p_pack_size);
  END IF;
  -- While On the shop's whole packs change with the pack size.
  PERFORM inventory_sync_unit(p_product_id, p_variant_id);
END;
$$;

REVOKE ALL ON FUNCTION inventory_set_pack(uuid, uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory_set_pack(uuid, uuid, text, integer) TO authenticated;

-- The Inventory screens' list of sellable units, now with stock unit and
-- pack size (lot_pieces_left is in units).
DROP FUNCTION IF EXISTS inventory_stock_units();
CREATE OR REPLACE FUNCTION inventory_stock_units()
RETURNS TABLE (
  product_id      uuid,
  variant_id      uuid,
  sku             text,
  product_name    text,
  option_label    text,
  is_active       boolean,
  weight_grams    numeric,
  weight_source   text,
  site_stock      integer,
  in_stock        boolean,
  selling_price   numeric,
  lot_pieces_left bigint,
  lot_rows        bigint,
  stock_unit      text,
  pack_size       integer,
  latest_unit_cost numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT staff_can('view_profit_costs') THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT u.* FROM (
    SELECT p.id, NULL::uuid, p.sku, p.name, NULL::text, p.is_active,
           p.weight_grams, p.weight_source, p.stock_quantity,
           (p.stock_status <> 'out_of_stock'),
           CASE WHEN p.offer_price IS NOT NULL AND p.offer_price < p.retail_price THEN p.offer_price ELSE p.retail_price END,
           COALESCE(l.left_qty, 0)::bigint, COALESCE(l.n, 0)::bigint,
           p.stock_unit, p.pack_size, inventory_latest_unit_cost(p.id, NULL)
    FROM products p
    LEFT JOIN LATERAL (
      SELECT sum(li.qty_remaining) AS left_qty, count(*) AS n
      FROM lot_items li WHERE li.product_id = p.id AND li.variant_id IS NULL
    ) l ON true
    WHERE NOT EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = p.id)
    UNION ALL
    SELECT p.id, v.id, p.sku, p.name,
           NULLIF(concat_ws(' · ', NULLIF(btrim(v.region), ''), NULLIF(btrim(v.size), '')), ''),
           p.is_active, v.weight_grams, v.weight_source, v.stock_quantity, v.in_stock,
           CASE WHEN v.offer_price IS NOT NULL AND v.offer_price < v.retail_price THEN v.offer_price ELSE v.retail_price END,
           COALESCE(l.left_qty, 0)::bigint, COALESCE(l.n, 0)::bigint,
           v.stock_unit, v.pack_size, inventory_latest_unit_cost(p.id, v.id)
    FROM product_variants v
    JOIN products p ON p.id = v.product_id
    LEFT JOIN LATERAL (
      SELECT sum(li.qty_remaining) AS left_qty, count(*) AS n
      FROM lot_items li WHERE li.variant_id = v.id
    ) l ON true
  ) u (product_id, variant_id, sku, product_name, option_label, is_active, weight_grams, weight_source,
       site_stock, in_stock, selling_price, lot_pieces_left, lot_rows, stock_unit, pack_size, latest_unit_cost)
  ORDER BY u.is_active DESC, lower(u.product_name), u.option_label NULLS FIRST;
END;
$$;

REVOKE ALL ON FUNCTION inventory_stock_units() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory_stock_units() TO authenticated;

-- ---------------------------------------------------------------------------
-- PART 10 — saving a lot (units, supplier list, shortfalls, late bills)
-- ---------------------------------------------------------------------------
--   p_lot: { id?, source_type, country, supplier_id?, supplier?, lot_date,
--            currency?, exchange_rate?, costs_pending, notes,
--            items: [{ id?, product_id, variant_id?, qty, entry_unit?
--                      ('pack' | 'unit'), unit_price_foreign (per entered
--                      pack / unit), weight_grams? (per pack), expiry_date?,
--                      save_weight_to_product? }],
--            costs: [{ id?, cost_type, amount_bdt, cost_date?, note? }] }
-- qty is what was entered: packs or units. Stored as units. Currency and
-- rate are no longer shown on the screens: a new lot is in taka (rate 1);
-- an old lot keeps the currency and rate it was saved with.
CREATE OR REPLACE FUNCTION inventory_save_lot(p_lot jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id        uuid := NULLIF(p_lot ->> 'id', '')::uuid;
  v_is_new    boolean := v_id IS NULL;
  v_lot       lots%ROWTYPE;
  v_source    text := p_lot ->> 'source_type';
  v_currency  text := upper(COALESCE(NULLIF(p_lot ->> 'currency', ''), 'BDT'));
  v_rate      numeric;
  v_date      date := NULLIF(p_lot ->> 'lot_date', '')::date;
  v_items     jsonb := COALESCE(p_lot -> 'items', '[]'::jsonb);
  v_costs     jsonb := COALESCE(p_lot -> 'costs', '[]'::jsonb);
  v_supplier_id uuid := NULLIF(p_lot ->> 'supplier_id', '')::uuid;
  v_supplier  text := btrim(COALESCE(p_lot ->> 'supplier', ''));
  v_n         integer;
  v_code      text;
  v_item      jsonb;
  v_cost      jsonb;
  v_idx       integer := 0;
  v_row       text;
  v_item_id   uuid;
  v_pid       uuid;
  v_vid       uuid;
  v_qty       numeric;
  v_entry     text;
  v_pack      integer;
  v_units     integer;
  v_price     numeric;
  v_grams     numeric;
  v_expiry    date;
  v_old_item  lot_items%ROWTYPE;
  v_old_cost  lot_costs%ROWTYPE;
  v_amount    numeric;
  v_type      text;
  v_changes   jsonb := '[]'::jsonb;
  v_units_all bigint;
  v_weight    numeric;
  v_other     numeric;
  v_bill_date date;
  v_out       integer;
  v_filled    integer;
BEGIN
  IF NOT staff_can('view_profit_costs') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  IF v_source IS NULL OR v_source NOT IN ('import', 'wholesale', 'local') THEN
    RAISE EXCEPTION 'Pick where the lot came from (import, wholesale or local).';
  END IF;
  IF v_currency NOT IN ('BDT', 'AUD', 'USD', 'CAD', 'JPY', 'KRW', 'INR', 'GBP') THEN
    RAISE EXCEPTION 'Unknown currency %.', v_currency;
  END IF;
  v_rate := CASE WHEN v_currency = 'BDT' THEN 1 ELSE NULLIF(p_lot ->> 'exchange_rate', '')::numeric END;
  IF v_rate IS NULL OR v_rate <= 0 THEN
    RAISE EXCEPTION 'Enter the exchange rate (taka for 1 %).', v_currency;
  END IF;
  IF v_date IS NULL THEN
    RAISE EXCEPTION 'Enter the lot date.';
  END IF;
  IF jsonb_typeof(v_items) <> 'array' OR jsonb_array_length(v_items) = 0 THEN
    RAISE EXCEPTION 'Add at least one product to the lot.';
  END IF;
  IF jsonb_typeof(v_costs) <> 'array' THEN
    RAISE EXCEPTION 'Costs must be a list.';
  END IF;

  -- The supplier from the list (the old text column keeps its name). A
  -- typed name with no list entry is linked when the name is in the list.
  IF v_supplier_id IS NOT NULL THEN
    SELECT name INTO v_supplier FROM suppliers WHERE id = v_supplier_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Supplier not found.';
    END IF;
  ELSIF v_supplier <> '' THEN
    SELECT id INTO v_supplier_id FROM suppliers WHERE lower(btrim(name)) = lower(v_supplier);
  END IF;

  IF v_is_new THEN
    PERFORM pg_advisory_xact_lock(hashtext('inventory_lot_code'));
    SELECT COALESCE(max(substring(code FROM 3)::integer), 0) + 1 INTO v_n
    FROM lots WHERE kind = 'purchase' AND code ~ '^L-[0-9]+$';
    v_code := 'L-' || CASE WHEN v_n < 1000 THEN lpad(v_n::text, 3, '0') ELSE v_n::text END;
    INSERT INTO lots (code, kind, source_type, country, supplier, supplier_id, lot_date, currency, exchange_rate,
                      costs_pending, notes, created_by, created_by_username)
    VALUES (v_code, 'purchase', v_source, btrim(COALESCE(p_lot ->> 'country', '')),
            v_supplier, v_supplier_id, v_date, v_currency, v_rate,
            COALESCE((p_lot ->> 'costs_pending')::boolean, false), COALESCE(p_lot ->> 'notes', ''),
            auth.uid(), current_actor_username())
    RETURNING id INTO v_id;
  ELSE
    SELECT * INTO v_lot FROM lots WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Lot not found.';
    END IF;
    IF v_lot.kind = 'opening' THEN
      RAISE EXCEPTION 'The opening lot can''t be edited here. Undo the opening stock and upload it again.';
    END IF;
    v_code := v_lot.code;
    IF v_lot.exchange_rate <> v_rate OR v_lot.currency <> v_currency THEN
      v_changes := v_changes || jsonb_build_object('field', 'exchange_rate',
        'from', v_lot.currency || ' ' || v_lot.exchange_rate, 'to', v_currency || ' ' || v_rate);
    END IF;
    UPDATE lots
    SET source_type = v_source,
        country = btrim(COALESCE(p_lot ->> 'country', '')),
        supplier = v_supplier,
        supplier_id = v_supplier_id,
        lot_date = v_date,
        currency = v_currency,
        exchange_rate = v_rate,
        costs_pending = COALESCE((p_lot ->> 'costs_pending')::boolean, false),
        notes = COALESCE(p_lot ->> 'notes', ''),
        updated_at = now()
    WHERE id = v_id;
  END IF;

  FOR v_old_cost IN
    SELECT c.* FROM lot_costs c
    WHERE c.lot_id = v_id
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_costs) x WHERE x ->> 'id' = c.id::text)
  LOOP
    DELETE FROM lot_costs WHERE id = v_old_cost.id;
    v_changes := v_changes || jsonb_build_object('cost', v_old_cost.cost_type, 'removed', v_old_cost.amount_bdt);
  END LOOP;

  FOR v_cost IN SELECT value FROM jsonb_array_elements(v_costs) LOOP
    v_type := v_cost ->> 'cost_type';
    v_amount := round(NULLIF(v_cost ->> 'amount_bdt', '')::numeric, 2);
    IF v_type IS NULL OR v_type NOT IN ('weight', 'other') THEN
      RAISE EXCEPTION 'Each cost must be a weight cost or an other cost.';
    END IF;
    IF v_amount IS NULL OR v_amount < 0 THEN
      RAISE EXCEPTION 'Cost amounts must be 0 or more.';
    END IF;
    SELECT * INTO v_old_cost FROM lot_costs
    WHERE id = NULLIF(v_cost ->> 'id', '')::uuid AND lot_id = v_id;
    IF FOUND THEN
      IF v_old_cost.amount_bdt <> v_amount OR v_old_cost.cost_type <> v_type THEN
        v_changes := v_changes || jsonb_build_object('cost', v_type, 'from', v_old_cost.amount_bdt, 'to', v_amount);
        v_bill_date := GREATEST(v_bill_date, NULLIF(v_cost ->> 'cost_date', '')::date);
      END IF;
      UPDATE lot_costs
      SET cost_type = v_type, amount_bdt = v_amount,
          cost_date = NULLIF(v_cost ->> 'cost_date', '')::date,
          note = COALESCE(v_cost ->> 'note', '')
      WHERE id = v_old_cost.id;
    ELSE
      INSERT INTO lot_costs (lot_id, cost_type, amount_bdt, cost_date, note, created_by)
      VALUES (v_id, v_type, v_amount, NULLIF(v_cost ->> 'cost_date', '')::date,
              COALESCE(v_cost ->> 'note', ''), auth.uid());
      IF NOT v_is_new THEN
        v_changes := v_changes || jsonb_build_object('cost', v_type, 'added', v_amount);
        v_bill_date := GREATEST(v_bill_date, NULLIF(v_cost ->> 'cost_date', '')::date);
      END IF;
    END IF;
  END LOOP;

  FOR v_old_item IN
    SELECT li.* FROM lot_items li
    WHERE li.lot_id = v_id
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_items) x WHERE x ->> 'id' = li.id::text)
  LOOP
    IF EXISTS (SELECT 1 FROM stock_movements m
               WHERE m.lot_item_id = v_old_item.id AND m.movement_type NOT IN ('opening', 'purchase')) THEN
      RAISE EXCEPTION 'Can''t remove "%": units from it were already sold or adjusted.',
        inventory_unit_label(v_old_item.product_id, v_old_item.variant_id);
    END IF;
    DELETE FROM lot_items WHERE id = v_old_item.id;
    v_changes := v_changes || jsonb_build_object('item_removed',
      inventory_unit_label(v_old_item.product_id, v_old_item.variant_id), 'qty', v_old_item.qty);
  END LOOP;

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_items) LOOP
    v_idx := v_idx + 1;
    v_row := format('Row %s', v_idx);
    v_pid := NULLIF(v_item ->> 'product_id', '')::uuid;
    v_vid := NULLIF(v_item ->> 'variant_id', '')::uuid;
    PERFORM inventory_check_unit(v_pid, v_vid, v_row);
    v_pack := inventory_pack_size(v_pid, v_vid);
    v_entry := CASE WHEN v_pack > 1 AND v_item ->> 'entry_unit' = 'unit' THEN 'unit' ELSE 'pack' END;
    v_qty := NULLIF(v_item ->> 'qty', '')::numeric;
    IF v_qty IS NULL OR v_qty <= 0 OR v_qty <> trunc(v_qty) OR v_qty > 1000000 THEN
      RAISE EXCEPTION '%: % must be a whole number above 0.', v_row, CASE WHEN v_entry = 'unit' THEN 'units' ELSE 'packs' END;
    END IF;
    v_units := (v_qty * CASE WHEN v_entry = 'pack' THEN v_pack ELSE 1 END)::integer;
    IF v_units > 100000000 THEN
      RAISE EXCEPTION '%: too many units.', v_row;
    END IF;
    v_price := NULLIF(v_item ->> 'unit_price_foreign', '')::numeric;
    IF v_price IS NULL OR v_price < 0 THEN
      RAISE EXCEPTION '%: enter the buy price.', v_row;
    END IF;
    v_grams := NULLIF(v_item ->> 'weight_grams', '')::numeric;
    IF v_grams IS NOT NULL AND (v_grams <= 0 OR v_grams > 100000) THEN
      RAISE EXCEPTION '%: weight must be between 1 and 100000 grams.', v_row;
    END IF;
    v_expiry := inventory_month_end(NULLIF(v_item ->> 'expiry_date', '')::date);

    SELECT * INTO v_old_item FROM lot_items
    WHERE id = NULLIF(v_item ->> 'id', '')::uuid AND lot_id = v_id;
    IF FOUND THEN
      IF (v_old_item.product_id <> v_pid OR v_old_item.variant_id IS DISTINCT FROM v_vid)
         AND EXISTS (SELECT 1 FROM stock_movements m
                     WHERE m.lot_item_id = v_old_item.id AND m.movement_type NOT IN ('opening', 'purchase')) THEN
        RAISE EXCEPTION '%: can''t change the product — units were already sold or adjusted.', v_row;
      END IF;
      v_out := v_old_item.qty - v_old_item.qty_remaining;
      IF v_units < v_out THEN
        RAISE EXCEPTION '%: can''t go below the % units already sold.', v_row, v_out;
      END IF;
      UPDATE lot_items
      SET product_id = v_pid, variant_id = v_vid, sort_order = v_idx, qty = v_units,
          entry_unit = v_entry, pack_size = v_pack,
          unit_price_foreign = round(v_price, 4), weight_grams_used = round(v_grams, 2), expiry_date = v_expiry
      WHERE id = v_old_item.id;
      IF v_old_item.qty <> v_units THEN
        INSERT INTO stock_movements (lot_item_id, movement_type, qty, reference, reason, created_by)
        VALUES (v_old_item.id, 'purchase', v_units - v_old_item.qty, v_code,
                format('Lot edited: units %s → %s', v_old_item.qty, v_units), auth.uid());
        v_changes := v_changes || jsonb_build_object('item', inventory_unit_label(v_pid, v_vid),
          'qty_from', v_old_item.qty, 'qty_to', v_units);
      END IF;
      IF v_old_item.unit_price_foreign <> round(v_price, 4) OR v_old_item.entry_unit <> v_entry THEN
        v_changes := v_changes || jsonb_build_object('item', inventory_unit_label(v_pid, v_vid),
          'price_from', v_old_item.unit_price_foreign, 'price_to', round(v_price, 4), 'per', v_entry);
      END IF;
    ELSE
      INSERT INTO lot_items (lot_id, product_id, variant_id, sort_order, qty, entry_unit, pack_size,
                             unit_price_foreign, weight_grams_used, expiry_date)
      VALUES (v_id, v_pid, v_vid, v_idx, v_units, v_entry, v_pack, round(v_price, 4), round(v_grams, 2), v_expiry)
      RETURNING id INTO v_item_id;
      INSERT INTO stock_movements (lot_item_id, movement_type, qty, reference, reason, created_by)
      VALUES (v_item_id, 'purchase', v_units, v_code, NULL, auth.uid());
      IF NOT v_is_new THEN
        v_changes := v_changes || jsonb_build_object('item_added', inventory_unit_label(v_pid, v_vid), 'qty', v_units);
      END IF;
    END IF;

    IF COALESCE((v_item ->> 'save_weight_to_product')::boolean, false) AND v_grams IS NOT NULL THEN
      PERFORM inventory_write_weight(v_pid, v_vid, v_grams);
    END IF;
  END LOOP;

  PERFORM inventory_allocate_lot(v_id, v_bill_date);
  -- New stock fills "sold without stock" units first (oldest first).
  v_filled := inventory_fill_shortfalls(v_id);

  SELECT COALESCE(sum(qty), 0) INTO v_units_all FROM lot_items WHERE lot_id = v_id;
  SELECT COALESCE(sum(amount_bdt) FILTER (WHERE cost_type = 'weight'), 0),
         COALESCE(sum(amount_bdt) FILTER (WHERE cost_type = 'other'), 0)
  INTO v_weight, v_other FROM lot_costs WHERE lot_id = v_id;

  IF v_is_new THEN
    PERFORM write_activity('inventory.lot_created', 'lot', v_id::text, v_code,
      format('Created lot %s: %s products, %s units, weight cost ৳%s, other costs ৳%s%s',
             v_code, jsonb_array_length(v_items), v_units_all, v_weight, v_other,
             CASE WHEN v_filled > 0 THEN format(', %s units filled sold-without-stock orders', v_filled) ELSE '' END),
      jsonb_build_object('pieces', v_units_all, 'weight_cost', v_weight, 'other_cost', v_other,
                         'currency', v_currency, 'exchange_rate', v_rate, 'supplier', v_supplier,
                         'shortfalls_filled', v_filled));
  ELSIF jsonb_array_length(v_changes) > 0 OR v_lot.costs_pending IS DISTINCT FROM COALESCE((p_lot ->> 'costs_pending')::boolean, false) THEN
    PERFORM write_activity(
      CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_changes) c WHERE c ? 'cost' OR c ->> 'field' = 'exchange_rate')
           THEN 'inventory.lot_cost_changed' ELSE 'inventory.lot_edited' END,
      'lot', v_id::text, v_code,
      format('Edited lot %s: weight cost ৳%s, other costs ৳%s, %s units', v_code, v_weight, v_other, v_units_all),
      jsonb_build_object('changes', v_changes, 'weight_cost', v_weight, 'other_cost', v_other, 'shortfalls_filled', v_filled));
  ELSE
    PERFORM write_activity('inventory.lot_edited', 'lot', v_id::text, v_code,
      format('Edited lot %s details', v_code), '{}'::jsonb);
  END IF;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION inventory_save_lot(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory_save_lot(jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- PART 11 — opening stock with pack sizes and loose units
-- ---------------------------------------------------------------------------
--   p_rows: [{ product_id, variant_id?, source, buy_price_bdt (per pack),
--              pieces (whole packs, 0 or more), extra_units? (loose units
--              from an opened pack), expiry?, weight_g? }]
--   units = pieces × pack size + extra_units (must be above 0).
--   Rows with the same product + expiry + source are merged: units added,
--   buy price per pack = average weighted by units.
--   buy value = units × price ÷ pack size; import rows add the weight %.
-- With pack size 1 and no loose units this is exactly Batch 38.
CREATE OR REPLACE FUNCTION inventory_confirm_opening(
  p_lot_date       date,
  p_weight_percent numeric,
  p_rows           jsonb,
  p_file_name      text DEFAULT ''
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id       uuid;
  v_row      jsonb;
  v_idx      integer;
  v_label    text;
  v_pid      uuid;
  v_vid      uuid;
  v_src      text;
  v_price    numeric;
  v_pieces   numeric;
  v_extra    numeric;
  v_pack     integer;
  v_units    numeric;
  v_grams    numeric;
  v_merged   record;
  v_item_id  uuid;
  v_sort     integer := 0;
  v_alloc    bigint;
  v_value    numeric;
  v_added    bigint := 0;
  v_total    numeric := 0;
  v_count    bigint := 0;
  v_current  numeric;
BEGIN
  IF NOT staff_can('view_profit_costs') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_lot_date IS NULL THEN
    RAISE EXCEPTION 'Pick the start date for the opening stock.';
  END IF;
  IF p_weight_percent IS NULL OR p_weight_percent < 0 OR p_weight_percent > 500 THEN
    RAISE EXCEPTION 'Enter the average weight %% (0 to 500).';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'The file has no rows to save.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('inventory_opening'));
  IF EXISTS (SELECT 1 FROM lots WHERE kind = 'opening') THEN
    RAISE EXCEPTION 'Opening stock was already saved (L-000). Undo it first to upload again.';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS inventory_opening_rows (
    ord integer, product_id uuid, variant_id uuid, source text, price numeric, pieces integer, expiry date, grams numeric
  ) ON COMMIT DROP;
  ALTER TABLE inventory_opening_rows ADD COLUMN IF NOT EXISTS units integer;
  ALTER TABLE inventory_opening_rows ADD COLUMN IF NOT EXISTS pack integer;
  TRUNCATE inventory_opening_rows;

  FOR v_row, v_idx IN SELECT value, ordinality FROM jsonb_array_elements(p_rows) WITH ORDINALITY LOOP
    v_label := format('Row %s', v_idx);
    v_pid := NULLIF(v_row ->> 'product_id', '')::uuid;
    v_vid := NULLIF(v_row ->> 'variant_id', '')::uuid;
    PERFORM inventory_check_unit(v_pid, v_vid, v_label);
    v_src := lower(btrim(COALESCE(v_row ->> 'source', '')));
    IF v_src NOT IN ('import', 'wholesale') THEN
      RAISE EXCEPTION '%: source must be import or wholesale.', v_label;
    END IF;
    v_price := NULLIF(v_row ->> 'buy_price_bdt', '')::numeric;
    IF v_price IS NULL OR v_price <= 0 THEN
      RAISE EXCEPTION '%: buy price must be above 0.', v_label;
    END IF;
    v_pieces := COALESCE(NULLIF(v_row ->> 'pieces', '')::numeric, 0);
    v_extra := COALESCE(NULLIF(v_row ->> 'extra_units', '')::numeric, 0);
    IF v_pieces < 0 OR v_pieces <> trunc(v_pieces) OR v_pieces > 1000000 THEN
      RAISE EXCEPTION '%: pieces must be a whole number above 0.', v_label;
    END IF;
    IF v_extra < 0 OR v_extra <> trunc(v_extra) OR v_extra > 100000000 THEN
      RAISE EXCEPTION '%: extra units must be a whole number (0 or more).', v_label;
    END IF;
    v_pack := inventory_pack_size(v_pid, v_vid);
    v_units := v_pieces * v_pack + v_extra;
    IF v_units <= 0 THEN
      RAISE EXCEPTION '%: pieces must be a whole number above 0.', v_label;
    END IF;
    IF v_units > 100000000 THEN
      RAISE EXCEPTION '%: too many units.', v_label;
    END IF;
    v_grams := NULLIF(v_row ->> 'weight_g', '')::numeric;
    IF v_grams IS NOT NULL AND (v_grams <= 0 OR v_grams > 100000) THEN
      RAISE EXCEPTION '%: weight must be between 1 and 100000 grams.', v_label;
    END IF;
    INSERT INTO inventory_opening_rows (ord, product_id, variant_id, source, price, pieces, expiry, grams, units, pack)
    VALUES (v_idx, v_pid, v_vid, v_src, round(v_price, 4), v_pieces::integer,
            inventory_month_end(NULLIF(v_row ->> 'expiry', '')::date), round(v_grams, 2), v_units::integer, v_pack);
  END LOOP;

  INSERT INTO lots (code, kind, source_type, lot_date, currency, exchange_rate, notes,
                    opening_weight_percent, created_by, created_by_username)
  VALUES ('L-000', 'opening', NULL, p_lot_date, 'BDT', 1,
          'Opening stock' || CASE WHEN COALESCE(p_file_name, '') <> '' THEN ' from ' || left(p_file_name, 120) ELSE '' END,
          p_weight_percent, auth.uid(), current_actor_username())
  RETURNING id INTO v_id;

  FOR v_merged IN
    SELECT r.product_id, r.variant_id, r.source, r.expiry,
           sum(r.units)::integer AS units,
           max(r.pack) AS pack,
           round(sum(r.units * r.price) / sum(r.units), 4) AS price,
           max(r.grams) AS grams
    FROM inventory_opening_rows r
    GROUP BY r.product_id, r.variant_id, r.source, r.expiry
    ORDER BY min(r.ord)
  LOOP
    v_sort := v_sort + 1;
    -- Buy value of the row (4 decimals) and the % on an imported row, in
    -- whole paisa for the whole row.
    v_value := round(v_merged.units * v_merged.price / v_merged.pack, 4);
    v_alloc := CASE WHEN v_merged.source = 'import'
                    THEN round(v_merged.units * v_merged.price * p_weight_percent / v_merged.pack)::bigint
                    ELSE 0 END;
    v_added := v_added + v_alloc;

    IF v_merged.variant_id IS NULL THEN
      SELECT weight_grams INTO v_current FROM products WHERE id = v_merged.product_id;
    ELSE
      SELECT weight_grams INTO v_current FROM product_variants WHERE id = v_merged.variant_id;
    END IF;
    IF v_merged.grams IS NOT NULL AND v_merged.grams IS DISTINCT FROM v_current THEN
      PERFORM inventory_write_weight(v_merged.product_id, v_merged.variant_id, v_merged.grams);
    END IF;

    INSERT INTO lot_items (lot_id, product_id, variant_id, sort_order, qty, entry_unit, pack_size,
                           unit_price_foreign, unit_price_bdt, buy_value_bdt,
                           weight_grams_used, expiry_date, alloc_weight_paisa, alloc_other_paisa,
                           alloc_weight_bdt, alloc_other_bdt, landed_unit_cost_bdt, opening_source)
    VALUES (v_id, v_merged.product_id, v_merged.variant_id, v_sort, v_merged.units, 'unit', v_merged.pack,
            v_merged.price, round(v_merged.price / v_merged.pack, 4), v_value,
            COALESCE(v_merged.grams, v_current), v_merged.expiry, v_alloc, 0,
            round(v_alloc::numeric / v_merged.units / 100, 6), 0,
            round(v_value / v_merged.units + v_alloc::numeric / v_merged.units / 100, 6), v_merged.source)
    RETURNING id INTO v_item_id;

    INSERT INTO stock_movements (lot_item_id, movement_type, qty, reference, reason, created_by)
    VALUES (v_item_id, 'opening', v_merged.units, 'L-000', 'Opening stock', auth.uid());

    v_count := v_count + v_merged.units;
    v_total := v_total + v_value;
  END LOOP;

  UPDATE lots SET opening_weight_added_bdt = v_added::numeric / 100 WHERE id = v_id;

  -- Opening stock fills "sold without stock" units first (oldest first).
  PERFORM inventory_fill_shortfalls(v_id);

  PERFORM write_activity('inventory.opening_confirmed', 'lot', v_id::text, 'L-000',
    format('Saved opening stock L-000: %s rows, %s units, value ৳%s (weight added ৳%s at %s%%)',
           v_sort, v_count, round(v_total + v_added::numeric / 100, 2), v_added::numeric / 100, p_weight_percent),
    jsonb_build_object('rows', v_sort, 'pieces', v_count, 'buy_value', round(v_total, 2),
                       'weight_added', v_added::numeric / 100, 'weight_percent', p_weight_percent,
                       'lot_date', p_lot_date, 'file', left(COALESCE(p_file_name, ''), 120)));
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION inventory_confirm_opening(date, numeric, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory_confirm_opening(date, numeric, jsonb, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- PART 12 — Returned
-- ---------------------------------------------------------------------------
-- An order that went out (In transit or Delivered) and came back. Its goods
-- go back to stock: to the same lot rows (orders_inventory_released
-- trigger), and while Inventory mode is Off the shop's stock number goes
-- back up like a cancel. Damaged returns are written off later (Batch 40).
CREATE OR REPLACE FUNCTION admin_mark_order_returned(p_order_id uuid, p_note text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order orders%ROWTYPE;
  v_line  record;
BEGIN
  IF NOT staff_can('change_order_status') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;
  IF v_order.status NOT IN ('shipped', 'delivered') THEN
    RAISE EXCEPTION 'Only an order that was sent (In transit or Delivered) can be marked returned.';
  END IF;

  IF NOT v_order.stock_released AND NOT inventory_mode_on() THEN
    PERFORM set_config('app.order_stock_change', 'on', true);
    FOR v_line IN SELECT * FROM order_items WHERE order_id = p_order_id AND sold_unit IS NULL LOOP
      IF v_line.variant_id IS NOT NULL THEN
        UPDATE product_variants SET stock_quantity = stock_quantity + v_line.quantity
          WHERE id = v_line.variant_id AND stock_quantity IS NOT NULL;
      ELSIF v_line.product_id IS NOT NULL THEN
        UPDATE products SET stock_quantity = stock_quantity + v_line.quantity
          WHERE id = v_line.product_id AND stock_quantity IS NOT NULL;
      END IF;
    END LOOP;
    PERFORM set_config('app.order_stock_change', 'off', true);
  END IF;

  UPDATE orders SET status = 'returned', stock_released = true, updated_at = now() WHERE id = p_order_id;
  INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, note)
  VALUES (p_order_id, v_order.status, 'returned', auth.uid(), NULLIF(btrim(COALESCE(p_note, '')), ''));
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION admin_mark_order_returned(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_mark_order_returned(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- PART 13 — profit
-- ---------------------------------------------------------------------------
-- Per order line: cost of goods = units still out × locked cost, plus open
-- "sold without stock" units at their provisional cost. costed = the line
-- took (or tried to take) stock from lots at all.
CREATE OR REPLACE FUNCTION inventory_item_costs(p_order_ids uuid[])
RETURNS TABLE (
  order_item_id uuid, order_id uuid, product_id uuid, variant_id uuid, label text,
  line_total numeric, units integer, cost numeric, provisional numeric, costed boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT oi.id, oi.order_id, oi.product_id, oi.variant_id,
         oi.product_name || COALESCE(' — ' || oi.variant_label, ''),
         oi.line_total,
         (COALESCE(l.units, 0) + COALESCE(s.units, 0))::integer,
         round(COALESCE(l.cost, 0), 2) + round(COALESCE(s.cost, 0), 2),
         round(COALESCE(s.cost, 0), 2),
         (l.n > 0 OR s.n > 0 OR EXISTS (SELECT 1 FROM stock_shortfalls x WHERE x.order_item_id = oi.id))
  FROM order_items oi
  LEFT JOIN LATERAL (
    SELECT count(*) AS n, sum(units - units_back) AS units, sum((units - units_back) * unit_cost_bdt) AS cost
    FROM order_item_lots WHERE order_item_id = oi.id
  ) l ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS n, sum(units) AS units, sum(units * provisional_unit_cost_bdt) AS cost
    FROM stock_shortfalls WHERE order_item_id = oi.id AND status = 'open'
  ) s ON true
  WHERE oi.order_id = ANY (p_order_ids);
$$;

REVOKE ALL ON FUNCTION inventory_item_costs(uuid[]) FROM PUBLIC, anon, authenticated;

-- When an order's profit counts: the last time it became Delivered (or
-- Returned). NULL for any other status.
CREATE OR REPLACE FUNCTION inventory_order_counted_at(p_order_id uuid, p_status text)
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE WHEN p_status IN ('delivered', 'returned') THEN
    COALESCE((SELECT max(h.changed_at) FROM order_status_history h
              WHERE h.order_id = p_order_id AND h.new_status = p_status AND h.old_status IS DISTINCT FROM p_status),
             (SELECT updated_at FROM orders WHERE id = p_order_id))
  END;
$$;

REVOKE ALL ON FUNCTION inventory_order_counted_at(uuid, text) FROM PUBLIC, anon, authenticated;

-- One order's profit (the order page's Profit box).
--   sale       = items after item and order discounts (subtotal − discount)
--   cost       = cost of goods (locked when stock left; open shortfalls at
--                their provisional cost)
--   delivery   = the delivery fee the customer was charged
--   courier    = what the courier kept (order_courier_costs, Batch 36):
--                delivery charge + COD fee + anything else
--   profit     = sale − cost + delivery − courier
-- Returned: sale 0, cost 0 (goods came back), delivery 0, courier as
-- recorded. Cancelled: nothing.
CREATE OR REPLACE FUNCTION order_profit(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order    orders%ROWTYPE;
  v_courier  order_courier_costs%ROWTYPE;
  v_known    boolean;
  v_sale     numeric;
  v_cost     numeric;
  v_prov     numeric;
  v_costed   boolean;
  v_delivery numeric;
  v_kept     numeric;
  v_profit   numeric;
  v_filled   numeric;
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

  SELECT COALESCE(sum(c.cost), 0), COALESCE(sum(c.provisional), 0), COALESCE(bool_and(c.costed), false)
  INTO v_cost, v_prov, v_costed
  FROM inventory_item_costs(ARRAY[p_order_id]) c;

  SELECT COALESCE(sum(amount_bdt), 0) INTO v_filled
  FROM cost_adjustments WHERE order_id = p_order_id AND reason IN ('shortfall_filled', 'given_back');

  IF v_order.status = 'cancelled' THEN
    v_sale := 0; v_cost := 0; v_prov := 0; v_delivery := 0; v_kept := 0;
  ELSIF v_order.status = 'returned' THEN
    v_sale := 0; v_cost := 0; v_prov := 0; v_delivery := 0;
    v_kept := CASE WHEN v_known THEN v_courier.total_kept ELSE 0 END;
  ELSE
    v_sale := GREATEST(v_order.subtotal - v_order.discount, 0);
    v_delivery := v_order.delivery_fee;
    v_kept := CASE WHEN v_known THEN v_courier.total_kept ELSE 0 END;
  END IF;
  v_profit := v_sale - v_cost + v_delivery - v_kept;

  RETURN jsonb_build_object(
    'status', v_order.status,
    'costed', v_costed OR v_order.status IN ('cancelled', 'returned'),
    'sale', v_sale,
    'cost', v_cost,
    'provisional', v_prov,
    'delivery', v_delivery,
    'courier', v_kept,
    'courier_known', v_known,
    'courier_charge', CASE WHEN v_known THEN v_courier.delivery_charge + v_courier.other_deduction ELSE 0 END,
    'cod_fee', CASE WHEN v_known THEN v_courier.cod_fee ELSE 0 END,
    'profit', v_profit,
    'margin', CASE WHEN v_sale > 0 THEN round(v_profit / v_sale * 100, 1) END,
    'counted_at', inventory_order_counted_at(p_order_id, v_order.status),
    'filled_adjustments', v_filled
  );
END;
$$;

REVOKE ALL ON FUNCTION order_profit(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION order_profit(uuid) TO authenticated;

-- Sales profit for a date range (Dhaka dates, both ends included). Orders
-- count on the day they became Delivered (or Returned). Orders with no lot
-- cost (delivered before Inventory mode) are listed but left out of the
-- totals and the per-product table. The order discount is shared over the
-- lines by line total (whole paisa, largest remainder), so the per-product
-- sales add up exactly to the orders' sales.
CREATE OR REPLACE FUNCTION inventory_sales_profit(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ids      uuid[];
  v_orders   jsonb;
  v_products jsonb;
  v_adjust   jsonb;
  v_totals   jsonb;
  v_adj_sum  numeric;
BEGIN
  IF NOT staff_can('view_profit_costs') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION 'Pick a date range.';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _sp_orders (
    id uuid, order_number text, status text, counted_at timestamptz, sale numeric, discount numeric,
    delivery numeric, courier numeric, courier_known boolean, cost numeric, provisional numeric, costed boolean
  ) ON COMMIT DROP;
  TRUNCATE _sp_orders;

  INSERT INTO _sp_orders (id, order_number, status, counted_at, sale, discount, delivery, courier, courier_known)
  SELECT o.id, o.order_number, o.status, x.at,
         CASE WHEN o.status = 'delivered' THEN GREATEST(o.subtotal - o.discount, 0) ELSE 0 END,
         o.discount,
         CASE WHEN o.status = 'delivered' THEN o.delivery_fee ELSE 0 END,
         COALESCE(cc.total_kept, 0), cc.order_id IS NOT NULL
  FROM orders o
  CROSS JOIN LATERAL (SELECT inventory_order_counted_at(o.id, o.status) AS at) x
  LEFT JOIN order_courier_costs cc ON cc.order_id = o.id
  WHERE o.status IN ('delivered', 'returned')
    AND (x.at AT TIME ZONE 'Asia/Dhaka')::date BETWEEN p_from AND p_to;

  SELECT COALESCE(array_agg(id), '{}') INTO v_ids FROM _sp_orders;

  CREATE TEMP TABLE IF NOT EXISTS _sp_items (
    order_item_id uuid, order_id uuid, product_id uuid, variant_id uuid, label text, line_total numeric,
    units integer, cost numeric, provisional numeric, costed boolean
  ) ON COMMIT DROP;
  TRUNCATE _sp_items;
  INSERT INTO _sp_items SELECT * FROM inventory_item_costs(v_ids);

  UPDATE _sp_orders o
  SET cost = CASE WHEN o.status = 'delivered' THEN COALESCE(i.cost, 0) ELSE 0 END,
      provisional = CASE WHEN o.status = 'delivered' THEN COALESCE(i.provisional, 0) ELSE 0 END,
      costed = COALESCE(i.costed, false)
  FROM (
    SELECT order_id, sum(cost) AS cost, sum(provisional) AS provisional, bool_and(costed) AS costed
    FROM _sp_items GROUP BY order_id
  ) i
  WHERE i.order_id = o.id;
  -- (Orders with no lines at all. A WHERE is required: the API refuses an
  -- UPDATE without one.)
  UPDATE _sp_orders SET cost = COALESCE(cost, 0), provisional = COALESCE(provisional, 0), costed = COALESCE(costed, false)
  WHERE cost IS NULL OR provisional IS NULL OR costed IS NULL;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'order_id', id, 'order_number', order_number, 'status', status, 'counted_at', counted_at,
           'sale', sale, 'cost', cost, 'provisional', provisional, 'delivery', delivery,
           'courier', courier, 'courier_known', courier_known, 'costed', costed,
           'profit', sale - cost + delivery - courier,
           'margin', CASE WHEN sale > 0 THEN round((sale - cost + delivery - courier) / sale * 100, 1) END)
         ORDER BY counted_at DESC, order_number DESC), '[]'::jsonb)
  INTO v_orders FROM _sp_orders;

  -- Per product: delivered, costed orders only.
  WITH lines AS (
    SELECT i.*, o.discount AS order_discount, o.id AS oid
    FROM _sp_items i JOIN _sp_orders o ON o.id = i.order_id
    WHERE o.status = 'delivered' AND o.costed
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
  FROM cost_adjustments WHERE adj_date BETWEEN p_from AND p_to;

  SELECT jsonb_build_object(
           'orders', count(*) FILTER (WHERE costed),
           'uncosted_orders', count(*) FILTER (WHERE NOT costed),
           'sales', COALESCE(sum(sale) FILTER (WHERE costed), 0),
           'cost', COALESCE(sum(cost) FILTER (WHERE costed), 0),
           'provisional', COALESCE(sum(provisional) FILTER (WHERE costed), 0),
           'delivery', COALESCE(sum(delivery) FILTER (WHERE costed), 0),
           'courier', COALESCE(sum(courier) FILTER (WHERE costed), 0),
           'adjustments', v_adj_sum)
  INTO v_totals FROM _sp_orders;

  v_totals := v_totals || jsonb_build_object(
    'profit', (v_totals ->> 'sales')::numeric - (v_totals ->> 'cost')::numeric + (v_totals ->> 'delivery')::numeric
              - (v_totals ->> 'courier')::numeric - v_adj_sum);
  v_totals := v_totals || jsonb_build_object(
    'margin', CASE WHEN (v_totals ->> 'sales')::numeric > 0
                   THEN round((v_totals ->> 'profit')::numeric / (v_totals ->> 'sales')::numeric * 100, 1) END);

  RETURN jsonb_build_object('from', p_from, 'to', p_to, 'totals', v_totals,
                            'orders', v_orders, 'products', v_products, 'adjustments', v_adjust);
END;
$$;

REVOKE ALL ON FUNCTION inventory_sales_profit(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory_sales_profit(date, date) TO authenticated;

-- "Sold without stock": open and filled shortfalls with their order.
CREATE OR REPLACE FUNCTION inventory_shortfall_list()
RETURNS TABLE (
  id uuid, order_id uuid, order_number text, label text, units integer, stock_unit text,
  provisional_unit_cost numeric, status text, real_unit_cost numeric, filled_lot_code text,
  created_at timestamptz, filled_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT staff_can('view_profit_costs') THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT s.id, s.order_id, o.order_number,
         oi.product_name || COALESCE(' — ' || oi.variant_label, ''),
         s.units, inventory_stock_unit(s.product_id, s.variant_id),
         s.provisional_unit_cost_bdt, s.status, s.real_unit_cost_bdt, l.code, s.created_at, s.filled_at
  FROM stock_shortfalls s
  JOIN orders o ON o.id = s.order_id
  JOIN order_items oi ON oi.id = s.order_item_id
  LEFT JOIN lot_items li ON li.id = s.filled_lot_item_id
  LEFT JOIN lots l ON l.id = li.lot_id
  WHERE s.status IN ('open', 'filled')
  ORDER BY (s.status = 'open') DESC, s.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION inventory_shortfall_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory_shortfall_list() TO authenticated;

-- ---------------------------------------------------------------------------
-- PART 14 — turning Inventory mode On / Off
-- ---------------------------------------------------------------------------
-- The check screen: is the opening stock confirmed, and the open orders
-- placed before Inventory mode (their goods are not in any lot yet).
CREATE OR REPLACE FUNCTION inventory_mode_check()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_open jsonb;
BEGIN
  IF NOT staff_can('view_profit_costs') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('order_number', o.order_number, 'status', o.status,
                                               'units', (SELECT sum(quantity) FROM order_items WHERE order_id = o.id))
                            ORDER BY o.created_at), '[]'::jsonb)
  INTO v_open
  FROM orders o
  WHERE o.status IN ('pending', 'confirmed') AND NOT o.stock_released
    AND NOT EXISTS (SELECT 1 FROM order_item_lots x WHERE x.order_id = o.id)
    AND NOT EXISTS (SELECT 1 FROM stock_shortfalls x WHERE x.order_id = o.id);
  RETURN jsonb_build_object(
    'mode_on', COALESCE((SELECT value FROM app_settings WHERE key = 'inventory_mode'), 'false') = 'true',
    'opening_confirmed', EXISTS (SELECT 1 FROM lots WHERE kind = 'opening'),
    'open_orders', v_open);
END;
$$;

REVOKE ALL ON FUNCTION inventory_mode_check() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory_mode_check() TO authenticated;

-- The switch. Super Admin only, with the password re-confirmed in the last
-- 5 minutes (the same check as the Safety Lock). On needs the opening
-- stock (L-000). Turning On:
--   p_take_open_orders = true → orders still Processing / Confirmed that
--     were placed before take their units now (their goods were still on
--     the shelf when the opening stock was counted); missing units are
--     recorded as "sold without stock";
--   then every product's stock number is set from the lots.
-- Turning Off: sales stop taking stock from lots; stock numbers keep their
-- last value. Both are written to the Activity Log.
CREATE OR REPLACE FUNCTION inventory_set_mode(p_on boolean, p_take_open_orders boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_password_at bigint;
  v_was_on      boolean := COALESCE((SELECT value FROM app_settings WHERE key = 'inventory_mode'), 'false') = 'true';
  v_order       record;
  v_item        order_items%ROWTYPE;
  v_orders      integer := 0;
  v_short       integer;
  v_units       integer := 0;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Only the Super Admin can change Inventory mode.';
  END IF;
  SELECT max((e ->> 'timestamp')::bigint) INTO v_password_at
  FROM jsonb_array_elements(COALESCE(auth.jwt() -> 'amr', '[]'::jsonb)) e
  WHERE e ->> 'method' = 'password';
  IF v_password_at IS NULL OR v_password_at < extract(epoch FROM now())::bigint - 300 THEN
    RAISE EXCEPTION 'Please confirm your password again.';
  END IF;
  IF p_on IS NULL THEN
    RAISE EXCEPTION 'Choose On or Off.';
  END IF;
  IF p_on = v_was_on THEN
    RETURN jsonb_build_object('changed', false, 'mode_on', v_was_on);
  END IF;
  IF p_on AND NOT EXISTS (SELECT 1 FROM lots WHERE kind = 'opening') THEN
    RAISE EXCEPTION 'Inventory mode can be turned On only after the opening stock (L-000) is confirmed.';
  END IF;

  PERFORM set_config('inventory.mode_change', 'on', true);
  PERFORM set_config('app.activity_quiet', 'on', true);
  INSERT INTO app_settings (key, value) VALUES ('inventory_mode', CASE WHEN p_on THEN 'true' ELSE 'false' END)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
  PERFORM set_config('app.activity_quiet', '', true);
  PERFORM set_config('inventory.mode_change', '', true);

  IF p_on THEN
    IF COALESCE(p_take_open_orders, true) THEN
      PERFORM set_config('inventory.short_ok', 'on', true);
      FOR v_order IN
        SELECT o.id, o.order_number FROM orders o
        WHERE o.status IN ('pending', 'confirmed') AND NOT o.stock_released
          AND NOT EXISTS (SELECT 1 FROM order_item_lots x WHERE x.order_id = o.id)
          AND NOT EXISTS (SELECT 1 FROM stock_shortfalls x WHERE x.order_id = o.id)
        ORDER BY o.created_at
        FOR UPDATE OF o
      LOOP
        FOR v_item IN SELECT * FROM order_items WHERE order_id = v_order.id ORDER BY id LOOP
          PERFORM inventory_take_units(v_item, v_item.quantity * inventory_item_factor(v_item), v_order.order_number);
        END LOOP;
        v_orders := v_orders + 1;
      END LOOP;
      PERFORM set_config('inventory.short_ok', '', true);
    END IF;
    PERFORM inventory_sync_all();
  END IF;

  SELECT count(*) INTO v_short FROM stock_shortfalls WHERE status = 'open';
  SELECT COALESCE(sum(qty_remaining), 0) INTO v_units FROM lot_items;

  PERFORM write_activity(CASE WHEN p_on THEN 'inventory.mode_on' ELSE 'inventory.mode_off' END,
    'setting', 'inventory_mode', 'Inventory mode',
    CASE WHEN p_on
         THEN format('Turned Inventory mode ON: stock numbers now come from lots (%s units). %s open orders took their stock.',
                     v_units, v_orders)
         ELSE 'Turned Inventory mode OFF: sales stop taking stock from lots; profit will be missing for orders while Off.' END,
    jsonb_build_object('mode_on', p_on, 'open_orders_taken', v_orders, 'open_shortfalls', v_short, 'units_in_lots', v_units));

  RETURN jsonb_build_object('changed', true, 'mode_on', p_on, 'open_orders_taken', v_orders, 'open_shortfalls', v_short);
END;
$$;

REVOKE ALL ON FUNCTION inventory_set_mode(boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory_set_mode(boolean, boolean) TO authenticated;

COMMIT;
