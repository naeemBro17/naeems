-- Batch 51 database tests (run by e2e/batch-51.spec.ts through the Supabase
-- command line) against today's functions on the live database (Batch 61:
-- no old migration is replayed any more). The runner first saves
-- money_position() in t_pos0 (e2e/sql/batch-51-before.sql), so everything —
-- the made-up products, lots, orders and wishlist rows — runs inside ONE
-- transaction that always ends with ROLLBACK. Inventory
-- mode is switched only inside it (inventory.test_mode / mode_change).
-- Nothing real is changed.
--
-- Result: the rows (name, ok, detail) of the SELECT before the ROLLBACK.
DO $test$
DECLARE
  v_admin  uuid;
  v_cust   uuid;
  c_admin  text;
  c_cust   text;
  c_anon   text;
  v_err    text;
  v_pk     uuid;  -- keep selling, On mode
  v_po     uuid;  -- sells only from stock, On mode
  v_pv     uuid;  -- keep selling, with an option
  v_vv     uuid;
  v_px     uuid;  -- keep selling, Off mode
  v_py     uuid;  -- sells only from stock, Off mode
  v_ps     uuid;  -- Steadfast checks
  v_o1     uuid;
  v_o2     uuid;
  v_o3     uuid;
  v_o4     uuid;
  v_item   uuid;
  v_int    integer;
  v_txt    text;
  v_bool   boolean;
  v_json   jsonb;
  v_pos1   jsonb;
  v_tag    text := to_char(clock_timestamp(), 'HH24MISSMS');
  v_addr   jsonb;
