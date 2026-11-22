-- ============================================================
-- Batch 55.1 — one-time fix: the real pack size of 5 products that
-- already have stock and sales (safe conversion)
-- ============================================================
-- Run ONCE in the Supabase SQL Editor, AFTER
-- supabase/migration-057-batch55-1.sql (file 1).
--
-- These 5 products were counted with pack size 1 (1 unit = 1 bottle).
-- This file restates them so 1 unit = 1 ml / 1 capsule:
--   - every quantity in units × pack size (lot rows, stock moves, units
--     taken / given back by orders, "sold without stock" units, units
--     taken before Inventory mode);
--   - every cost per unit ÷ pack size (lot buy price, share of the lot's
--     other costs, landed cost, cost of units taken, provisional / real
--     cost of units sold without stock, buying price);
--   - every amount of money unchanged (lot totals, order lines, the stored
--     cost of each order line, payments, expenses, profit);
--   - the order lines themselves unchanged (they were sold as whole packs).
-- Lot rows become "entered by pack" with the same price per pack, which is
-- exactly how a lot of this product would be saved today.
--
-- Safety: one transaction. Before and after each product: shop stock in
-- packs, stock value, cost of everything sold. Before and after all of
-- them: Money's net worth (money_position), stock value, sales profit for
-- all time (Reports and Money), customer money totals. If anything is not
-- the same to the paisa, the file stops with a message and changes
-- nothing. A product already converted says "Already done": running the
-- file twice changes nothing the second time.
-- ============================================================

BEGIN;

-- The SQL Editor has no signed-in user: act as the Super Admin.
SELECT set_config('request.jwt.claims',
  (SELECT json_build_object('sub', p.id, 'role', 'authenticated', 'aal', 'aal2')::text
   FROM profiles p WHERE p.role = 'admin' AND p.status = 'approved'
   ORDER BY p.created_at, p.id LIMIT 1),
  true) IS NOT NULL AS acting_as_super_admin;

-- ==== helpers start ====
-- (Temporary functions: they exist only while this file runs.)

-- The site's money totals that must not move.
CREATE OR REPLACE FUNCTION pg_temp.b551_totals()
RETURNS jsonb
LANGUAGE plpgsql
AS $f$
DECLARE
  v_mp    jsonb := money_position();
  v_today date := inventory_dhaka_today();
  v_rep   jsonb := inventory_sales_profit_core(DATE '2000-01-01', v_today, false) -> 'totals';
  v_mon   jsonb := inventory_sales_profit_core(DATE '2000-01-01', v_today, true) -> 'totals';
BEGIN
  RETURN jsonb_build_object(
    'net_worth', round((v_mp ->> 'net_worth')::numeric, 2),
    'have', round((v_mp ->> 'have')::numeric, 2),
    'owe', round((v_mp ->> 'owe')::numeric, 2),
    'stock_value', round((v_mp ->> 'stock_value')::numeric, 2),
    'goods_on_open_orders', round((v_mp ->> 'goods_on_open_orders')::numeric, 2),
    'sold_without_stock', round((v_mp ->> 'sold_without_stock')::numeric, 2),
    'money_check_difference', round(COALESCE((v_mp ->> 'difference')::numeric, 0), 2),
    'reports_sales', round((v_rep ->> 'sales')::numeric, 2),
    'reports_cost', round((v_rep ->> 'cost')::numeric, 2),
    'reports_provisional', round((v_rep ->> 'provisional')::numeric, 2),
    'reports_profit', round((v_rep ->> 'profit')::numeric, 2),
    'money_sales', round((v_mon ->> 'sales')::numeric, 2),
    'money_cost', round((v_mon ->> 'cost')::numeric, 2),
    'money_profit', round((v_mon ->> 'profit')::numeric, 2),
    'customers', customer_money_totals());
END;
$f$;

