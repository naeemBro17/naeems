-- Batch 45 database tests (run by e2e/batch-45.spec.ts through the Supabase
-- command line). The runner puts the whole Batch 45 migration
-- (supabase/migration-046-batch45-inventory.sql, without its own BEGIN /
-- COMMIT) in front of this script, so everything — the migration, the
-- throwaway products, lots and orders, and switching Inventory mode — runs
-- inside ONE transaction that always ends with ROLLBACK. The live shop
-- never sees any of it, and the live Inventory mode is never changed.
--
-- Result: the rows (name, ok, detail) of the SELECT before the ROLLBACK.
DO $test$
DECLARE
  v_admin  uuid;
  v_cust   uuid;
  c_admin  text;
  c_cust   text;
  v_pa     uuid;  -- one lot
  v_pb     uuid;  -- two lots
  v_pp     uuid;  -- pack of 10
  v_pv     uuid;  -- product with an option (and its own size)
  v_vv     uuid;  -- its option
  v_pc     uuid;  -- Inventory mode Off
  v_pre    uuid;  -- sold before Inventory mode (the CeraVe case)
  v_po     uuid;  -- oversold
  v_pd     uuid;  -- its lot is deleted
  v_nb     uuid;  -- no buying price
  v_lot    uuid;
  v_lot2   uuid;
  v_open   uuid;
  v_oid    uuid;
  v_o2     uuid;
  v_item   uuid;
  v_item2  uuid;
  v_err    text;
  v_num    numeric;
  v_int    integer;
  v_json   jsonb;
  v_ids    uuid[];
  v_tag    text := to_char(clock_timestamp(), 'HH24MISSMS');
  v_orders bigint;
