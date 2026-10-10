-- Batch 39 database tests (run by e2e/batch-39.spec.ts through the Supabase
-- command line). Everything happens inside ONE transaction that always ends
-- with an error, so every change below is undone: the throwaway test
-- products, lots and orders never exist outside this script, and Inventory
-- mode is turned on only for this transaction (inventory.test_mode). The
-- live shop never sees any of it.
--
-- The script acts as the real test accounts: {{ADMIN_EMAIL}} (the test
-- Super Admin) and {{CUSTOMER_EMAIL}} (the test customer), by setting the
-- same login claims the website sends.
--
-- Result: the last line raises 'TEST_RESULT:[{name, ok, detail}, …]'.
DO $test$
DECLARE
  v_admin   uuid;
  v_cust    uuid;
  c_admin   text;
  c_cust    text;
  c_stale   text;
  v_err     text;
  v_pa      uuid;  -- pack 1 (FEFO, cancel, edit, shortfall)
  v_pb      uuid;  -- pack 1 (profit)
  v_pc      uuid;  -- pack 1, Inventory mode Off checks
  v_pf      uuid;  -- fish oil, pack 400 pcs
  v_pv      uuid;  -- product with an option
  v_vv      uuid;  -- its option
  v_lot     uuid;
  v_lot2    uuid;
  v_oid     uuid;
  v_onum    text;
  v_o1      uuid;
  v_o2      uuid;
  v_o3      uuid;
  v_o4      uuid;
  v_item    uuid;
  v_num     numeric;
  v_num2    numeric;
  v_int     integer;
  v_txt     text;
  v_json    jsonb;
  v_ids     uuid[];
  v_today   date := (now() AT TIME ZONE 'Asia/Dhaka')::date;
  v_opening boolean;
  v_tag     text := to_char(clock_timestamp(), 'HH24MISSMS');
