-- Batch 55.1 database tests (run by e2e/batch-55-1.spec.ts through the
-- Supabase command line). The runner puts the whole guard migration
-- (supabase/migration-057-batch55-1.sql, without its own BEGIN / COMMIT)
-- and the one-time fix's helper functions (supabase/fix-batch55-1-pack-sizes.sql,
-- between "helpers start" and "helpers end") in front of this script.
-- Everything — made-up products, a lot, orders, the conversion, a loose
-- sale — runs inside ONE transaction that always ends with ROLLBACK.
-- The real products are never touched.
--
-- Result: the rows (name, ok, detail) of the SELECT before the ROLLBACK.
DO $test$
DECLARE
  v_admin  uuid;
  c_admin  text;
  v_pp     uuid;  -- the refill: pack 1 → 473 ml (lot, sales, give-back, pre-inventory line)
  v_pq     uuid;  -- the capsules: pack 1 → 150 pcs (buying price, sold without stock)
  v_pl     uuid;  -- a product with a lot only (guard)
  v_pn     uuid;  -- a product with nothing yet (guard)
  v_lot    uuid;
  v_row    uuid;
  v_opre   uuid;  -- order placed while Inventory mode was Off
  v_oa     uuid;  -- delivered, 2 packs
  v_ob     uuid;  -- cancelled, 1 pack given back
  v_oc     uuid;  -- capsules sold without stock, delivered
  v_od     uuid;  -- pending, 1 pack → edited to 100 ml loose
  v_item   uuid;
  v_t0     jsonb;
  v_t1     jsonb;
  v_u0     jsonb;
  v_u1     jsonb;
  v_q0     jsonb;
  v_old    numeric;  -- landed cost of 1 refill before (per pack)
  v_txt    text;
  v_err    text;
  v_num    numeric;
  v_tag    text := to_char(clock_timestamp(), 'HH24MISSMS');
  c_msg    constant text := 'This product already has stock or sales counted per pack. Changing its pack size here would break those numbers. Ask for a safe pack-size change.';