BEGIN
  EXECUTE 'CREATE TEMP TABLE t_res (n serial, name text, ok boolean, detail text)';
  EXECUTE $f$CREATE FUNCTION pg_temp.ck(p_name text, p_ok boolean, p_detail text DEFAULT '') RETURNS void
    LANGUAGE sql AS 'INSERT INTO t_res (name, ok, detail) VALUES (p_name, COALESCE(p_ok, false), COALESCE(p_detail, ''''))'$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.ledger_ok(p_ids uuid[]) RETURNS boolean LANGUAGE sql AS '
    SELECT NOT EXISTS (
      SELECT 1 FROM lot_items li
      WHERE li.product_id = ANY (p_ids)
        AND li.qty_remaining <> (SELECT COALESCE(sum(m.qty), 0) FROM stock_movements m WHERE m.lot_item_id = li.id))'$f$;

  SELECT id INTO v_admin FROM auth.users WHERE lower(email) = lower('{{ADMIN_EMAIL}}');
  SELECT id INTO v_cust FROM auth.users WHERE lower(email) = lower('{{CUSTOMER_EMAIL}}');
  IF v_admin IS NULL OR v_cust IS NULL THEN
    RAISE EXCEPTION 'TEST_SETUP:the test accounts were not found';
  END IF;
  c_admin := json_build_object('sub', v_admin, 'role', 'authenticated',
    'amr', json_build_array(json_build_object('method', 'password', 'timestamp', extract(epoch FROM now())::bigint)))::text;
  c_cust := json_build_object('sub', v_cust, 'role', 'authenticated')::text;

  -- ================================================ the migration's data fix
  PERFORM pg_temp.ck('Part 5: no lot row carries any weight share after the migration',
    NOT EXISTS (SELECT 1 FROM lot_items WHERE alloc_weight_paisa <> 0 OR alloc_weight_bdt <> 0));
  PERFORM pg_temp.ck('Part 5: L-000 is the opening lot again, with no weight amount',
    (SELECT kind = 'opening' AND COALESCE(opening_weight_added_bdt, 0) = 0 FROM lots WHERE code = 'L-000'),
    (SELECT format('%s %s', kind, opening_weight_added_bdt) FROM lots WHERE code = 'L-000'));
  SELECT li.landed_unit_cost_bdt INTO v_num FROM lot_items li JOIN products p ON p.id = li.product_id
  WHERE p.name ILIKE 'The Ordinary Niacinamide 10%% + Zinc 1%% 30ml%' LIMIT 1;
  PERFORM pg_temp.ck('Part 5: Niacinamide 10% + Zinc 30ml costs ৳795 (not ৳1,152.75)', v_num IS NULL OR v_num = 795, COALESCE(v_num::text, 'not in this shop'));
  PERFORM pg_temp.ck('Part 5: its old sales now cost ৳795 each too',
    NOT EXISTS (SELECT 1 FROM order_item_lots o JOIN lot_items li ON li.id = o.lot_item_id JOIN products p ON p.id = li.product_id
                JOIN order_item_costs c ON c.order_item_id = o.order_item_id
                WHERE p.name ILIKE 'The Ordinary Niacinamide 10%% + Zinc 1%% 30ml%' AND c.unit_cost_bdt <> 795));
  PERFORM pg_temp.ck('Part 7: every existing order line has a stored cost row (a cost, or "cost missing")',
    NOT EXISTS (SELECT 1 FROM order_items oi WHERE NOT EXISTS (SELECT 1 FROM order_item_costs c WHERE c.order_item_id = oi.id)));
  PERFORM pg_temp.ck('Part 7: a line with no cost is exactly a line whose product has no buying price and no priced lot',
    NOT EXISTS (SELECT 1 FROM order_items oi JOIN order_item_costs c ON c.order_item_id = oi.id
                WHERE c.unit_cost_bdt IS NULL AND inventory_buying_price(oi.product_id, oi.variant_id) IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM order_item_lots o WHERE o.order_item_id = oi.id)));

  -- Throwaway products (only inside this transaction).
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('E2E-B45-A-' || v_tag, 'e2e-b45-a-' || v_tag, 'E2E B45 Cleanser', 1000, 'in_stock', 0, true) RETURNING id INTO v_pa;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('E2E-B45-B-' || v_tag, 'e2e-b45-b-' || v_tag, 'E2E B45 Toner', 1000, 'in_stock', 0, true) RETURNING id INTO v_pb;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active, stock_unit, pack_size)
  VALUES ('E2E-B45-P-' || v_tag, 'e2e-b45-p-' || v_tag, 'E2E B45 Capsules', 900, 'in_stock', 0, true, 'pcs', 10) RETURNING id INTO v_pp;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active, region, size)
  VALUES ('E2E-B45-V-' || v_tag, 'e2e-b45-v-' || v_tag, 'E2E B45 Foaming Cleanser', 800, 'in_stock', NULL, true, 'USA', '236 ml') RETURNING id INTO v_pv;
  INSERT INTO product_variants (product_id, region, size, retail_price, stock_quantity, in_stock)
  VALUES (v_pv, 'USA', '473 ml', 1500, 0, false) RETURNING id INTO v_vv;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('E2E-B45-C-' || v_tag, 'e2e-b45-c-' || v_tag, 'E2E B45 Mask', 500, 'in_stock', 5, true) RETURNING id INTO v_pc;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('E2E-B45-R-' || v_tag, 'e2e-b45-r-' || v_tag, 'E2E B45 Refill', 3100, 'in_stock', 4, true) RETURNING id INTO v_pre;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('E2E-B45-O-' || v_tag, 'e2e-b45-o-' || v_tag, 'E2E B45 Shampoo', 999, 'in_stock', 0, true) RETURNING id INTO v_po;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('E2E-B45-D-' || v_tag, 'e2e-b45-d-' || v_tag, 'E2E B45 Serum', 700, 'in_stock', 0, true) RETURNING id INTO v_pd;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('E2E-B45-N-' || v_tag, 'e2e-b45-n-' || v_tag, 'E2E B45 Lip Balm', 300, 'in_stock', 3, true) RETURNING id INTO v_nb;
  v_ids := ARRAY[v_pa, v_pb, v_pp, v_pv, v_pc, v_pre, v_po, v_pd, v_nb];

  -- ===================================================== Inventory mode OFF
  PERFORM set_config('inventory.mode_change', 'on', true);
  UPDATE app_settings SET value = 'false' WHERE key = 'inventory_mode';
  PERFORM set_config('inventory.mode_change', '', true);
  PERFORM set_config('inventory.test_mode', '', true);

  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT order_id INTO v_oid FROM place_order(
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_pc, 'quantity', 2)),
    p_full_name => 'E2E B45', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka',
    p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod');
  PERFORM cancel_order(v_oid, NULL);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Part 1 Off: cancel gives the 2 back to the plain stock number (5)',
    (SELECT stock_quantity FROM products WHERE id = v_pc) = 5, (SELECT stock_quantity::text FROM products WHERE id = v_pc));

  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT order_id INTO v_oid FROM place_order(
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_pc, 'quantity', 2)),
    p_full_name => 'E2E B45', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka',
    p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod');
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Part 1 Off: the sale lowers the number (3) and the line remembers 2 units',
    (SELECT stock_quantity FROM products WHERE id = v_pc) = 3
    AND (SELECT pre_inventory_units FROM order_items WHERE order_id = v_oid) = 2);
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM admin_delete_orders(ARRAY[v_oid]);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Part 1 Off: deleting the order gives the 2 back (5)', (SELECT stock_quantity FROM products WHERE id = v_pc) = 5);

  -- Part 7: a sale with no buying price anywhere is "cost missing".
  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT order_id INTO v_o2 FROM place_order(
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_nb, 'quantity', 1)),
    p_full_name => 'E2E B45', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka',
    p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod');
  EXECUTE 'RESET ROLE';
  SELECT id INTO v_item FROM order_items WHERE order_id = v_o2;
  PERFORM pg_temp.ck('Part 7: a sale of a product with no buying price is stored as "cost missing"',
    (SELECT unit_cost_bdt IS NULL AND source = 'missing' FROM order_item_costs WHERE order_item_id = v_item));
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT units_sold INTO v_int FROM inventory_missing_buying_prices() WHERE product_id = v_nb;
  v_json := inventory_set_buying_prices(jsonb_build_array(jsonb_build_object('product_id', v_nb, 'variant_id', NULL, 'price', '77')));
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Part 8: Set buying prices lists it with 1 sold', v_int = 1, COALESCE(v_int::text, 'not listed'));
  PERFORM pg_temp.ck('Part 7/8: saving its buying price fills the sale''s cost (৳77)',
    (SELECT unit_cost_bdt = 77 AND source = 'buying_price' FROM order_item_costs WHERE order_item_id = v_item)
    AND (v_json ->> 'items_filled')::integer = 1, v_json::text);
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_int FROM inventory_missing_buying_prices() WHERE product_id = v_nb;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Part 8: … and it leaves the list', v_int = 0);

  -- The CeraVe case, step 1: sold while Inventory mode is Off.
  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT order_id INTO v_oid FROM place_order(
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_pre, 'quantity', 1)),
    p_full_name => 'E2E B45', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka',
    p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod');
  EXECUTE 'RESET ROLE';

  -- ====================================================== Inventory mode ON
  PERFORM set_config('inventory.test_mode', 'on', true);

  -- The CeraVe case, step 2: the order is deleted while the mode is On.
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM admin_delete_orders(ARRAY[v_oid]);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Part 1 (CeraVe case): a piece sold before Inventory mode comes back — into the opening lot',
    inventory_units_left(v_pre, NULL) = 1
    AND EXISTS (SELECT 1 FROM lot_items li JOIN lots l ON l.id = li.lot_id WHERE l.kind = 'opening' AND li.product_id = v_pre AND li.qty_remaining = 1),
    inventory_units_left(v_pre, NULL)::text);
  PERFORM pg_temp.ck('Part 1 (CeraVe case): the shop''s stock follows the lots at once (1)',
    (SELECT stock_quantity FROM products WHERE id = v_pre) = 1, (SELECT stock_quantity::text FROM products WHERE id = v_pre));

  -- Lots.
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_lot := inventory_save_lot(jsonb_build_object('source_type', 'wholesale', 'lot_date', '2026-11-01', 'costs_pending', false, 'notes', 'e2e b45',
    'items', jsonb_build_array(
      jsonb_build_object('product_id', v_pa, 'qty', 3, 'unit_price_foreign', '100', 'expiry_date', '2027-03-01'),
      jsonb_build_object('product_id', v_pb, 'qty', 2, 'unit_price_foreign', '100', 'expiry_date', '2027-03-01'),
      jsonb_build_object('product_id', v_pp, 'qty', 3, 'entry_unit', 'pack', 'unit_price_foreign', '500'),
      jsonb_build_object('product_id', v_pv, 'variant_id', v_vv, 'qty', 2, 'unit_price_foreign', '300'),
      jsonb_build_object('product_id', v_pv, 'variant_id', v_pv, 'qty', 1, 'unit_price_foreign', '200'),
      jsonb_build_object('product_id', v_po, 'qty', 1, 'unit_price_foreign', '400')),
    'costs', '[]'::jsonb));
  v_lot2 := inventory_save_lot(jsonb_build_object('source_type', 'wholesale', 'lot_date', '2026-11-02', 'costs_pending', false, 'notes', 'e2e b45 2',
    'items', jsonb_build_array(jsonb_build_object('product_id', v_pb, 'qty', 2, 'unit_price_foreign', '120', 'expiry_date', '2027-06-01')),
    'costs', '[]'::jsonb));
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Part 3: a product''s own size (option id = product id) can hold a lot; the shop shows its 1',
    inventory_units_left(v_pv, NULL) = 1 AND (SELECT stock_quantity FROM products WHERE id = v_pv) = 1,
    (SELECT stock_quantity::text FROM products WHERE id = v_pv));
  PERFORM pg_temp.ck('Lots: pack of 10 — 3 packs = 30 units at ৳50, shop shows 3',
    inventory_units_left(v_pp, NULL) = 30 AND (SELECT stock_quantity FROM products WHERE id = v_pp) = 3
    AND (SELECT landed_unit_cost_bdt FROM lot_items WHERE lot_id = v_lot AND product_id = v_pp) = 50);

  -- Part 5: an old weight bill counts nowhere; other costs do.
  INSERT INTO lot_costs (lot_id, cost_type, amount_bdt, note) VALUES (v_lot2, 'weight', 1000, 'old luggage bill');
  PERFORM inventory_allocate_lot(v_lot2, NULL);
  PERFORM pg_temp.ck('Part 5: a weight bill on a lot changes nothing (landed stays ৳120)',
    (SELECT landed_unit_cost_bdt FROM lot_items WHERE lot_id = v_lot2) = 120 AND money_lot_landed(v_lot2) = 240,
    (SELECT landed_unit_cost_bdt::text FROM lot_items WHERE lot_id = v_lot2));

  -- Part 1 a: one lot, website order, customer cancels.
  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT order_id INTO v_oid FROM place_order(
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_pa, 'quantity', 2)),
    p_full_name => 'E2E B45', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka',
    p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod');
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Part 7: a new sale stores its cost when it is made (৳100 a piece from the lot)',
    (SELECT c.unit_cost_bdt = 100 AND c.source = 'lots' FROM order_items oi JOIN order_item_costs c ON c.order_item_id = oi.id WHERE oi.order_id = v_oid));
  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM cancel_order(v_oid, NULL);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Part 1 On: one lot — cancel gives back exactly 2 (3 left, shop 3)',
    inventory_units_left(v_pa, NULL) = 3 AND (SELECT stock_quantity FROM products WHERE id = v_pa) = 3);

  -- Part 1 b: two lots, admin order, deleted.
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT order_id INTO v_oid FROM admin_create_order_v2(
    p_source => 'phone', p_items => jsonb_build_array(jsonb_build_object('product_id', v_pb, 'quantity', 3, 'sold_price', 1000)),
    p_full_name => 'E2E B45 admin', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Part 1 On: two lots — 3 taken as 2 + 1 (earliest expiry first); cost ৳(200+120)/3',
    (SELECT array_agg(o.units ORDER BY o.seq) FROM order_item_lots o WHERE o.order_id = v_oid) = ARRAY[2, 1]
    AND (SELECT round(c.unit_cost_bdt, 4) FROM order_items oi JOIN order_item_costs c ON c.order_item_id = oi.id WHERE oi.order_id = v_oid) = round(320.0 / 3, 4));
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM admin_delete_orders(ARRAY[v_oid]);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Part 1 On: deleting it gives each lot row back exactly what it gave (2 and 2, shop 4)',
    (SELECT qty_remaining FROM lot_items WHERE lot_id = v_lot AND product_id = v_pb) = 2
    AND (SELECT qty_remaining FROM lot_items WHERE lot_id = v_lot2) = 2
    AND (SELECT stock_quantity FROM products WHERE id = v_pb) = 4);

  -- Part 1 c + Part 3: the option and the product's own size.
  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT order_id INTO v_oid FROM place_order(
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_pv, 'variant_id', v_vv, 'quantity', 1),
                                 jsonb_build_object('product_id', v_pv, 'variant_id', v_pv, 'quantity', 1)),
    p_full_name => 'E2E B45', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka',
    p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod');
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Part 3: the own size (sent with option id = product id) and an option sell together',
    v_oid IS NOT NULL AND inventory_units_left(v_pv, v_vv) = 1 AND inventory_units_left(v_pv, NULL) = 0
    AND (SELECT count(*) FROM order_items WHERE order_id = v_oid AND variant_id IS NULL) = 1);
  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    PERFORM place_order(p_items => jsonb_build_array(jsonb_build_object('product_id', v_pv, 'variant_id', v_pv, 'quantity', 1)),
      p_full_name => 'E2E B45', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka',
      p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod');
    v_err := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Part 3: the sold-out own size is refused…', v_err LIKE '%left in stock%' OR v_err LIKE '%out of stock%', v_err);
  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT order_id INTO v_o2 FROM place_order(p_items => jsonb_build_array(jsonb_build_object('product_id', v_pv, 'variant_id', v_vv, 'quantity', 1)),
      p_full_name => 'E2E B45', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka',
      p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod');
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Part 3: … while the in-stock option of the same product still sells', v_o2 IS NOT NULL AND inventory_units_left(v_pv, v_vv) = 0);
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM admin_set_order_status(v_oid, 'shipped', 'e2e');
  PERFORM admin_mark_order_returned(v_oid, 'e2e');
  PERFORM admin_set_order_status(v_o2, 'cancelled', 'e2e');
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Part 1 On: an option and an own size — Returned / Cancelled give back exactly what was taken',
    inventory_units_left(v_pv, v_vv) = 2 AND inventory_units_left(v_pv, NULL) = 1
    AND (SELECT stock_quantity FROM product_variants WHERE id = v_vv) = 2 AND (SELECT stock_quantity FROM products WHERE id = v_pv) = 1);

  -- Part 1 d + e: pack of 10, a partial quantity cut and a line removed in Edit order.
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT order_id INTO v_oid FROM admin_create_order_v2(
    p_source => 'phone', p_items => jsonb_build_array(
      jsonb_build_object('product_id', v_pp, 'quantity', 2, 'sold_price', 900),
      jsonb_build_object('product_id', v_pa, 'quantity', 1, 'sold_price', 1000)),
    p_full_name => 'E2E B45 admin', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80);
  EXECUTE 'RESET ROLE';
  SELECT id INTO v_item FROM order_items WHERE order_id = v_oid AND product_id = v_pp;
  PERFORM pg_temp.ck('Part 1 On: pack of 10 — 2 packs take 20 units; the sale costs ৳500 a pack',
    inventory_units_left(v_pp, NULL) = 10 AND (SELECT unit_cost_bdt FROM order_item_costs WHERE order_item_id = v_item) = 500);
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM admin_edit_order(v_oid, jsonb_build_object('items', jsonb_build_array(jsonb_build_object('id', v_item, 'quantity', 1))));
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Part 1 On: 2 → 1 pack gives back exactly 10 units; the removed line gives back its 1 (shop 2 packs, 3 cleansers)',
    inventory_units_left(v_pp, NULL) = 20 AND (SELECT stock_quantity FROM products WHERE id = v_pp) = 2
    AND inventory_units_left(v_pa, NULL) = 3 AND (SELECT stock_quantity FROM products WHERE id = v_pa) = 3,
    format('%s units, %s packs, %s cleansers', inventory_units_left(v_pp, NULL), (SELECT stock_quantity FROM products WHERE id = v_pp), inventory_units_left(v_pa, NULL)));

  -- Part 1 f: oversold — undo gives back only what was really taken.
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT order_id INTO v_oid FROM admin_create_order_v2(
    p_source => 'phone', p_items => jsonb_build_array(jsonb_build_object('product_id', v_po, 'quantity', 3, 'sold_price', 999)),
    p_full_name => 'E2E B45 admin', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80, p_allow_negative_stock => true);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Part 1 oversell: 3 sold with 1 in a lot → 1 taken, 2 "sold without stock"',
    inventory_units_left(v_po, NULL) = 0 AND (SELECT sum(units) FROM stock_shortfalls WHERE order_id = v_oid AND status = 'open') = 2);
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM admin_delete_orders(ARRAY[v_oid]);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Part 1 oversell: deleting it gives back exactly the 1 really taken',
    inventory_units_left(v_po, NULL) = 1 AND (SELECT stock_quantity FROM products WHERE id = v_po) = 1);

  -- Part 6: a lot with sales — quantity floor, price follows, delete.
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_lot2 := inventory_save_lot(jsonb_build_object('source_type', 'import', 'country', 'Australia', 'lot_date', '2026-11-03', 'costs_pending', false, 'notes', '',
    'items', jsonb_build_array(jsonb_build_object('product_id', v_pd, 'qty', 3, 'unit_price_foreign', '100')), 'costs', '[]'::jsonb));
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT order_id INTO v_oid FROM place_order(p_items => jsonb_build_array(jsonb_build_object('product_id', v_pd, 'quantity', 2)),
      p_full_name => 'E2E B45', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka',
      p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod');
  EXECUTE 'RESET ROLE';
  SELECT id INTO v_item FROM order_items WHERE order_id = v_oid;
  SELECT id INTO v_item2 FROM lot_items WHERE lot_id = v_lot2;
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    PERFORM inventory_save_lot(jsonb_build_object('id', v_lot2, 'source_type', 'import', 'country', 'Australia', 'lot_date', '2026-11-03', 'costs_pending', false, 'notes', '',
      'items', jsonb_build_array(jsonb_build_object('id', v_item2, 'product_id', v_pd, 'qty', 1, 'unit_price_foreign', '100')), 'costs', '[]'::jsonb));
    v_err := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM inventory_save_lot(jsonb_build_object('id', v_lot2, 'source_type', 'import', 'country', 'Australia', 'lot_date', '2026-11-03', 'costs_pending', false, 'notes', '',
    'items', jsonb_build_array(jsonb_build_object('id', v_item2, 'product_id', v_pd, 'qty', 3, 'unit_price_foreign', '150')), 'costs', '[]'::jsonb));
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Part 6: a row can''t go below what was sold — plain message', v_err LIKE '%2 units from this row are already sold.%', v_err);
  PERFORM pg_temp.ck('Part 6: changing the buying price changes the cost of its sales (৳100 → ৳150), no safety lock asked',
    (SELECT unit_cost_bdt FROM order_item_costs WHERE order_item_id = v_item) = 150);
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_json := inventory_lot_delete_info(v_lot2);
  PERFORM inventory_delete_lot(v_lot2);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Part 6: the delete box knows: 1 unit leaves stock, 1 order was sold from it', (v_json ->> 'units_left')::integer = 1 AND (v_json ->> 'orders')::integer = 1, v_json::text);
  PERFORM pg_temp.ck('Part 6: deleting a lot with sales works; the order and its line stay, with their cost',
    NOT EXISTS (SELECT 1 FROM lots WHERE id = v_lot2) AND EXISTS (SELECT 1 FROM orders WHERE id = v_oid)
    AND (SELECT unit_cost_bdt FROM order_item_costs WHERE order_item_id = v_item) = 150
    AND NOT EXISTS (SELECT 1 FROM order_item_lots WHERE order_item_id = v_item));
  PERFORM pg_temp.ck('Part 6: its units left stock (shop 0)', (SELECT stock_quantity FROM products WHERE id = v_pd) = 0 AND inventory_units_left(v_pd, NULL) = 0);
  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM cancel_order(v_oid, NULL);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Part 1: units from a deleted lot are not returned anywhere (stock stays 0)',
    inventory_units_left(v_pd, NULL) = 0 AND (SELECT stock_quantity FROM products WHERE id = v_pd) = 0);

  -- Part 6: the opening lot — edit it like any lot, then delete it.
  SELECT id INTO v_open FROM lots WHERE kind = 'opening';
  SELECT count(*) INTO v_orders FROM orders;
  IF v_open IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', c_admin, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    SELECT jsonb_agg(jsonb_build_object('id', li.id, 'product_id', li.product_id, 'variant_id', li.variant_id,
             'qty', CASE WHEN li.entry_unit = 'pack' THEN li.qty / li.pack_size ELSE li.qty END,
             'entry_unit', li.entry_unit, 'unit_price_foreign', li.unit_price_foreign::text, 'expiry_date', li.expiry_date)
             ORDER BY li.sort_order)
           || jsonb_build_array(jsonb_build_object('product_id', v_pc, 'qty', 2, 'unit_price_foreign', '90'))
    INTO v_json FROM lot_items li WHERE li.lot_id = v_open;
    BEGIN
      PERFORM inventory_save_lot(jsonb_build_object('id', v_open, 'lot_date', (SELECT lot_date FROM lots WHERE id = v_open),
        'currency', 'BDT', 'costs_pending', false, 'notes', 'e2e', 'items', v_json, 'costs', '[]'::jsonb));
      v_err := 'saved';
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    EXECUTE 'RESET ROLE';
    PERFORM pg_temp.ck('Part 6: the opening lot L-000 can be edited (a row added; its units come in as opening stock)',
      v_err = 'saved' AND inventory_units_left(v_pc, NULL) = 2
      AND EXISTS (SELECT 1 FROM stock_movements m JOIN lot_items li ON li.id = m.lot_item_id
                  WHERE li.lot_id = v_open AND li.product_id = v_pc AND m.movement_type = 'opening'), v_err);
    PERFORM set_config('request.jwt.claims', c_admin, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    BEGIN
      PERFORM inventory_delete_lot(v_open);
      v_err := 'deleted';
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    EXECUTE 'RESET ROLE';
    PERFORM pg_temp.ck('Part 6: the opening lot can be deleted; every order stays',
      v_err = 'deleted' AND NOT EXISTS (SELECT 1 FROM lots WHERE id = v_open) AND (SELECT count(*) FROM orders) = v_orders, v_err);
    PERFORM pg_temp.ck('Part 6: sold lines from L-000 keep a stored cost after it is gone',
      NOT EXISTS (SELECT 1 FROM order_item_costs c JOIN _b45_backup_order_item_lots b ON b.order_item_id = c.order_item_id
                  JOIN _b45_backup_lot_items bl ON bl.id = b.lot_item_id
                  WHERE bl.lot_id = v_open AND c.unit_cost_bdt IS NULL));
  END IF;

  -- Who may do it.
  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN PERFORM inventory_delete_lot(v_lot); v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Permissions: a customer can''t delete a lot', v_err = 'Not authorized.', v_err);
  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_int FROM order_item_costs;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Permissions: a customer sees no stored costs', v_int = 0, v_int::text);

  -- Stock check and the ledger.
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_int FROM inventory_stock_check() WHERE product_id = ANY (v_ids) AND reason_code IN ('shop_differs', 'negative_lot', 'ledger');
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Part 2: Stock check finds nothing wrong with the test products after all of this', v_int = 0, v_int::text);
  UPDATE lot_items SET qty_remaining = qty_remaining + 5 WHERE lot_id = v_lot AND product_id = v_pb;
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT array_agg(reason_code ORDER BY reason_code)::text INTO v_err FROM inventory_stock_check() WHERE product_id = v_pb;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Part 2: … and lists a lot row whose numbers don''t add up, with the reason', v_err = '{ledger}', v_err);
  UPDATE lot_items SET qty_remaining = qty_remaining - 5 WHERE lot_id = v_lot AND product_id = v_pb;
  PERFORM pg_temp.ck('Ledger: units left = sum of movements for every test product', pg_temp.ledger_ok(v_ids));
  PERFORM pg_temp.ck('Part 7: Sales profit says how many items have no cost',
    (inventory_sales_profit('2026-01-01', '2026-12-31') -> 'totals') ? 'items_missing_cost');
END
$test$;
SELECT 'TEST_RESULT' AS tag, json_agg(json_build_object('name', name, 'ok', ok, 'detail', detail) ORDER BY n)::text AS results FROM t_res;
ROLLBACK;