-- One product's stock and cost, in packs and taka (units only to compare).
CREATE OR REPLACE FUNCTION pg_temp.b551_unit(p_product_id uuid)
RETURNS jsonb
LANGUAGE sql
AS $f$
  SELECT jsonb_build_object(
    'shop_packs', (SELECT stock_quantity FROM products WHERE id = p_product_id),
    'units_left', inventory_units_left(p_product_id, NULL),
    'lot_buy_value', (SELECT round(COALESCE(sum(buy_value_bdt), 0), 2) FROM lot_items
                      WHERE product_id = p_product_id AND variant_id IS NULL),
    'lot_other_paisa', (SELECT COALESCE(sum(alloc_other_paisa), 0) FROM lot_items
                        WHERE product_id = p_product_id AND variant_id IS NULL),
    'stock_value', (SELECT round(COALESCE(sum(qty_remaining * landed_unit_cost_bdt), 0), 2) FROM lot_items
                    WHERE product_id = p_product_id AND variant_id IS NULL),
    'taken_cost', (SELECT round(COALESCE(sum((o.units - o.units_back) * o.unit_cost_bdt + o.adjust_bdt), 0), 2)
                   FROM order_item_lots o JOIN lot_items li ON li.id = o.lot_item_id
                   WHERE li.product_id = p_product_id AND li.variant_id IS NULL),
    'sold_cost', (SELECT round(COALESCE(sum(c.unit_cost_bdt * oi.quantity), 0), 2)
                  FROM order_items oi JOIN order_item_costs c ON c.order_item_id = oi.id
                  WHERE oi.product_id = p_product_id AND oi.variant_id IS NULL),
    'shortfall_cost', (SELECT round(COALESCE(sum(s.units * s.provisional_unit_cost_bdt), 0), 2)
                       FROM stock_shortfalls s WHERE s.product_id = p_product_id AND s.variant_id IS NULL),
    'shortfall_real_cost', (SELECT round(COALESCE(sum(s.units * s.real_unit_cost_bdt), 0), 2)
                            FROM stock_shortfalls s WHERE s.product_id = p_product_id AND s.variant_id IS NULL),
    'buying_price_per_pack', (SELECT round(b.unit_cost_bdt * p.pack_size, 2)
                              FROM product_buying_prices b JOIN products p ON p.id = b.product_id
                              WHERE b.product_id = p_product_id AND b.variant_id IS NULL));
$f$;

-- Convert one product (no options) from pack size 1 to p_pack.
-- Returns 'Converted', 'Already done' or why it was left out.
CREATE OR REPLACE FUNCTION pg_temp.b551_convert(p_product_id uuid, p_unit text, p_pack integer, p_name text)
RETURNS text
LANGUAGE plpgsql
AS $f$
DECLARE
  v_p      products%ROWTYPE;
  v_before jsonb;
  v_after  jsonb;
  v_rows   uuid[];
BEGIN
  SELECT * INTO v_p FROM products WHERE id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'Left out: product not found';
  END IF;
  IF lower(btrim(v_p.name)) <> lower(btrim(p_name)) THEN
    RETURN format('Left out: its name is now "%s"', v_p.name);
  END IF;
  IF EXISTS (SELECT 1 FROM product_variants WHERE product_id = p_product_id) THEN
    RETURN 'Left out: it has options';
  END IF;
  IF v_p.pack_size = p_pack AND v_p.stock_unit = p_unit THEN
    RETURN 'Already done';
  END IF;
  IF v_p.pack_size <> 1 THEN
    RETURN format('Left out: its pack size is already %s', v_p.pack_size);
  END IF;
  IF EXISTS (SELECT 1 FROM order_items WHERE product_id = p_product_id AND sold_unit IS NOT NULL) THEN
    RETURN 'Left out: it has lines sold in loose units';
  END IF;
  IF EXISTS (SELECT 1 FROM stock_write_offs WHERE product_id = p_product_id)
     OR EXISTS (SELECT 1 FROM stock_counts WHERE product_id = p_product_id)
     OR EXISTS (SELECT 1 FROM order_item_unstocked u JOIN order_items oi ON oi.id = u.order_item_id
                WHERE oi.product_id = p_product_id) THEN
    RETURN 'Left out: it has write-offs, stock counts or unstocked units';
  END IF;

  v_before := pg_temp.b551_unit(p_product_id);
  SELECT COALESCE(array_agg(id), '{}') INTO v_rows FROM lot_items WHERE product_id = p_product_id AND variant_id IS NULL;

  -- Not a staff edit of the product: no automatic Activity Log line (one
  -- line is written below).
  PERFORM set_config('app.activity_quiet', 'on', true);

  UPDATE products SET stock_unit = p_unit, pack_size = p_pack WHERE id = p_product_id;

  -- Lot rows: units × N; the same price per pack (entered by pack); the
  -- same buy value and the same share of the lot's other costs in paisa;
  -- costs per unit from those, as inventory_allocate_lot() works them out.
  UPDATE lot_items
  SET qty = qty * p_pack,
      entry_unit = 'pack',
      pack_size = p_pack,
      unit_price_bdt = round(buy_value_bdt / (qty * p_pack), 4),
      alloc_weight_bdt = round(alloc_weight_paisa::numeric / (qty * p_pack) / 100, 6),
      alloc_other_bdt = round(alloc_other_paisa::numeric / (qty * p_pack) / 100, 6),
      landed_unit_cost_bdt = round(buy_value_bdt / (qty * p_pack) + alloc_other_paisa::numeric / (qty * p_pack) / 100, 6)
  WHERE id = ANY (v_rows);

  -- Stock moves (qty_remaining follows them).
  UPDATE stock_movements SET qty = qty * p_pack WHERE lot_item_id = ANY (v_rows);

  -- Units taken by orders and given back; the cost per unit when taken.
  -- adjust_bdt is an amount for the whole row: unchanged.
  UPDATE order_item_lots
  SET units = units * p_pack,
      units_back = units_back * p_pack,
      unit_cost_bdt = round(unit_cost_bdt / p_pack, 6)
  WHERE lot_item_id = ANY (v_rows);

  -- Units sold without stock.
  UPDATE stock_shortfalls
  SET units = units * p_pack,
      provisional_unit_cost_bdt = round(provisional_unit_cost_bdt / p_pack, 6),
      real_unit_cost_bdt = round(real_unit_cost_bdt / p_pack, 6)
  WHERE product_id = p_product_id AND variant_id IS NULL;

  -- Units taken from the stock number before Inventory mode (given back
  -- into the opening lot if such an order is ever cancelled).
  UPDATE order_items SET pre_inventory_units = pre_inventory_units * p_pack
  WHERE product_id = p_product_id AND variant_id IS NULL AND pre_inventory_units > 0;

  -- Buying price per unit.
  UPDATE product_buying_prices SET unit_cost_bdt = round(unit_cost_bdt / p_pack, 6)
  WHERE product_id = p_product_id AND variant_id IS NULL;

  -- The shop's whole packs (Inventory mode On).
  PERFORM inventory_sync_unit(p_product_id, NULL);
  PERFORM set_config('app.activity_quiet', '', true);

  v_after := pg_temp.b551_unit(p_product_id);
  IF (v_after ->> 'units_left')::bigint <> (v_before ->> 'units_left')::bigint * p_pack
     OR (v_after - 'units_left') IS DISTINCT FROM (v_before - 'units_left') THEN
    RAISE EXCEPTION 'Stopped, nothing was changed: % would not keep the same stock or cost (before %, after %).',
      v_p.name, v_before, v_after;
  END IF;

  PERFORM write_activity('inventory.pack_converted', 'product', p_product_id::text, v_p.name,
    format('Pack size set to %s %s (stock and costs converted)', p_pack, p_unit),
    jsonb_build_object('stock_unit', p_unit, 'pack_size', p_pack, 'before', v_before, 'after', v_after));
  RETURN 'Converted';