BEGIN
  EXECUTE 'CREATE TEMP TABLE t_res (n serial, name text, ok boolean, detail text)';
  EXECUTE $f$CREATE FUNCTION pg_temp.ck(p_name text, p_ok boolean, p_detail text DEFAULT '') RETURNS void
    LANGUAGE sql AS 'INSERT INTO t_res (name, ok, detail) VALUES (p_name, COALESCE(p_ok, false), COALESCE(p_detail, ''''))'$f$;

  SELECT id INTO v_admin FROM auth.users WHERE lower(email) = lower('{{ADMIN_EMAIL}}');
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'TEST_SETUP:the test admin account was not found';
  END IF;
  c_admin := json_build_object('sub', v_admin, 'role', 'authenticated', 'aal', 'aal2',
    'amr', json_build_array(json_build_object('method', 'password', 'timestamp', extract(epoch FROM now())::bigint)))::text;
  PERFORM set_config('request.jwt.claims', c_admin, true);

  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('E2E-B551-P-' || v_tag, 'e2e-b551-p-' || v_tag, 'E2E B551 Refill 473ml', 3500, 'in_stock', 5, true) RETURNING id INTO v_pp;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('E2E-B551-Q-' || v_tag, 'e2e-b551-q-' || v_tag, 'E2E B551 Capsules 150', 4500, 'in_stock', 0, true) RETURNING id INTO v_pq;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('E2E-B551-L-' || v_tag, 'e2e-b551-l-' || v_tag, 'E2E B551 Lot only', 900, 'in_stock', 0, true) RETURNING id INTO v_pl;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('E2E-B551-N-' || v_tag, 'e2e-b551-n-' || v_tag, 'E2E B551 New', 900, 'in_stock', 0, true) RETURNING id INTO v_pn;

  -- ---------- An order while Inventory mode is Off (units taken from the stock number)
  PERFORM set_config('inventory.mode_change', 'on', true);
  UPDATE app_settings SET value = 'false' WHERE key = 'inventory_mode';
  PERFORM set_config('inventory.mode_change', '', true);
  PERFORM set_config('inventory.test_mode', '', true);
  SELECT order_id INTO v_opre FROM admin_create_order_v2(
    p_source => 'phone', p_items => jsonb_build_array(jsonb_build_object('product_id', v_pp, 'quantity', 1)),
    p_full_name => 'E2E B551', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80);
  PERFORM pg_temp.ck('Setup: an order placed while Off took 1 unit from the stock number',
    (SELECT pre_inventory_units FROM order_items WHERE order_id = v_opre) = 1,
    (SELECT pre_inventory_units::text FROM order_items WHERE order_id = v_opre));

  -- ---------- Mode On from here on
  PERFORM set_config('inventory.test_mode', 'on', true);
  v_lot := inventory_save_lot(jsonb_build_object(
    'source_type', 'local', 'country', 'Bangladesh', 'lot_date', inventory_dhaka_today(), 'costs_pending', false, 'notes', 'e2e b551',
    'items', jsonb_build_array(
      jsonb_build_object('product_id', v_pp, 'qty', 4, 'entry_unit', 'pack', 'unit_price_foreign', '2800', 'expiry_date', '2028-01-31'),
      jsonb_build_object('product_id', v_pl, 'qty', 2, 'entry_unit', 'pack', 'unit_price_foreign', '500', 'expiry_date', '2028-01-31')),
    'costs', jsonb_build_array(jsonb_build_object('cost_type', 'other', 'amount_bdt', '473.00', 'note', 'Courier'))));
  SELECT id, landed_unit_cost_bdt INTO v_row, v_old FROM lot_items WHERE lot_id = v_lot AND product_id = v_pp;
  PERFORM inventory_sync_unit(v_pp, NULL);

  SELECT order_id INTO v_oa FROM admin_create_order_v2(
    p_source => 'phone', p_items => jsonb_build_array(jsonb_build_object('product_id', v_pp, 'quantity', 2)),
    p_full_name => 'E2E B551', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80);
  PERFORM admin_set_order_status(v_oa, 'delivered', 'e2e');
  SELECT order_id INTO v_ob FROM admin_create_order_v2(
    p_source => 'phone', p_items => jsonb_build_array(jsonb_build_object('product_id', v_pp, 'quantity', 1)),
    p_full_name => 'E2E B551', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80);
  PERFORM admin_set_order_status(v_ob, 'cancelled', 'e2e');
  SELECT order_id INTO v_od FROM admin_create_order_v2(
    p_source => 'phone', p_items => jsonb_build_array(jsonb_build_object('product_id', v_pp, 'quantity', 1)),
    p_full_name => 'E2E B551', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80);

  PERFORM inventory_set_buying_prices(jsonb_build_array(jsonb_build_object('product_id', v_pq, 'variant_id', NULL, 'price', '3590')));
  SELECT order_id INTO v_oc FROM admin_create_order_v2(
    p_source => 'phone', p_items => jsonb_build_array(jsonb_build_object('product_id', v_pq, 'quantity', 1)),
    p_full_name => 'E2E B551', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80, p_allow_negative_stock => true);
  PERFORM admin_set_order_status(v_oc, 'delivered', 'e2e');

  PERFORM pg_temp.ck('Setup: refill lot of 4, 2 delivered, 1 given back, 1 on a pending order → 1 left, shop 1',
    inventory_units_left(v_pp, NULL) = 1 AND (SELECT stock_quantity FROM products WHERE id = v_pp) = 1
    AND (SELECT units_back FROM order_item_lots WHERE order_id = v_ob) = 1,
    format('%s left, shop %s', inventory_units_left(v_pp, NULL), (SELECT stock_quantity FROM products WHERE id = v_pp)));
  PERFORM pg_temp.ck('Setup: the capsules are sold without stock at the buying price',
    (SELECT units = 1 AND provisional_unit_cost_bdt = 3590 FROM stock_shortfalls WHERE order_id = v_oc),
    (SELECT format('%s %s', units, provisional_unit_cost_bdt) FROM stock_shortfalls WHERE order_id = v_oc));

  -- ---------- The guard (before the conversion)
  BEGIN PERFORM inventory_set_pack(v_pp, NULL, 'ml', 473); v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  PERFORM pg_temp.ck('Guard: a product with lots and sales can''t get a new pack size', v_err = c_msg, v_err);
  BEGIN PERFORM inventory_set_pack(v_pq, NULL, 'pcs', 150); v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  PERFORM pg_temp.ck('Guard: a product with a buying price / sold without stock can''t either', v_err = c_msg, v_err);
  BEGIN PERFORM inventory_set_pack(v_pl, NULL, 'ml', 50); v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  PERFORM pg_temp.ck('Guard: a product with only a lot can''t either', v_err = c_msg, v_err);
  BEGIN PERFORM inventory_set_pack(v_pl, NULL, 'ml', 1); v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  PERFORM pg_temp.ck('Guard: changing only the unit word (pack size 1 → 1) is still allowed',
    v_err = 'allowed' AND (SELECT stock_unit = 'ml' AND pack_size = 1 FROM products WHERE id = v_pl), v_err);
  BEGIN PERFORM inventory_set_pack(v_pn, NULL, 'ml', 250); v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  PERFORM pg_temp.ck('Guard: a product with nothing yet: pack size saved as before',
    v_err = 'allowed' AND (SELECT stock_unit = 'ml' AND pack_size = 250 FROM products WHERE id = v_pn), v_err);
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM inventory_set_pack(v_pp, NULL, 'ml', 473); v_err := 'allowed';
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; EXECUTE 'RESET ROLE';
  END;
  PERFORM pg_temp.ck('Guard: the same refusal reaches the website (signed-in admin)', v_err = c_msg, v_err);

  -- ---------- The conversion
  v_t0 := pg_temp.b551_totals();
  v_u0 := pg_temp.b551_unit(v_pp);
  v_q0 := pg_temp.b551_unit(v_pq);
  v_txt := pg_temp.b551_convert(v_pp, 'ml', 473, 'E2E B551 Refill 473ml');
  PERFORM pg_temp.ck('Convert: the refill is converted', v_txt = 'Converted', v_txt);
  v_txt := pg_temp.b551_convert(v_pq, 'pcs', 150, 'E2E B551 Capsules 150');
  PERFORM pg_temp.ck('Convert: the capsules are converted', v_txt = 'Converted', v_txt);
  v_t1 := pg_temp.b551_totals();
  PERFORM pg_temp.ck('Convert: net worth, stock value, sales profit (Reports and Money), customer totals all identical',
    v_t1 = v_t0, format('%s | %s', v_t0, v_t1));
  v_u1 := pg_temp.b551_unit(v_pp);
  PERFORM pg_temp.ck('Convert: refill shop stock 1 pack, 473 ml left, stock value and cost of sales identical',
    (v_u1 ->> 'shop_packs')::int = 1 AND (v_u1 ->> 'units_left')::int = 473 AND (v_u1 - 'units_left') = (v_u0 - 'units_left'),
    format('%s | %s', v_u0, v_u1));
  PERFORM pg_temp.ck('Convert: refill lot row 4 packs = 1892 ml, entered by pack, same price per pack and buy value',
    (SELECT qty = 1892 AND qty_remaining = 473 AND entry_unit = 'pack' AND pack_size = 473 AND unit_price_foreign = 2800
            AND buy_value_bdt = 11200 FROM lot_items WHERE id = v_row),
    (SELECT format('%s %s %s %s %s %s', qty, qty_remaining, entry_unit, pack_size, unit_price_foreign, buy_value_bdt) FROM lot_items WHERE id = v_row));
  PERFORM pg_temp.ck('Convert: refill cost per ml = cost per pack ÷ 473 (473 × it gives back the pack cost to the paisa)',
    (SELECT round(landed_unit_cost_bdt * 473, 2) = round(v_old, 2) AND landed_unit_cost_bdt = round(v_old / 473, 6)
     FROM lot_items WHERE id = v_row),
    (SELECT format('%s per ml, was %s per pack', landed_unit_cost_bdt, v_old) FROM lot_items WHERE id = v_row));
  PERFORM pg_temp.ck('Convert: units taken by orders × 473 (delivered 946, given back 473 of 473, pending 473)',
    (SELECT units = 946 AND units_back = 0 FROM order_item_lots WHERE order_id = v_oa)
    AND (SELECT units = 473 AND units_back = 473 FROM order_item_lots WHERE order_id = v_ob)
    AND (SELECT units = 473 FROM order_item_lots WHERE order_id = v_od)
    AND (SELECT round(unit_cost_bdt * 473, 2) = round(v_old, 2) FROM order_item_lots WHERE order_id = v_oa),
    (SELECT string_agg(format('%s/%s @%s', units, units_back, unit_cost_bdt), '; ') FROM order_item_lots WHERE lot_item_id = v_row));
  PERFORM pg_temp.ck('Convert: order lines stay whole packs; the line placed while Off holds 473 ml',
    (SELECT quantity FROM order_items WHERE order_id = v_oa) = 2
    AND (SELECT quantity FROM order_items WHERE order_id = v_ob) = 1
    AND (SELECT quantity FROM order_items WHERE order_id = v_od) = 1
    AND (SELECT pre_inventory_units FROM order_items WHERE order_id = v_opre) = 473,
    (SELECT pre_inventory_units::text FROM order_items WHERE order_id = v_opre));
  PERFORM pg_temp.ck('Convert: capsules sold without stock: 150 pcs at ৳3,590 ÷ 150; buying price per capsule',
    (SELECT units = 150 AND provisional_unit_cost_bdt = round(3590::numeric / 150, 6) FROM stock_shortfalls WHERE order_id = v_oc)
    AND (SELECT unit_cost_bdt = round(3590::numeric / 150, 6) FROM product_buying_prices WHERE product_id = v_pq)
    AND (pg_temp.b551_unit(v_pq) - 'units_left') = (v_q0 - 'units_left'),
    (SELECT format('%s %s', units, provisional_unit_cost_bdt) FROM stock_shortfalls WHERE order_id = v_oc));
  PERFORM pg_temp.ck('Convert: the product shows ml / 473 and pcs / 150',
    (SELECT stock_unit = 'ml' AND pack_size = 473 FROM products WHERE id = v_pp)
    AND (SELECT stock_unit = 'pcs' AND pack_size = 150 FROM products WHERE id = v_pq));
  PERFORM pg_temp.ck('Convert: one Activity Log line per product',
    (SELECT count(*) FROM activity_log WHERE action = 'inventory.pack_converted' AND entity_id = v_pp::text
       AND summary = 'Pack size set to 473 ml (stock and costs converted)') = 1
    AND (SELECT count(*) FROM activity_log WHERE action = 'inventory.pack_converted' AND entity_id = v_pq::text
       AND summary = 'Pack size set to 150 pcs (stock and costs converted)') = 1
    AND NOT EXISTS (SELECT 1 FROM activity_log WHERE entity_id = v_pp::text AND action <> 'inventory.pack_converted'
                      AND details::text LIKE '%pack_size%'),
    (SELECT string_agg(action || ': ' || summary, '; ') FROM activity_log WHERE entity_id = v_pp::text));
  PERFORM pg_temp.ck('Convert: a second run says "Already done" and changes nothing',
    pg_temp.b551_convert(v_pp, 'ml', 473, 'E2E B551 Refill 473ml') = 'Already done'
    AND pg_temp.b551_unit(v_pp) = v_u1 AND pg_temp.b551_totals() = v_t0);
  PERFORM pg_temp.ck('Convert: a renamed or unknown product is left out',
    pg_temp.b551_convert(v_pn, 'ml', 250, 'Something else') LIKE 'Left out%'
    AND pg_temp.b551_convert(gen_random_uuid(), 'ml', 473, 'x') = 'Left out: product not found');

  -- ---------- After: the guard still refuses; changing only the word is fine
  BEGIN PERFORM inventory_set_pack(v_pp, NULL, 'ml', 1); v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  PERFORM pg_temp.ck('Guard: after the conversion the pack size can''t be changed back by accident', v_err = c_msg, v_err);
  BEGIN PERFORM inventory_set_pack(v_pp, NULL, 'ml', 473); v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  PERFORM pg_temp.ck('Guard: saving the same pack size again is allowed', v_err = 'allowed', v_err);

  -- ---------- Sell 100 ml loose through Edit order (remove the line, add the same product in ml)
  SELECT id INTO v_item FROM order_items WHERE order_id = v_od;
  PERFORM admin_edit_order(v_od, jsonb_build_object('items', jsonb_build_array(
    jsonb_build_object('product_id', v_pp, 'variant_id', NULL, 'quantity', 100, 'unit_price', 7, 'sold_unit', 'ml'))));
  SELECT id INTO v_item FROM order_items WHERE order_id = v_od;
  SELECT c.unit_cost_bdt INTO v_num FROM order_item_costs c WHERE c.order_item_id = v_item;
  PERFORM pg_temp.ck('Loose: the bottle line goes back (473 ml), 100 ml are taken: 846 ml left = 1 whole pack in the shop',
    (SELECT sold_unit = 'ml' AND quantity = 100 FROM order_items WHERE id = v_item)
    AND (SELECT sum(units - units_back) FROM order_item_lots WHERE order_item_id = v_item) = 100
    AND inventory_units_left(v_pp, NULL) = 846 AND (SELECT stock_quantity FROM products WHERE id = v_pp) = 1,
    format('%s left, shop %s', inventory_units_left(v_pp, NULL), (SELECT stock_quantity FROM products WHERE id = v_pp)));
  PERFORM pg_temp.ck('Loose: the cost of 100 ml = 100 × (pack cost ÷ 473)',
    round(v_num * 100, 2) = round(100 * v_old / 473, 2),
    format('%s per ml → ৳%s for 100 ml (pack ৳%s)', v_num, round(v_num * 100, 2), v_old));
END;
$test$;

SELECT 'TEST_RESULT' AS tag, (SELECT json_agg(json_build_object('name', name, 'ok', ok, 'detail', detail) ORDER BY n) FROM t_res)::text AS results;