BEGIN
  EXECUTE 'CREATE TEMP TABLE t_res (n serial, name text, ok boolean, detail text) ON COMMIT DROP';
  EXECUTE $f$CREATE FUNCTION pg_temp.ck(p_name text, p_ok boolean, p_detail text DEFAULT '') RETURNS void
    LANGUAGE sql AS 'INSERT INTO t_res (name, ok, detail) VALUES (p_name, COALESCE(p_ok, false), COALESCE(p_detail, ''''))'$f$;
  -- qty_remaining = sum of movements, and units out = sum of order_item_lots,
  -- for every lot row of the test products.
  EXECUTE $f$CREATE FUNCTION pg_temp.ledger_ok(p_ids uuid[]) RETURNS boolean LANGUAGE sql AS '
    SELECT NOT EXISTS (
      SELECT 1 FROM lot_items li
      WHERE li.product_id = ANY (p_ids)
        AND (li.qty_remaining <> (SELECT COALESCE(sum(m.qty), 0) FROM stock_movements m WHERE m.lot_item_id = li.id)
             OR (SELECT COALESCE(-sum(m.qty), 0) FROM stock_movements m WHERE m.lot_item_id = li.id AND m.movement_type IN (''sale'', ''cancel'', ''return''))
                <> (SELECT COALESCE(sum(o.units - o.units_back), 0) FROM order_item_lots o WHERE o.lot_item_id = li.id)))'$f$;

  SELECT id INTO v_admin FROM auth.users WHERE lower(email) = lower('{{ADMIN_EMAIL}}');
  SELECT id INTO v_cust FROM auth.users WHERE lower(email) = lower('{{CUSTOMER_EMAIL}}');
  IF v_admin IS NULL OR v_cust IS NULL THEN
    RAISE EXCEPTION 'TEST_SETUP:the test accounts were not found';
  END IF;
  c_admin := json_build_object('sub', v_admin, 'role', 'authenticated',
    'amr', json_build_array(json_build_object('method', 'password', 'timestamp', extract(epoch FROM now())::bigint)))::text;
  c_stale := json_build_object('sub', v_admin, 'role', 'authenticated',
    'amr', json_build_array(json_build_object('method', 'password', 'timestamp', extract(epoch FROM now())::bigint - 3600)))::text;
  c_cust := json_build_object('sub', v_cust, 'role', 'authenticated')::text;
  v_opening := EXISTS (SELECT 1 FROM lots WHERE kind = 'opening');

  -- Throwaway products (they exist only inside this transaction).
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('E2E-B39-A-' || v_tag, 'e2e-b39-a-' || v_tag, 'E2E B39 Cleanser', 1000, 'in_stock', 0, true) RETURNING id INTO v_pa;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('E2E-B39-B-' || v_tag, 'e2e-b39-b-' || v_tag, 'E2E B39 Toner', 1000, 'in_stock', 0, true) RETURNING id INTO v_pb;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('E2E-B39-C-' || v_tag, 'e2e-b39-c-' || v_tag, 'E2E B39 Mask', 500, 'in_stock', 5, true) RETURNING id INTO v_pc;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active, stock_unit, pack_size)
  VALUES ('E2E-B39-F-' || v_tag, 'e2e-b39-f-' || v_tag, 'E2E B39 Fish Oil 1000mg', 2000, 'in_stock', 0, true, 'pcs', 400) RETURNING id INTO v_pf;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('E2E-B39-V-' || v_tag, 'e2e-b39-v-' || v_tag, 'E2E B39 Serum', 900, 'in_stock', NULL, true) RETURNING id INTO v_pv;
  INSERT INTO product_variants (product_id, region, size, retail_price, stock_quantity, in_stock)
  VALUES (v_pv, 'AU', '30 ml', 900, 0, true) RETURNING id INTO v_vv;
  v_ids := ARRAY[v_pa, v_pb, v_pc, v_pf, v_pv];

  -- ======================================================= Mode OFF: as today
  PERFORM set_config('inventory.test_mode', '', true);
  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT order_id, order_number INTO v_oid, v_onum FROM place_order(
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_pc, 'quantity', 2)),
    p_full_name => 'E2E B39', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka',
    p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod');
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Off: website order lowers the stock number as before',
    (SELECT stock_quantity FROM products WHERE id = v_pc) = 3);
  PERFORM pg_temp.ck('Off: nothing is taken from lots',
    NOT EXISTS (SELECT 1 FROM order_item_lots WHERE order_id = v_oid));
  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM cancel_order(v_oid, NULL);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Off: cancel puts the stock number back as before',
    (SELECT stock_quantity FROM products WHERE id = v_pc) = 5);

  -- ===================================================== Mode ON from here on
  PERFORM set_config('inventory.test_mode', 'on', true);

  -- ---------- Part 0: units in lots
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_lot := inventory_save_lot(jsonb_build_object(
    'source_type', 'import', 'country', 'Australia', 'lot_date', '2026-09-01', 'costs_pending', false, 'notes', 'e2e b39',
    'items', jsonb_build_array(
      jsonb_build_object('product_id', v_pf, 'qty', 2, 'entry_unit', 'pack', 'unit_price_foreign', '1200', 'expiry_date', '2027-01-01'),
      jsonb_build_object('product_id', v_pf, 'qty', 250, 'entry_unit', 'unit', 'unit_price_foreign', '3', 'expiry_date', '2026-12-01')),
    'costs', '[]'::jsonb));
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Units: 2 packs of 400 = 800 units, 250 loose units = 250',
    (SELECT array_agg(qty ORDER BY sort_order) FROM lot_items WHERE lot_id = v_lot) = ARRAY[800, 250],
    (SELECT array_agg(qty ORDER BY sort_order)::text FROM lot_items WHERE lot_id = v_lot));
  PERFORM pg_temp.ck('Units: buy price per pack and per unit become cost per unit (৳3)',
    (SELECT array_agg(landed_unit_cost_bdt ORDER BY sort_order) FROM lot_items WHERE lot_id = v_lot) = ARRAY[3::numeric, 3::numeric]
    AND (SELECT sum(buy_value_bdt) FROM lot_items WHERE lot_id = v_lot) = 3150,
    (SELECT array_agg(landed_unit_cost_bdt ORDER BY sort_order)::text FROM lot_items WHERE lot_id = v_lot));
  PERFORM pg_temp.ck('Units: shop stock = whole packs (1050 units → 2)',
    (SELECT stock_quantity FROM products WHERE id = v_pf) = 2, (SELECT stock_quantity::text FROM products WHERE id = v_pf));

  -- Website order of 1 pack takes 400 units (earliest expiry first).
  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT order_id, order_number INTO v_oid, v_onum FROM place_order(
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_pf, 'quantity', 1)),
    p_full_name => 'E2E B39', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka',
    p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod');
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Units: website order of 1 pack takes 400 units (250 + 150, earliest expiry first)',
    (SELECT array_agg(o.units ORDER BY o.seq) FROM order_item_lots o WHERE o.order_id = v_oid) = ARRAY[250, 150],
    (SELECT array_agg(o.units ORDER BY o.seq)::text FROM order_item_lots o WHERE o.order_id = v_oid));
  PERFORM pg_temp.ck('Units: shop stock after 1 pack sold = floor(650 / 400) = 1',
    (SELECT stock_quantity FROM products WHERE id = v_pf) = 1);

  -- Admin sells 150 pcs at a custom price.
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT order_id INTO v_o1 FROM admin_create_order_v2(
    p_source => 'phone', p_items => jsonb_build_array(jsonb_build_object('product_id', v_pf, 'quantity', 150, 'sold_unit', 'pcs', 'sold_price', 8)),
    p_full_name => 'E2E B39 admin', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Units: admin order of 150 pcs at ৳8 each (list ৳5 per pc)',
    (SELECT sold_unit = 'pcs' AND quantity = 150 AND unit_price = 8 AND list_price = 5 AND line_total = 1200
     FROM order_items WHERE order_id = v_o1),
    (SELECT format('%s %s %s %s', sold_unit, quantity, unit_price, list_price) FROM order_items WHERE order_id = v_o1));
  PERFORM pg_temp.ck('Units: 150 units taken from lots; 500 left = 1 whole pack',
    (SELECT sum(units) FROM order_item_lots WHERE order_id = v_o1) = 150
    AND inventory_units_left(v_pf, NULL) = 500 AND (SELECT stock_quantity FROM products WHERE id = v_pf) = 1);
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM admin_set_order_status(v_o1, 'cancelled', 'e2e');
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Units: cancelling the 150 pcs order gives the 150 units back',
    inventory_units_left(v_pf, NULL) = 650);

  -- ---------- Part 2: earliest expiry first across 3 lots
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM inventory_save_lot(jsonb_build_object('source_type', 'wholesale', 'lot_date', '2026-09-01', 'costs_pending', false, 'notes', '',
    'items', jsonb_build_array(jsonb_build_object('product_id', v_pa, 'qty', 2, 'unit_price_foreign', '100', 'expiry_date', '2027-06-01')),
    'costs', '[]'::jsonb));
  PERFORM inventory_save_lot(jsonb_build_object('source_type', 'wholesale', 'lot_date', '2026-09-02', 'costs_pending', false, 'notes', '',
    'items', jsonb_build_array(jsonb_build_object('product_id', v_pa, 'qty', 2, 'unit_price_foreign', '110', 'expiry_date', '2027-03-01')),
    'costs', '[]'::jsonb));
  PERFORM inventory_save_lot(jsonb_build_object('source_type', 'wholesale', 'lot_date', '2026-09-03', 'costs_pending', false, 'notes', '',
    'items', jsonb_build_array(jsonb_build_object('product_id', v_pa, 'qty', 2, 'unit_price_foreign', '120')),
    'costs', '[]'::jsonb));
  PERFORM set_config('request.jwt.claims', c_cust, true);
  SELECT order_id, order_number INTO v_oid, v_onum FROM place_order(
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_pa, 'quantity', 5)),
    p_full_name => 'E2E B39', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka',
    p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod');
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('FEFO: 5 units = 2 expiring Mar 2027, 2 expiring Jun 2027, 1 with no expiry',
    (SELECT array_agg(format('%s@%s', o.units, round(o.unit_cost_bdt)) ORDER BY o.seq) FROM order_item_lots o WHERE o.order_id = v_oid)
      = ARRAY['2@110', '2@100', '1@120'],
    (SELECT array_agg(format('%s@%s', o.units, round(o.unit_cost_bdt)) ORDER BY o.seq)::text FROM order_item_lots o WHERE o.order_id = v_oid));
  PERFORM pg_temp.ck('FEFO: shop stock follows the lots (6 − 5 = 1)', (SELECT stock_quantity FROM products WHERE id = v_pa) = 1);
  PERFORM pg_temp.ck('Ledger: qty_remaining = sum of movements after the sale', pg_temp.ledger_ok(v_ids));

  -- Website checkout still refuses when stock is short.
  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    PERFORM place_order(
      p_items => jsonb_build_array(jsonb_build_object('product_id', v_pa, 'quantity', 2)),
      p_full_name => 'E2E B39', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka',
      p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod');
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  -- Cancel → back to the exact lot rows.
  PERFORM cancel_order(v_oid, NULL);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Website: short stock is still refused ("Only 1 … left")', v_err LIKE 'Only 1 of %', v_err);
  PERFORM pg_temp.ck('Cancel: units go back to the same lot rows (cancel movements 2, 2, 1)',
    (SELECT array_agg(m.qty ORDER BY li.expiry_date NULLS LAST) FROM stock_movements m JOIN lot_items li ON li.id = m.lot_item_id
     WHERE m.reference = v_onum AND m.movement_type = 'cancel') = ARRAY[2, 2, 1]
    AND (SELECT array_agg(qty_remaining) FROM lot_items WHERE product_id = v_pa) = ARRAY[2, 2, 2]);
  PERFORM pg_temp.ck('Cancel: shop stock back to 6', (SELECT stock_quantity FROM products WHERE id = v_pa) = 6);
  PERFORM pg_temp.ck('Ledger: qty_remaining = sum of movements after cancel', pg_temp.ledger_ok(v_ids));

  -- ---------- Order edit: increase takes, reduce gives back the newest units
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT order_id INTO v_o2 FROM admin_create_order_v2(
    p_source => 'phone', p_items => jsonb_build_array(jsonb_build_object('product_id', v_pa, 'quantity', 1)),
    p_full_name => 'E2E B39 admin', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80);
  SELECT id INTO v_item FROM order_items WHERE order_id = v_o2;
  PERFORM admin_edit_order(v_o2, jsonb_build_object('items', jsonb_build_array(jsonb_build_object('id', v_item, 'quantity', 4))));
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Edit: 1 → 4 takes 3 more (2 Mar + 2 Jun 2027 lots)',
    inventory_item_held(v_item) = 4 AND inventory_units_left(v_pa, NULL) = 2);
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM admin_edit_order(v_o2, jsonb_build_object('items', jsonb_build_array(jsonb_build_object('id', v_item, 'quantity', 2))));
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Edit: 4 → 2 gives back the 2 units taken last (the Jun 2027 lot)',
    inventory_item_held(v_item) = 2
    AND (SELECT qty_remaining FROM lot_items WHERE product_id = v_pa AND expiry_date = '2027-06-30') = 2
    AND (SELECT qty_remaining FROM lot_items WHERE product_id = v_pa AND expiry_date = '2027-03-31') = 0);
  PERFORM pg_temp.ck('Ledger: qty_remaining = sum of movements after edits', pg_temp.ledger_ok(v_ids));

  -- ---------- Selling without stock (admin only)
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    PERFORM admin_create_order_v2(
      p_source => 'phone', p_items => jsonb_build_array(jsonb_build_object('product_id', v_pa, 'quantity', 10)),
      p_full_name => 'E2E B39 admin', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
      p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80);
    v_err := NULL;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  SELECT order_id INTO v_o3 FROM admin_create_order_v2(
    p_source => 'phone', p_items => jsonb_build_array(jsonb_build_object('product_id', v_pa, 'quantity', 10)),
    p_full_name => 'E2E B39 admin', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80, p_allow_negative_stock => true);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Short: admin is asked first (STOCK_WARNING, 4 available in units)',
    v_err LIKE 'STOCK_WARNING:%' AND (substring(v_err FROM 15)::jsonb -> 0 ->> 'available')::int = 4, v_err);
  PERFORM pg_temp.ck('Short: "sell anyway" takes the 4 units and records 6 as sold without stock at the latest cost (৳120)',
    (SELECT sum(units) FROM order_item_lots WHERE order_id = v_o3) = 4
    AND (SELECT units = 6 AND status = 'open' AND provisional_unit_cost_bdt = 120 FROM stock_shortfalls WHERE order_id = v_o3),
    (SELECT format('%s %s %s', units, status, provisional_unit_cost_bdt) FROM stock_shortfalls WHERE order_id = v_o3));
  PERFORM pg_temp.ck('Short: shop stock shows sold out (0)', (SELECT stock_quantity FROM products WHERE id = v_pa) = 0);
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_lot2 := inventory_save_lot(jsonb_build_object('source_type', 'wholesale', 'lot_date', v_today, 'costs_pending', false, 'notes', '',
    'items', jsonb_build_array(jsonb_build_object('product_id', v_pa, 'qty', 10, 'unit_price_foreign', '150')),
    'costs', '[]'::jsonb));
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Short: the next lot fills it first (sale movement from the new lot, real cost ৳150 stored)',
    (SELECT status = 'filled' AND real_unit_cost_bdt = 150 FROM stock_shortfalls WHERE order_id = v_o3 AND units = 6)
    AND (SELECT qty_remaining FROM lot_items WHERE lot_id = v_lot2) = 4
    AND EXISTS (SELECT 1 FROM stock_movements m JOIN lot_items li ON li.id = m.lot_item_id
                WHERE li.lot_id = v_lot2 AND m.movement_type = 'sale' AND m.qty = -6));
  PERFORM pg_temp.ck('Short: the difference (150 − 120) × 6 = ৳180 is a cost adjustment dated today',
    (SELECT amount_bdt = 180 AND adj_date = v_today FROM cost_adjustments WHERE order_id = v_o3 AND reason = 'shortfall_filled'));
  PERFORM pg_temp.ck('Short: the order keeps the provisional cost (6 × ৳120 locked)',
    (SELECT unit_cost_bdt FROM order_item_lots WHERE order_id = v_o3 AND lot_item_id = (SELECT id FROM lot_items WHERE lot_id = v_lot2)) = 120);
  PERFORM pg_temp.ck('Ledger: qty_remaining = sum of movements after the fill', pg_temp.ledger_ok(v_ids));
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM admin_set_order_status(v_o3, 'cancelled', 'e2e');
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Short: cancelling it gives all 10 units back and undoes the ৳180 adjustment',
    inventory_units_left(v_pa, NULL) = 14
    AND (SELECT COALESCE(sum(amount_bdt), 0) FROM cost_adjustments WHERE order_id = v_o3) = 0);

  -- ---------- Late bill after a partial sale (product with an option)
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_lot := inventory_save_lot(jsonb_build_object('source_type', 'wholesale', 'lot_date', '2026-10-01', 'costs_pending', true, 'notes', '',
    'items', jsonb_build_array(jsonb_build_object('product_id', v_pv, 'variant_id', v_vv, 'qty', 10, 'unit_price_foreign', '500')),
    'costs', '[]'::jsonb));
  SELECT order_id INTO v_o4 FROM admin_create_order_v2(
    p_source => 'phone', p_items => jsonb_build_array(jsonb_build_object('product_id', v_pv, 'variant_id', v_vv, 'quantity', 4)),
    p_full_name => 'E2E B39 admin', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80);
  PERFORM inventory_save_lot(jsonb_build_object('id', v_lot, 'source_type', 'wholesale', 'lot_date', '2026-10-01', 'costs_pending', false, 'notes', '',
    'items', jsonb_build_array(jsonb_build_object('id', (SELECT id FROM lot_items WHERE lot_id = v_lot), 'product_id', v_pv, 'variant_id', v_vv,
                                                  'qty', 10, 'unit_price_foreign', '500')),
    'costs', jsonb_build_array(jsonb_build_object('cost_type', 'other', 'amount_bdt', '100.01', 'cost_date', '2026-10-05', 'note', 'Late courier bill'))));
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Late bill: sold units keep their locked cost (৳500)',
    (SELECT bool_and(unit_cost_bdt = 500) FROM order_item_lots WHERE order_id = v_o4));
  PERFORM pg_temp.ck('Late bill: unsold units take the new cost (৳510.001)',
    (SELECT landed_unit_cost_bdt FROM lot_items WHERE lot_id = v_lot) = 510.001,
    (SELECT landed_unit_cost_bdt::text FROM lot_items WHERE lot_id = v_lot));
  PERFORM pg_temp.ck('Late bill: adjustment = 10.001 × 4 sold = ৳40.00, dated the bill''s date',
    (SELECT amount_bdt = 40.00 AND adj_date = '2026-10-05' AND reason = 'late_bill' FROM cost_adjustments WHERE lot_id = v_lot),
    (SELECT format('%s %s', amount_bdt, adj_date) FROM cost_adjustments WHERE lot_id = v_lot));
  PERFORM pg_temp.ck('Late bill: the lot''s shares still add up to the bill to the paisa',
    (SELECT sum(alloc_other_paisa) FROM lot_items WHERE lot_id = v_lot) = 10001);

  -- ---------- Return: back to the same lot rows
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM admin_set_order_status(v_o4, 'shipped', 'e2e');
  PERFORM admin_mark_order_returned(v_o4, 'e2e');
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Return: order is Returned and its 4 units are back (return movement)',
    (SELECT status FROM orders WHERE id = v_o4) = 'returned'
    AND (SELECT qty_remaining FROM lot_items WHERE lot_id = v_lot) = 10
    AND EXISTS (SELECT 1 FROM stock_movements m JOIN lot_items li ON li.id = m.lot_item_id
                WHERE li.lot_id = v_lot AND m.movement_type = 'return' AND m.qty = 4));
  PERFORM pg_temp.ck('Return: the option''s shop stock is back to 10',
    (SELECT stock_quantity FROM product_variants WHERE id = v_vv) = 10);
  PERFORM pg_temp.ck('Return: the late-bill share of the returned units is undone (adjustments net ৳0)',
    (SELECT COALESCE(sum(amount_bdt), 0) FROM cost_adjustments WHERE lot_id = v_lot) = 0);
  PERFORM pg_temp.ck('Ledger: qty_remaining = sum of movements after the return', pg_temp.ledger_ok(v_ids));

  -- ---------- Part 1: missing weight no longer blocks; guessed from price
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_lot := inventory_save_lot(jsonb_build_object('source_type', 'import', 'lot_date', '2026-10-02', 'costs_pending', false, 'notes', '',
    'items', jsonb_build_array(
      jsonb_build_object('product_id', v_pa, 'qty', 2, 'unit_price_foreign', '100', 'weight_grams', '100'),
      jsonb_build_object('product_id', v_pf, 'qty', 1, 'entry_unit', 'pack', 'unit_price_foreign', '1200', 'weight_grams', NULL)),
    'costs', jsonb_build_array(jsonb_build_object('cost_type', 'weight', 'amount_bdt', '1000', 'note', 'Luggage'))));
  v_lot2 := inventory_save_lot(jsonb_build_object('source_type', 'import', 'lot_date', '2026-10-02', 'costs_pending', false, 'notes', '',
    'items', jsonb_build_array(
      jsonb_build_object('product_id', v_pa, 'qty', 3, 'unit_price_foreign', '100.33'),
      jsonb_build_object('product_id', v_pb, 'qty', 7, 'unit_price_foreign', '41.17')),
    'costs', jsonb_build_array(jsonb_build_object('cost_type', 'weight', 'amount_bdt', '500.05'))));
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Weight: a row without weight is guessed from price and marked',
    (SELECT array_agg(weight_guessed ORDER BY sort_order) FROM lot_items WHERE lot_id = v_lot) = ARRAY[false, true]);
  PERFORM pg_temp.ck('Weight: guessed share = 1000 × 12000000·20000 / (20000·2000000 + 12000000·20000) → ৳857.14 + ৳142.86, exact',
    (SELECT array_agg(alloc_weight_paisa ORDER BY sort_order) FROM lot_items WHERE lot_id = v_lot) = ARRAY[14286::bigint, 85714::bigint],
    (SELECT array_agg(alloc_weight_paisa ORDER BY sort_order)::text FROM lot_items WHERE lot_id = v_lot));
  PERFORM pg_temp.ck('Weight: no row weighted → shared by buy value, totals exact to the paisa',
    (SELECT sum(alloc_weight_paisa) FROM lot_items WHERE lot_id = v_lot2) = 50005
    AND (SELECT bool_and(weight_guessed) FROM lot_items WHERE lot_id = v_lot2),
    (SELECT array_agg(alloc_weight_paisa ORDER BY sort_order)::text FROM lot_items WHERE lot_id = v_lot2));

  -- An old lot in another currency still works out the same.
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_lot := inventory_save_lot(jsonb_build_object('source_type', 'import', 'lot_date', '2026-08-01', 'costs_pending', false, 'notes', '',
    'currency', 'AUD', 'exchange_rate', '78.4567',
    'items', jsonb_build_array(jsonb_build_object('product_id', v_pb, 'qty', 3, 'unit_price_foreign', '12.35', 'weight_grams', '271')),
    'costs', jsonb_build_array(jsonb_build_object('cost_type', 'weight', 'amount_bdt', '100'))));
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Currency: an AUD lot is still 12.35 × 78.4567 = ৳968.9402 + share per unit',
    (SELECT unit_price_bdt = 968.9402 AND alloc_weight_paisa = 10000 AND landed_unit_cost_bdt = 1002.273533
     FROM lot_items WHERE lot_id = v_lot),
    (SELECT format('%s %s %s', unit_price_bdt, alloc_weight_paisa, landed_unit_cost_bdt) FROM lot_items WHERE lot_id = v_lot));

  -- ---------- Part 3: profit
  -- Toner (pack 1): 20 units at ৳100.
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM inventory_save_lot(jsonb_build_object('source_type', 'wholesale', 'lot_date', '2026-06-01', 'costs_pending', false, 'notes', '',
    'items', jsonb_build_array(jsonb_build_object('product_id', v_pb, 'qty', 20, 'unit_price_foreign', '100', 'expiry_date', '2026-11-01')),
    'costs', '[]'::jsonb));
  -- O1: 2 at ৳400 (item discount from ৳1000), order discount ৳50, delivery ৳80.
  SELECT order_id INTO v_o1 FROM admin_create_order_v2(
    p_source => 'phone', p_items => jsonb_build_array(jsonb_build_object('product_id', v_pb, 'quantity', 2, 'sold_price', 400)),
    p_full_name => 'E2E B39 admin', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80,
    p_order_discount => 50, p_discount_reason => 'promotion');
  -- O2: free delivery, 1 at full price.
  SELECT order_id INTO v_o2 FROM admin_create_order_v2(
    p_source => 'phone', p_items => jsonb_build_array(jsonb_build_object('product_id', v_pb, 'quantity', 1)),
    p_full_name => 'E2E B39 admin', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 0);
  -- O3: returned. O4: cancelled.
  SELECT order_id INTO v_o3 FROM admin_create_order_v2(
    p_source => 'phone', p_items => jsonb_build_array(jsonb_build_object('product_id', v_pb, 'quantity', 1)),
    p_full_name => 'E2E B39 admin', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Test road', p_delivery_zone => 'outside_dhaka', p_delivery_fee => 130);
  SELECT order_id INTO v_o4 FROM admin_create_order_v2(
    p_source => 'phone', p_items => jsonb_build_array(jsonb_build_object('product_id', v_pb, 'quantity', 1)),
    p_full_name => 'E2E B39 admin', p_phone => '01700000000', p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80);
  PERFORM admin_set_order_status(v_o1, 'delivered', 'e2e');
  PERFORM admin_set_order_status(v_o2, 'delivered', 'e2e');
  PERFORM admin_set_order_status(v_o3, 'shipped', 'e2e');
  PERFORM admin_mark_order_returned(v_o3, 'e2e');
  PERFORM admin_set_order_status(v_o4, 'cancelled', 'e2e');
  EXECUTE 'RESET ROLE';
  INSERT INTO order_courier_costs (order_id, delivery_charge, cod_fee, other_deduction, total_kept)
  VALUES (v_o1, 60, 8.3, 0, 68.3), (v_o3, 60, 0, 0, 60);

  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_json := order_profit(v_o1);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Profit: sale 800 − 50 = 750, cost 200, delivery 80, courier + COD 68.30 → ৳561.70 (74.9%)',
    (v_json ->> 'sale')::numeric = 750 AND (v_json ->> 'cost')::numeric = 200 AND (v_json ->> 'delivery')::numeric = 80
    AND (v_json ->> 'courier')::numeric = 68.3 AND (v_json ->> 'profit')::numeric = 561.7 AND (v_json ->> 'margin')::numeric = 74.9,
    v_json::text);
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_json := order_profit(v_o2);
  v_txt := order_profit(v_o3)::text;
  v_err := order_profit(v_o4)::text;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Profit: free delivery → delivery collected 0, courier not known yet → profit ৳900',
    (v_json ->> 'delivery')::numeric = 0 AND (v_json ->> 'profit')::numeric = 900 AND (v_json ->> 'courier_known')::boolean = false,
    v_json::text);
  PERFORM pg_temp.ck('Profit: returned → sale 0, cost 0, the courier charge is the loss (−৳60)',
    (v_txt::jsonb ->> 'profit')::numeric = -60 AND (v_txt::jsonb ->> 'cost')::numeric = 0, v_txt);
  PERFORM pg_temp.ck('Profit: cancelled → nothing', (v_err::jsonb ->> 'profit')::numeric = 0, v_err);

  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_json := inventory_sales_profit(v_today, v_today);
  v_txt := inventory_sales_profit(v_today - 1, v_today - 1)::text;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Sales profit: counted on the Delivered date (today, not yesterday)',
    EXISTS (SELECT 1 FROM jsonb_array_elements(v_json -> 'orders') o WHERE (o ->> 'order_id')::uuid = v_o1)
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_txt::jsonb -> 'orders') o WHERE (o ->> 'order_id')::uuid = v_o1));
  PERFORM pg_temp.ck('Sales profit: the toner row = 3 units, sales 750 + 1000, cost 300',
    EXISTS (SELECT 1 FROM jsonb_array_elements(v_json -> 'products') p
            WHERE (p ->> 'product_id')::uuid = v_pb AND (p ->> 'units')::int = 3
              AND (p ->> 'sales')::numeric = 1750 AND (p ->> 'cost')::numeric = 300),
    (SELECT p::text FROM jsonb_array_elements(v_json -> 'products') p WHERE (p ->> 'product_id')::uuid = v_pb));
  PERFORM pg_temp.ck('Sales profit: per-product sales and cost add up to the order totals',
    (SELECT sum((p ->> 'sales')::numeric) FROM jsonb_array_elements(v_json -> 'products') p) = (v_json -> 'totals' ->> 'sales')::numeric
    AND (SELECT COALESCE(sum((p ->> 'cost')::numeric), 0) FROM jsonb_array_elements(v_json -> 'products') p) = (v_json -> 'totals' ->> 'cost')::numeric,
    (v_json -> 'totals')::text);
  PERFORM pg_temp.ck('Sales profit: the returned order is listed with its loss',
    EXISTS (SELECT 1 FROM jsonb_array_elements(v_json -> 'orders') o
            WHERE (o ->> 'order_id')::uuid = v_o3 AND (o ->> 'profit')::numeric = -60));

  -- ---------- Permissions: nobody without "View profit & costs"
  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN PERFORM order_profit(v_o1); v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  BEGIN PERFORM inventory_sales_profit(v_today, v_today); v_txt := 'allowed'; EXCEPTION WHEN OTHERS THEN v_txt := SQLERRM; END;
  SELECT (SELECT count(*) FROM order_item_lots) + (SELECT count(*) FROM stock_shortfalls) + (SELECT count(*) FROM cost_adjustments)
       + (SELECT count(*) FROM suppliers) + (SELECT count(*) FROM lots) + (SELECT count(*) FROM inventory_shortfall_list())
       + (SELECT count(*) FROM inventory_stock_units())
  INTO v_int;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Permissions: a customer gets "Not authorized" for profit and sees 0 cost / lot / shortfall rows',
    v_err = 'Not authorized.' AND v_txt = 'Not authorized.' AND v_int = 0, format('%s | %s | %s', v_err, v_txt, v_int));
  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN PERFORM inventory_give_back(v_item, NULL, 'cancel', 'x'); v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  BEGIN PERFORM inventory_set_pack(v_pf, NULL, 'pcs', 1); v_txt := 'allowed'; EXCEPTION WHEN OTHERS THEN v_txt := SQLERRM; END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Permissions: a customer can''t run the stock functions or change a pack size',
    v_err LIKE 'permission denied%' AND v_txt = 'Not authorized.', format('%s | %s', v_err, v_txt));
  -- A staff member WITHOUT "View profit & costs" (the test customer made a
  -- moderator with Orders + Edit products, inside this transaction only).
  PERFORM set_config('request.jwt.claims', c_admin, true);
  UPDATE profiles SET role = 'moderator', status = 'approved' WHERE id = v_cust;
  INSERT INTO staff_members (id, username, full_name, permissions, is_disabled)
  VALUES (v_cust, 'e2e.b39.staff.' || v_tag, 'E2E B39 staff', ARRAY['view_orders', 'edit_orders', 'create_orders', 'edit_products'], false)
  ON CONFLICT (id) DO UPDATE SET permissions = EXCLUDED.permissions, role_id = NULL, is_disabled = false;
  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN PERFORM order_profit(v_o1); v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  BEGIN PERFORM inventory_sales_profit(v_today, v_today); v_txt := 'allowed'; EXCEPTION WHEN OTHERS THEN v_txt := SQLERRM; END;
  SELECT (SELECT count(*) FROM order_item_lots) + (SELECT count(*) FROM stock_shortfalls) + (SELECT count(*) FROM cost_adjustments)
       + (SELECT count(*) FROM suppliers) + (SELECT count(*) FROM lots) + (SELECT count(*) FROM lot_items)
       + (SELECT count(*) FROM inventory_shortfall_list()) + (SELECT count(*) FROM inventory_stock_units())
  INTO v_int;
  BEGIN PERFORM inventory_set_pack(v_pf, NULL, 'pcs', 400); v_json := '{"pack":"ok"}'; EXCEPTION WHEN OTHERS THEN v_json := jsonb_build_object('pack', SQLERRM); END;
  SELECT count(*) INTO v_num FROM inventory_pack_units() WHERE product_id = v_pf;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Permissions: staff without "View profit & costs" see no cost, profit, lot or shortfall data',
    v_err = 'Not authorized.' AND v_txt = 'Not authorized.' AND v_int = 0, format('%s | %s | %s', v_err, v_txt, v_int));
  PERFORM pg_temp.ck('Permissions: staff with "Edit products" can set a pack size (not a cost)',
    v_json ->> 'pack' = 'ok' AND v_num = 1, v_json::text);

  PERFORM set_config('request.jwt.claims', '', true);
  EXECUTE 'SET LOCAL ROLE anon';
  BEGIN PERFORM count(*) FROM order_item_lots; v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
  BEGIN PERFORM order_profit(v_o1); v_txt := 'allowed'; EXCEPTION WHEN OTHERS THEN v_txt := SQLERRM; END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Permissions: the public can read nothing',
    v_err LIKE 'permission denied%' AND v_txt LIKE 'permission denied%', format('%s | %s', v_err, v_txt));

  -- ---------- Part 4: the switch
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    INSERT INTO app_settings (key, value) VALUES ('inventory_mode', 'true')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
    v_err := 'allowed';
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM set_config('request.jwt.claims', c_stale, true);
  BEGIN PERFORM inventory_set_mode(true, false); v_txt := 'allowed'; EXCEPTION WHEN OTHERS THEN v_txt := SQLERRM; END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Mode: the setting can''t be switched On directly', v_err LIKE 'Inventory mode changes only from Settings%', v_err);
  PERFORM pg_temp.ck('Mode: turning On needs the password again', v_txt = 'Please confirm your password again.', v_txt);

  IF NOT v_opening THEN
    PERFORM set_config('request.jwt.claims', c_admin, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    BEGIN PERFORM inventory_set_mode(true, false); v_err := 'allowed'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
    -- Opening stock with a pack size and loose units: 2 bottles + 250 pcs.
    v_lot := inventory_confirm_opening(v_today, 10, jsonb_build_array(
      jsonb_build_object('product_id', v_pf, 'source', 'import', 'buy_price_bdt', '1200', 'pieces', 2, 'extra_units', 250, 'expiry', '2027-05-01'),
      jsonb_build_object('product_id', v_pc, 'source', 'wholesale', 'buy_price_bdt', '200', 'pieces', 3)), 'e2e-b39.xlsx');
    v_json := inventory_set_mode(true, false);
    EXECUTE 'RESET ROLE';
    PERFORM pg_temp.ck('Mode: can''t turn On without the opening stock (L-000)', v_err LIKE '%opening stock (L-000)%', v_err);
    PERFORM pg_temp.ck('Opening: 2 packs × 400 + 250 extra = 1050 units at ৳3 + 10% = ৳3.30 per unit',
      (SELECT qty = 1050 AND landed_unit_cost_bdt = 3.3 AND buy_value_bdt = 3150 FROM lot_items WHERE lot_id = v_lot AND product_id = v_pf),
      (SELECT format('%s %s %s', qty, landed_unit_cost_bdt, buy_value_bdt) FROM lot_items WHERE lot_id = v_lot AND product_id = v_pf));
    PERFORM pg_temp.ck('Mode: On once L-000 exists; the setting is saved',
      (v_json ->> 'changed')::boolean AND (SELECT value FROM app_settings WHERE key = 'inventory_mode') = 'true', v_json::text);
    PERFORM pg_temp.ck('Mode: On → the shop''s stock numbers come from lots (mask: 3 opening packs)',
      (SELECT stock_quantity FROM products WHERE id = v_pc) = 3);
  ELSE
    PERFORM pg_temp.ck('Mode: real opening stock exists — the On checks ran on test data only', true, 'skipped');
  END IF;

  PERFORM pg_temp.ck('Ledger: qty_remaining = sum of movements at the end', pg_temp.ledger_ok(v_ids));

  RAISE EXCEPTION 'TEST_RESULT:%', (SELECT json_agg(json_build_object('name', name, 'ok', ok, 'detail', detail) ORDER BY n) FROM t_res);
END
$test$;