END;
$f$;
-- ==== helpers end ====

CREATE TEMP TABLE IF NOT EXISTS b551_result (n integer, id uuid, name text, result text) ON COMMIT DROP;
TRUNCATE b551_result;

DO $fix$
DECLARE
  r        record;
  v_before jsonb;
  v_after  jsonb;
BEGIN
  IF to_regprocedure('public.inventory_pack_locked(uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION 'Run supabase/migration-057-batch55-1.sql first (file 1), then this file.';
  END IF;
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'No approved Super Admin was found to act as.';
  END IF;

  v_before := pg_temp.b551_totals();
  FOR r IN
    SELECT * FROM (VALUES
      (1, 'a62e23de-30e5-4c2d-b2f3-0b99af4a572f'::uuid, 'CeraVe Foaming Cleanser 473ml', 'ml', 473),
      (2, '53bc91d4-327d-468e-b2af-f9774787a3af'::uuid, 'CeraVe Foaming Cleanser Eco-Recharge Refill 473mL', 'ml', 473),
      (3, '13951d92-3e9b-452f-a827-cb689d663bae'::uuid, 'CeraVe Hydrating Cleanser Eco-Recharge Refill 473ml', 'ml', 473),
      (4, '04de8d66-4bdd-4927-a19a-7f30a9ef0a33'::uuid, 'Blackmores Fish Oil 1000 | 400 Capsules', 'pcs', 400),
      (5, 'c7224c01-0251-40c6-80a3-8459ac438403'::uuid, 'Blackmores Omega Triple Super Strength Fish Oil', 'pcs', 150)
    ) AS t (n, id, name, unit, pack)
    ORDER BY n
  LOOP
    INSERT INTO b551_result (n, id, name, result)
    VALUES (r.n, r.id, r.name, pg_temp.b551_convert(r.id, r.unit, r.pack, r.name));
  END LOOP;
  v_after := pg_temp.b551_totals();
  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'Stopped, nothing was changed: a money total would move (before %, after %).', v_before, v_after;
  END IF;
END;
$fix$;

-- What each product shows now.
SELECT r.name, r.result, p.stock_unit AS unit, p.pack_size,
       p.stock_quantity AS shop_stock_packs,
       inventory_units_left(p.id, NULL) AS units_left,
       inventory_buying_price(p.id, NULL) AS cost_per_unit,
       round(inventory_buying_price(p.id, NULL) * p.pack_size, 2) AS cost_per_pack
FROM b551_result r
LEFT JOIN products p ON p.id = r.id
ORDER BY r.n;

COMMIT;