BEGIN
  EXECUTE 'CREATE TEMP TABLE t_res (n serial, name text, ok boolean, detail text)';
  EXECUTE $f$CREATE FUNCTION pg_temp.ck(p_name text, p_ok boolean, p_detail text DEFAULT '') RETURNS void
    LANGUAGE sql AS 'INSERT INTO t_res (name, ok, detail) VALUES (p_name, COALESCE(p_ok, false), COALESCE(p_detail, ''''))'$f$;
  -- What the shopping list says for one product (0 = not on it).
  EXECUTE $f$CREATE FUNCTION pg_temp.to_buy(p_id uuid) RETURNS integer LANGUAGE sql AS
    'SELECT COALESCE((SELECT qty FROM admin_shopping_list() WHERE product_id = p_id), 0)'$f$;

  SELECT id INTO v_admin FROM auth.users WHERE lower(email) = lower('{{ADMIN_EMAIL}}');
  SELECT id INTO v_cust FROM auth.users WHERE lower(email) = lower('{{CUSTOMER_EMAIL}}');
  IF v_admin IS NULL OR v_cust IS NULL THEN
    RAISE EXCEPTION 'TEST_SETUP:the test accounts were not found';
  END IF;
  c_admin := json_build_object('sub', v_admin, 'role', 'authenticated', 'aal', 'aal2',
    'amr', json_build_array(json_build_object('method', 'password', 'timestamp', extract(epoch FROM now())::bigint)))::text;
  c_cust := json_build_object('sub', v_cust, 'role', 'authenticated')::text;
  c_anon := json_build_object('role', 'anon')::text;

  -- ================================================ the migration itself
  PERFORM pg_temp.ck('Settings: limit 4 and the three delivery times',
    (SELECT value FROM app_settings WHERE key = 'order_limit_per_item') IS NOT NULL
    AND (SELECT value FROM app_settings WHERE key = 'delivery_time_dhaka') IS NOT NULL
    AND (SELECT value FROM app_settings WHERE key = 'delivery_time_outside') IS NOT NULL
    AND (SELECT value FROM app_settings WHERE key = 'delivery_time_buy_after') IS NOT NULL);
  PERFORM pg_temp.ck('A new product keeps selling (default On)',
    (SELECT column_default = 'true' AND is_nullable = 'NO' FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'keep_selling'));
  PERFORM pg_temp.ck('Visitors can call cart_cover only; not the shopping list or the helpers',
    has_function_privilege('anon', 'cart_cover(jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'admin_shopping_list()', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'order_item_unstocked_qty(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'order_item_unstocked_qty(uuid)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'order_edit_line_stock(uuid,integer,text)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'stock_packs_on_hand(uuid,uuid,integer)', 'EXECUTE'));
  PERFORM pg_temp.ck('Visitors cannot read wishlists or the unstocked table',
    NOT has_table_privilege('anon', 'wishlist_items', 'SELECT')
    AND NOT has_table_privilege('anon', 'order_item_unstocked', 'SELECT'));

  -- Nothing in money: the Money position right after the migration is
  -- exactly what it was before it (t_pos0, saved by the runner).
  PERFORM set_config('request.jwt.claims', c_admin, true);
  v_pos1 := money_position();
  PERFORM pg_temp.ck('Money position: exactly the same before and after the migration',
    v_pos1 = (SELECT p FROM t_pos0), format('%s → %s', (SELECT p FROM t_pos0), v_pos1));

  -- Throwaway products (they exist only inside this transaction).
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('E2E-B51-K-' || v_tag, 'e2e-b51-k-' || v_tag, 'E2E B51 Sunscreen', 1000, 'in_stock', 0, true) RETURNING id INTO v_pk;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active, keep_selling)
  VALUES ('E2E-B51-O-' || v_tag, 'e2e-b51-o-' || v_tag, 'E2E B51 Cancer Council', 800, 'in_stock', 0, true, false) RETURNING id INTO v_po;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('E2E-B51-V-' || v_tag, 'e2e-b51-v-' || v_tag, 'E2E B51 Serum', 900, 'in_stock', NULL, true) RETURNING id INTO v_pv;
  INSERT INTO product_variants (product_id, region, size, retail_price, stock_quantity, in_stock)
  VALUES (v_pv, 'AU', '30 ml', 900, 0, false) RETURNING id INTO v_vv;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('E2E-B51-X-' || v_tag, 'e2e-b51-x-' || v_tag, 'E2E B51 Lotion', 700, 'in_stock', 2, true) RETURNING id INTO v_px;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active, keep_selling)
  VALUES ('E2E-B51-Y-' || v_tag, 'e2e-b51-y-' || v_tag, 'E2E B51 Balm', 600, 'in_stock', 2, true, false) RETURNING id INTO v_py;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('E2E-B51-S-' || v_tag, 'e2e-b51-s-' || v_tag, 'E2E B51 Toner', 1500, 'in_stock', NULL, true) RETURNING id INTO v_ps;
  PERFORM pg_temp.ck('A new product keeps selling unless switched off',
    (SELECT keep_selling FROM products WHERE id = v_pk) AND NOT (SELECT keep_selling FROM products WHERE id = v_po));

  -- ======================================== what the shop's browser reads
  PERFORM set_config('request.jwt.claims', c_anon, true);
  EXECUTE 'SET LOCAL ROLE anon';
  SELECT to_jsonb(v) INTO v_json FROM products_view v WHERE id = v_pk;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Visitor: a keep-selling product with stock 0 reads In stock, with no number',
    v_json ->> 'stock_status' = 'in_stock' AND v_json -> 'stock_quantity' = 'null'::jsonb
    AND (v_json ->> 'keep_selling')::boolean AND NOT (v_json ->> 'in_hand')::boolean, v_json::text);
  EXECUTE 'SET LOCAL ROLE anon';
  SELECT to_jsonb(v) INTO v_json FROM products_view v WHERE id = v_po;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Visitor: a sells-only-from-stock product still shows its real stock (0)',
    (v_json ->> 'stock_quantity')::integer = 0 AND NOT (v_json ->> 'in_hand')::boolean
    AND NOT (v_json ->> 'keep_selling')::boolean, v_json::text);
  EXECUTE 'SET LOCAL ROLE anon';
  SELECT to_jsonb(v) INTO v_json FROM product_variants_view v WHERE id = v_vv;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Visitor: the option of a keep-selling product reads in stock, no number',
    (v_json ->> 'in_stock')::boolean AND v_json -> 'stock_quantity' = 'null'::jsonb
    AND (v_json ->> 'keep_selling')::boolean AND NOT (v_json ->> 'in_hand')::boolean, v_json::text);
  -- The live shop is in Inventory mode On, where the stock number follows
  -- the lots; inventory.syncing lets this test set it directly.
  PERFORM set_config('inventory.syncing', 'on', true);
  UPDATE products SET stock_quantity = 3 WHERE id = v_px;
  PERFORM set_config('inventory.syncing', '', true);
  EXECUTE 'SET LOCAL ROLE anon';
  SELECT to_jsonb(v) INTO v_json FROM products_view v WHERE id = v_px;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Visitor: with stock the real number is still hidden; in_hand says yes',
    v_json -> 'stock_quantity' = 'null'::jsonb AND (v_json ->> 'in_hand')::boolean, v_json::text);
  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT to_jsonb(v) INTO v_json FROM products_view v WHERE id = v_pk;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Customer: the same (no number)', v_json -> 'stock_quantity' = 'null'::jsonb, v_json::text);
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT to_jsonb(v) INTO v_json FROM products_view v WHERE id = v_pk;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Admin: sees the real stock (0)', (v_json ->> 'stock_quantity')::integer = 0, v_json::text);

  v_addr := jsonb_build_object('n', 'E2E B51');

  -- ===================================================== Inventory mode ON
  PERFORM set_config('inventory.test_mode', 'on', true);
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM inventory_save_lot(jsonb_build_object(
    'source_type', 'wholesale', 'lot_date', '2026-11-01', 'costs_pending', false, 'notes', 'e2e b51',
    'items', jsonb_build_array(
      jsonb_build_object('product_id', v_pk, 'qty', 1, 'entry_unit', 'pack', 'unit_price_foreign', '500'),
      jsonb_build_object('product_id', v_po, 'qty', 2, 'entry_unit', 'pack', 'unit_price_foreign', '400')),
    'costs', '[]'::jsonb));
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('On: the lot sets the shop stock (1 and 2)',
    (SELECT stock_quantity FROM products WHERE id = v_pk) = 1 AND (SELECT stock_quantity FROM products WHERE id = v_po) = 2);

  PERFORM set_config('request.jwt.claims', c_anon, true);
  EXECUTE 'SET LOCAL ROLE anon';
  SELECT array_agg(covered ORDER BY ord) INTO v_txt FROM (
    SELECT c.covered, row_number() OVER () AS ord FROM cart_cover(jsonb_build_array(
      jsonb_build_object('product_id', v_pk, 'quantity', 1),
      jsonb_build_object('product_id', v_pk, 'quantity', 3),
      jsonb_build_object('product_id', v_po, 'quantity', 2))) c) x;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Cart: 1 of a product with 1 in stock is covered, 3 is not; sells-only-from-stock lines always covered',
    v_txt = '{t,f,t}', v_txt);

  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT order_id INTO v_o1 FROM place_order(
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_pk, 'quantity', 3)),
    p_full_name => 'E2E B51', p_phone => '01700000051', p_division => 'Dhaka', p_district => 'Dhaka',
    p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod');
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('On: 3 ordered with 1 in stock goes through (keep selling)', v_o1 IS NOT NULL);
  PERFORM pg_temp.ck('On: 1 taken from the lot, 2 recorded as sold without stock',
    (SELECT COALESCE(sum(units), 0) FROM order_item_lots WHERE order_id = v_o1) = 1
    AND (SELECT COALESCE(sum(units), 0) FROM stock_shortfalls WHERE order_id = v_o1 AND status = 'open') = 2,
    (SELECT COALESCE(sum(units), 0)::text FROM stock_shortfalls WHERE order_id = v_o1));
  PERFORM pg_temp.ck('On: the order is marked "bought after the order"', (SELECT buys_later FROM orders WHERE id = v_o1));
  PERFORM pg_temp.ck('On: shop stock is 0, never negative', (SELECT stock_quantity FROM products WHERE id = v_pk) = 0);

  v_err := NULL;
  BEGIN
    PERFORM set_config('request.jwt.claims', c_cust, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM place_order(
      p_items => jsonb_build_array(jsonb_build_object('product_id', v_pk, 'quantity', 5)),
      p_full_name => 'E2E B51', p_phone => '01700000051', p_division => 'Dhaka', p_district => 'Dhaka',
      p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod');
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Limit: a customer cannot order 5 of one item (limit 4)', v_err LIKE 'Limit 4 per order%', COALESCE(v_err, 'no error'));

  v_err := NULL;
  BEGIN
    PERFORM set_config('request.jwt.claims', c_cust, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM place_order(
      p_items => jsonb_build_array(jsonb_build_object('product_id', v_pk, 'quantity', 2),
                                   jsonb_build_object('product_id', v_pk, 'quantity', 3)),
      p_full_name => 'E2E B51', p_phone => '01700000051', p_division => 'Dhaka', p_district => 'Dhaka',
      p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod');
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Limit: two lines of the same item count together', v_err LIKE 'Limit 4 per order%', COALESCE(v_err, 'no error'));

  UPDATE app_settings SET value = '6' WHERE key = 'order_limit_per_item';
  v_err := NULL;
  BEGIN
    PERFORM set_config('request.jwt.claims', c_cust, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM place_order(
      p_items => jsonb_build_array(jsonb_build_object('product_id', v_pk, 'quantity', 7)),
      p_full_name => 'E2E B51', p_phone => '01700000051', p_division => 'Dhaka', p_district => 'Dhaka',
      p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod');
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Limit: follows the setting (6)', v_err LIKE 'Limit 6 per order%', COALESCE(v_err, 'no error'));
  UPDATE app_settings SET value = '4' WHERE key = 'order_limit_per_item';

  v_err := NULL;
  BEGIN
    PERFORM set_config('request.jwt.claims', c_cust, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM place_order(
      p_items => jsonb_build_array(jsonb_build_object('product_id', v_po, 'quantity', 3)),
      p_full_name => 'E2E B51', p_phone => '01700000051', p_division => 'Dhaka', p_district => 'Dhaka',
      p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod');
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Switch Off: 3 with 2 in stock is refused as before', v_err LIKE 'Only 2 of%', COALESCE(v_err, 'no error'));

  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT order_id INTO v_o2 FROM place_order(
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_po, 'quantity', 2)),
    p_full_name => 'E2E B51', p_phone => '01700000051', p_division => 'Dhaka', p_district => 'Dhaka',
    p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'outside_dhaka', p_payment_method => 'cod');
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Switch Off: 2 with 2 in stock goes through, not "bought after"',
    v_o2 IS NOT NULL AND NOT (SELECT buys_later FROM orders WHERE id = v_o2)
    AND NOT EXISTS (SELECT 1 FROM stock_shortfalls WHERE order_id = v_o2));

  -- The admin (wholesaler or admin) has no limit.
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT order_id INTO v_o3 FROM place_order(
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_pk, 'quantity', 6)),
    p_full_name => 'E2E B51', p_phone => '01700000051', p_division => 'Dhaka', p_district => 'Dhaka',
    p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod');
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Limit: wholesalers / admin have none (6 of one item)', v_o3 IS NOT NULL);

  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_int := pg_temp.to_buy(v_pk);
  SELECT orders INTO v_json FROM admin_shopping_list() WHERE product_id = v_pk;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Shopping list (On): 2 + 6 = 8 to buy, for two orders',
    v_int = 8 AND jsonb_array_length(v_json) = 2, format('%s %s', v_int, v_json));
  PERFORM pg_temp.ck('Shopping list (On): the sells-only-from-stock product is not on it', pg_temp.to_buy(v_po) = 0);

  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM cancel_order(v_o1, NULL);
  v_int := (SELECT count(*) FROM admin_shopping_list());
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Shopping list: customers get nothing from it', v_int = 0);
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_int := pg_temp.to_buy(v_pk);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Shopping list (On): a cancelled order drops out (8 → 6)', v_int = 6, v_int::text);
  PERFORM pg_temp.ck('On: cancelling gives the 1 lot unit back',
    (SELECT stock_quantity FROM products WHERE id = v_pk) = 1);

  -- A lot of 4 comes in: it fills 4 of the 6 not-in-stock units.
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM inventory_save_lot(jsonb_build_object(
    'source_type', 'wholesale', 'lot_date', '2026-11-02', 'costs_pending', false, 'notes', 'e2e b51 2',
    'items', jsonb_build_array(jsonb_build_object('product_id', v_pk, 'qty', 4, 'entry_unit', 'pack', 'unit_price_foreign', '500')),
    'costs', '[]'::jsonb));
  v_int := pg_temp.to_buy(v_pk);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Shopping list (On): a new lot reduces it (partly covered: 6 → 2)', v_int = 2, v_int::text);

  UPDATE orders SET status = 'delivered' WHERE id = v_o3;
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_int := pg_temp.to_buy(v_pk);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Shopping list: a delivered order drops out', v_int = 0, v_int::text);

  -- An option of a keep-selling product with no lot at all.
  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT order_id INTO v_o4 FROM place_order(
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_pv, 'variant_id', v_vv, 'quantity', 2)),
    p_full_name => 'E2E B51', p_phone => '01700000051', p_division => 'Dhaka', p_district => 'Dhaka',
    p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod');
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT qty, option_label INTO v_int, v_txt FROM admin_shopping_list() WHERE variant_id = v_vv;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Shopping list: one row per option ("AU · 30 ml", 2)', v_int = 2 AND v_txt = 'AU · 30 ml', format('%s %s', v_int, v_txt));

  -- ===================================================== Inventory mode OFF
  PERFORM set_config('inventory.mode_change', 'on', true);
  UPDATE app_settings SET value = 'false' WHERE key = 'inventory_mode';
  PERFORM set_config('inventory.mode_change', '', true);
  PERFORM set_config('inventory.test_mode', '', true);
  UPDATE products SET stock_quantity = 2 WHERE id IN (v_px, v_py);

  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT order_id INTO v_o1 FROM place_order(
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_px, 'quantity', 4)),
    p_full_name => 'E2E B51', p_phone => '01700000051', p_division => 'Dhaka', p_district => 'Dhaka',
    p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod');
  EXECUTE 'RESET ROLE';
  SELECT id INTO v_item FROM order_items WHERE order_id = v_o1;
  PERFORM pg_temp.ck('Off: 4 ordered with 2 in stock goes through; stock 2 → 0',
    v_o1 IS NOT NULL AND (SELECT stock_quantity FROM products WHERE id = v_px) = 0);
  PERFORM pg_temp.ck('Off: 2 recorded as not taken from stock; pre-inventory units 2',
    order_item_unstocked_qty(v_item) = 2 AND (SELECT pre_inventory_units FROM order_items WHERE id = v_item) = 2
    AND (SELECT buys_later FROM orders WHERE id = v_o1));
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_int := pg_temp.to_buy(v_px);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Shopping list (Off): 2 to buy', v_int = 2, v_int::text);
  UPDATE products SET stock_quantity = 1 WHERE id = v_px;
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_int := pg_temp.to_buy(v_px);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Shopping list (Off): 1 bought and added to stock → 1 left to buy', v_int = 1, v_int::text);

  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM cancel_order(v_o1, NULL);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Off: cancel gives back only the 2 that were taken (1 → 3, not 5)',
    (SELECT stock_quantity FROM products WHERE id = v_px) = 3, (SELECT stock_quantity::text FROM products WHERE id = v_px));

  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM admin_reopen_order(v_o1);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Off: reopening takes back only the 2 (3 → 1)',
    (SELECT stock_quantity FROM products WHERE id = v_px) = 1, (SELECT stock_quantity::text FROM products WHERE id = v_px));

  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM admin_edit_order(v_o1, jsonb_build_object('items', jsonb_build_array(jsonb_build_object('id', v_item, 'quantity', 3))));
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Off: edit 4 → 3 drops a never-taken unit first (stock stays 1, 1 left to buy)',
    (SELECT stock_quantity FROM products WHERE id = v_px) = 1 AND order_item_unstocked_qty(v_item) = 1,
    format('stock %s, unstocked %s', (SELECT stock_quantity FROM products WHERE id = v_px), order_item_unstocked_qty(v_item)));
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM admin_edit_order(v_o1, jsonb_build_object('items', jsonb_build_array(jsonb_build_object('id', v_item, 'quantity', 1))));
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Off: edit 3 → 1 gives back 1 taken unit (stock 1 → 2), nothing left to buy',
    (SELECT stock_quantity FROM products WHERE id = v_px) = 2 AND order_item_unstocked_qty(v_item) = 0,
    format('stock %s, unstocked %s', (SELECT stock_quantity FROM products WHERE id = v_px), order_item_unstocked_qty(v_item)));
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM admin_edit_order(v_o1, jsonb_build_object('items', jsonb_build_array(jsonb_build_object('id', v_item, 'quantity', 4))));
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Off: edit 1 → 4 takes the 2 in stock and records 1 to buy',
    (SELECT stock_quantity FROM products WHERE id = v_px) = 0 AND order_item_unstocked_qty(v_item) = 1,
    format('stock %s, unstocked %s', (SELECT stock_quantity FROM products WHERE id = v_px), order_item_unstocked_qty(v_item)));
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM admin_delete_orders(ARRAY[v_o1]);
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Off: deleting the order gives back only the 3 taken (0 → 3)',
    (SELECT stock_quantity FROM products WHERE id = v_px) = 3, (SELECT stock_quantity::text FROM products WHERE id = v_px));

  v_err := NULL;
  BEGIN
    PERFORM set_config('request.jwt.claims', c_cust, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM place_order(
      p_items => jsonb_build_array(jsonb_build_object('product_id', v_py, 'quantity', 3)),
      p_full_name => 'E2E B51', p_phone => '01700000051', p_division => 'Dhaka', p_district => 'Dhaka',
      p_thana => 'Gulshan', p_address_line => 'Test road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod');
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Off, switch Off: 3 with 2 in stock refused as before', v_err LIKE 'Only 2 of%', COALESCE(v_err, 'no error'));

  -- ======================================================= Wishlist (RLS)
  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  INSERT INTO wishlist_items (product_id) VALUES (v_pk);
  v_int := (SELECT count(*) FROM wishlist_items);
  v_err := NULL;
  BEGIN
    INSERT INTO wishlist_items (customer_id, product_id) VALUES (v_admin, v_py);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  v_bool := (SELECT count(*) FROM order_item_unstocked) = 0;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Wishlist: a customer saves to their own list', v_int >= 1
    AND EXISTS (SELECT 1 FROM wishlist_items WHERE customer_id = v_cust AND product_id = v_pk));
  PERFORM pg_temp.ck('Wishlist: a customer cannot write to someone else''s list', v_err IS NOT NULL, COALESCE(v_err, 'no error'));
  PERFORM pg_temp.ck('Customers cannot read the unstocked table', v_bool);
  INSERT INTO wishlist_items (customer_id, product_id) VALUES (v_admin, v_py);
  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_bool := NOT EXISTS (SELECT 1 FROM wishlist_items WHERE customer_id <> v_cust);
  DELETE FROM wishlist_items WHERE product_id = v_pk;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Wishlist: a customer reads only their own rows', v_bool);
  PERFORM pg_temp.ck('Wishlist: a customer removes their own row',
    NOT EXISTS (SELECT 1 FROM wishlist_items WHERE customer_id = v_cust AND product_id = v_pk));
  DELETE FROM products WHERE id = v_py;
  PERFORM pg_temp.ck('Wishlist: a deleted product drops out', NOT EXISTS (SELECT 1 FROM wishlist_items WHERE product_id = v_py));

  -- ====================================== Steadfast "not paid after 7 days"
  INSERT INTO orders (order_number, customer_name, customer_phone, division, district, thana, address_line, delivery_zone, delivery_fee,
                      subtotal, total, payment_method, payment_status, status, steadfast_consignment_id, steadfast_status, source)
  VALUES ('E2E-B51-SF1-' || v_tag, 'E2E B51', '01700000051', 'Dhaka', 'Dhaka', 'Gulshan', 'Test road', 'inside_dhaka', 70, 1500, 1570,
          'cod', 'unpaid', 'delivered', 'E2E51A' || v_tag, 'delivered', 'web')
  RETURNING id INTO v_o1;
  INSERT INTO orders (order_number, customer_name, customer_phone, division, district, thana, address_line, delivery_zone, delivery_fee,
                      subtotal, total, payment_method, payment_status, status, steadfast_consignment_id, steadfast_status, source)
  VALUES ('E2E-B51-SF2-' || v_tag, 'E2E B51', '01700000051', 'Dhaka', 'Dhaka', 'Gulshan', 'Test road', 'inside_dhaka', 70, 1500, 1570,
          'cod', 'unpaid', 'delivered', 'E2E51B' || v_tag, 'unknown', 'web')
  RETURNING id INTO v_o2;
  INSERT INTO orders (order_number, customer_name, customer_phone, division, district, thana, address_line, delivery_zone, delivery_fee,
                      subtotal, total, payment_method, payment_status, status, steadfast_consignment_id, steadfast_status, source)
  VALUES ('E2E-B51-SF3-' || v_tag, 'E2E B51', '01700000051', 'Dhaka', 'Dhaka', 'Gulshan', 'Test road', 'inside_dhaka', 70, 1500, 1570,
          'cod', 'unpaid', 'delivered', 'E2E51C' || v_tag, 'cancelled', 'web')
  RETURNING id INTO v_o3;
  INSERT INTO order_status_history (order_id, old_status, new_status, changed_at)
  SELECT id, 'shipped', 'delivered', now() - interval '10 days' FROM orders WHERE id IN (v_o1, v_o2, v_o3);
  INSERT INTO order_payments (order_id, kind, amount, method, paid_at, note, source)
  VALUES (v_o2, 'payment', 1570, 'bkash', now(), 'E2E B51 paid by hand', 'manual');
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT COALESCE(jsonb_agg(u.order_id), '[]'::jsonb) INTO v_json FROM steadfast_unpaid_orders(7) u;
  v_txt := (SELECT string_agg(u.order_number, ',') FROM steadfast_unpaid_orders(7) u WHERE u.order_number LIKE 'E2E-B51-%');
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Steadfast: a delivered parcel with no payout is still "not paid after 7 days"',
    v_txt LIKE '%SF1%', COALESCE(v_txt, 'none'));
  PERFORM pg_temp.ck('Steadfast: an order paid in full by hand (bKash) is not counted',
    COALESCE(v_txt, '') NOT LIKE '%SF2%', COALESCE(v_txt, 'none'));
  PERFORM pg_temp.ck('Steadfast: a parcel cancelled on Steadfast is not counted',
    COALESCE(v_txt, '') NOT LIKE '%SF3%', COALESCE(v_txt, 'none'));
  PERFORM pg_temp.ck('Steadfast: NM-3307 and NM-3319 drop out',
    NOT EXISTS (SELECT 1 FROM orders o WHERE o.order_number IN ('NM-3307', 'NM-3319')
                AND o.id IN (SELECT (j #>> '{}')::uuid FROM jsonb_array_elements(COALESCE(v_json, '[]'::jsonb)) j)));

  DELETE FROM order_payments WHERE order_id IN (v_o1, v_o2, v_o3);
  DELETE FROM order_status_history WHERE order_id IN (v_o1, v_o2, v_o3);
  DELETE FROM orders WHERE id IN (v_o1, v_o2, v_o3);
END
$test$;
SELECT 'TEST_RESULT' AS tag, json_agg(json_build_object('name', name, 'ok', ok, 'detail', detail) ORDER BY n)::text AS results FROM t_res;
ROLLBACK;
