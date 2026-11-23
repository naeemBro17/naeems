-- Batch 50 database tests (run by e2e/batch-50.spec.ts through the Supabase
-- command line) against today's functions on the live database (Batch 61:
-- no old migration is replayed any more). Everything — the made-up items,
-- hidden products, old bills, previous-balance corrections and the money
-- start date this test needs — runs inside ONE transaction that always
-- ends with ROLLBACK. Nothing real is changed.
-- Today's rules (Batch 58, one profit engine): old Kaarbar bills count in
-- profit only on or after the money start date, and money_profit_parts
-- (Money page, Dashboard, Reports) holds them. So the start date is moved
-- to 1 Aug 2026 here, before the made-up August / September bills.
--
-- Result: the rows (name, ok, detail) of the SELECT before the ROLLBACK.
DO $test$
DECLARE
  v_admin    uuid;
  v_cust     uuid;
  c_admin    text;
  c_admin_np text;
  c_cust     text;
  c_anon     text;
  v_cust_pk  text;
  v_err      text;
  v_json     jsonb;
  v_rows     jsonb;
  v_num      numeric;
  v_int      integer;
  v_prod     uuid;
  v_hidden   uuid;
  v_item_a   uuid;
  v_item_h   uuid;
  v_status   jsonb;
  v_pos0     jsonb;
  v_pos1     jsonb;
  v_parts0   jsonb;
  v_parts1   jsonb;
  v_pnl      jsonb;
  v_pnl0     jsonb;
  v_old0     jsonb;
  v_snap0    text;
  v_snap1    text;
  v_dues0    numeric;
  v_dues1    numeric;
  v_phone    text := '01799000501';
BEGIN
  EXECUTE 'CREATE TEMP TABLE t_res (n serial, name text, ok boolean, detail text)';
  EXECUTE $f$CREATE FUNCTION pg_temp.ck(p_name text, p_ok boolean, p_detail text DEFAULT '') RETURNS void
    LANGUAGE sql AS 'INSERT INTO t_res (name, ok, detail) VALUES (p_name, COALESCE(p_ok, false), COALESCE(p_detail, ''''))'$f$;
  -- One product's old line in Reports → Products (zeros when it has none).
  EXECUTE $f$CREATE FUNCTION pg_temp.old_line(p_lines jsonb, p_product uuid, p_unit text) RETURNS jsonb LANGUAGE sql AS $s$
    SELECT jsonb_build_object('sales', COALESCE(sum((o ->> 'sales')::numeric), 0), 'cost', COALESCE(sum((o ->> 'cost')::numeric), 0),
                              'units', COALESCE(sum((o ->> 'units')::numeric), 0))
    FROM jsonb_array_elements(COALESCE(p_lines, '[]'::jsonb)) o
    WHERE o ->> 'product_id' = p_product::text AND o ->> 'stock_unit' = p_unit
  $s$$f$;
  -- Everything the old sales must never change, as one text.
  EXECUTE $f$CREATE FUNCTION pg_temp.snap() RETURNS text LANGUAGE sql AS $s$
    SELECT concat_ws(' | ',
      (SELECT count(*) FROM orders), (SELECT count(*) FROM order_items), (SELECT count(*) FROM order_item_lots),
      (SELECT COALESCE(sum(qty_remaining), 0) FROM lot_items), (SELECT count(*) FROM lots),
      (SELECT COALESCE(sum(stock_quantity), 0) FROM products), (SELECT COALESCE(sum(stock_quantity), 0) FROM product_variants),
      (SELECT count(*) || '/' || COALESCE(sum(amount), 0) FROM money_movements),
      (SELECT count(*) FROM customer_due_payments), (SELECT COALESCE(sum(amount), 0) FROM customer_opening_dues),
      (SELECT count(*) FROM order_payments))
  $s$$f$;

  SELECT id INTO v_admin FROM auth.users WHERE lower(email) = lower('{{ADMIN_EMAIL}}');
  SELECT id INTO v_cust FROM auth.users WHERE lower(email) = lower('{{CUSTOMER_EMAIL}}');
  IF v_admin IS NULL OR v_cust IS NULL THEN
    RAISE EXCEPTION 'TEST_SETUP:the test accounts were not found';
  END IF;
  c_admin := json_build_object('sub', v_admin, 'role', 'authenticated', 'aal', 'aal2',
    'amr', json_build_array(json_build_object('method', 'password', 'timestamp', extract(epoch FROM now())::bigint)))::text;
  c_admin_np := json_build_object('sub', v_admin, 'role', 'authenticated', 'aal', 'aal2',
    'amr', json_build_array(json_build_object('method', 'password', 'timestamp', extract(epoch FROM now())::bigint - 3600)))::text;
  c_cust := json_build_object('sub', v_cust, 'role', 'authenticated')::text;
  c_anon := json_build_object('role', 'anon')::text;
  SELECT bd_phone_key(phone) INTO v_cust_pk FROM profiles WHERE id = v_cust;

  -- ================================================ the migration itself
  PERFORM pg_temp.ck('The item, bill, bill line and correction tables exist',
    to_regclass('kaarbar_items') IS NOT NULL AND to_regclass('kaarbar_bills') IS NOT NULL
    AND to_regclass('kaarbar_bill_lines') IS NOT NULL AND to_regclass('customer_previous_corrections') IS NOT NULL);
  PERFORM pg_temp.ck('Anonymous visitors cannot call any new function',
    NOT has_function_privilege('anon', 'kaarbar_old_sales_status()', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'kaarbar_save_items(jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'kaarbar_import_sales(jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'kaarbar_undo_sales()', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'kaarbar_customer_old_bills(text,text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'money_correct_previous_balance(text,numeric,text)', 'EXECUTE'));
  PERFORM pg_temp.ck('Customers and visitors cannot read old bills or items directly',
    NOT has_table_privilege('anon', 'kaarbar_bills', 'SELECT') AND NOT has_table_privilege('authenticated', 'kaarbar_bills', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'kaarbar_items', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'kaarbar_bill_lines', 'SELECT')
    AND NOT has_table_privilege('anon', 'customer_previous_corrections', 'SELECT'));
  PERFORM pg_temp.ck('The cut-off is 30 Sep 2026', kaarbar_old_sales_cutoff() = DATE '2026-09-30');

  -- ================================================ who may use it
  PERFORM set_config('request.jwt.claims', c_cust, true);
  v_err := NULL;
  BEGIN
    PERFORM kaarbar_old_sales_status();
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('A signed-in customer is refused', v_err LIKE 'Only the Super Admin%', COALESCE(v_err, 'no error'));
  v_err := NULL;
  BEGIN
    PERFORM kaarbar_customer_old_bills('ph:' || v_cust_pk, v_cust_pk);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('A customer cannot read old bills', v_err LIKE 'Not authorized%', COALESCE(v_err, 'no error'));

  -- ================================================ Step 1
  PERFORM set_config('request.jwt.claims', c_admin, true);
  SELECT id INTO v_prod FROM products WHERE is_active AND retail_price > 0 ORDER BY created_at LIMIT 1;
  v_status := kaarbar_old_sales_status();
  PERFORM pg_temp.ck('Status: the products to pick from, with the cut-off',
    jsonb_array_length(v_status -> 'choices') > 0 AND (v_status ->> 'cutoff') = '2026-09-30'
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_status -> 'choices') c WHERE c ->> 'product_id' = v_prod::text),
    format('%s choices', jsonb_array_length(v_status -> 'choices')));

  v_rows := jsonb_build_array(
    jsonb_build_object('name_key', 'e2eb50itema', 'kaarbar_name', 'E2E B50 Item A', 'kaarbar_price', 0, 'choice', 'auto',
                       'product_id', v_prod, 'variant_id', NULL, 'cost_per_pack', 1000),
    jsonb_build_object('name_key', 'e2eb50hidden', 'kaarbar_name', 'E2E B50 Hidden Thing', 'kaarbar_price', 150, 'choice', 'hidden',
                       'product_id', NULL, 'variant_id', NULL, 'cost_per_pack', 200));

  PERFORM set_config('request.jwt.claims', c_admin_np, true);
  v_err := NULL;
  BEGIN
    PERFORM kaarbar_save_items(v_rows);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Saving the list needs the password again', v_err LIKE 'Type your password again%', COALESCE(v_err, 'no error'));

  PERFORM set_config('request.jwt.claims', c_admin, true);
  v_err := NULL;
  BEGIN
    PERFORM kaarbar_save_items(jsonb_build_array(v_rows -> 0 || jsonb_build_object('cost_per_pack', 0)));
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('No buying price, no save', v_err LIKE 'Type the buying price%', COALESCE(v_err, 'no error'));

  v_json := kaarbar_save_items(v_rows);
  SELECT id, product_id INTO v_item_h, v_hidden FROM kaarbar_items WHERE name_key = 'e2eb50hidden';
  SELECT id INTO v_item_a FROM kaarbar_items WHERE name_key = 'e2eb50itema';
  PERFORM pg_temp.ck('Save: 2 new items, 1 hidden product made', (v_json ->> 'added')::int = 2 AND (v_json ->> 'hidden_made')::int = 1, v_json::text);
  PERFORM pg_temp.ck('The hidden product: Kaarbar name, hidden, no picture, price 0, generated XX SKU, slug, buying price',
    EXISTS (SELECT 1 FROM products p WHERE p.id = v_hidden AND p.name = 'E2E B50 Hidden Thing' AND NOT p.is_active
            AND p.retail_price = 0 AND p.image_urls = '{}' AND p.sku ~ '^XX-[0-9]{3,}$' AND p.slug LIKE 'e2e-b50-hidden-thing%')
    AND (SELECT unit_cost_bdt FROM product_buying_prices WHERE product_id = v_hidden AND variant_id IS NULL) = 200);
  PERFORM pg_temp.ck('The matched product''s own buying price is not touched',
    NOT EXISTS (SELECT 1 FROM product_buying_prices WHERE product_id = v_prod AND unit_cost_bdt = 1000 AND updated_at >= now() - interval '1 second'));

  v_json := kaarbar_save_items(jsonb_build_array(v_rows -> 1 || jsonb_build_object('cost_per_pack', 210)));
  PERFORM pg_temp.ck('Saving again updates the row and never makes a second hidden product',
    (v_json ->> 'updated')::int = 1 AND (v_json ->> 'hidden_made')::int = 0
    AND (SELECT count(*) FROM products WHERE name = 'E2E B50 Hidden Thing') = 1
    AND (SELECT cost_per_pack FROM kaarbar_items WHERE id = v_item_h) = 210
    AND (SELECT unit_cost_bdt FROM product_buying_prices WHERE product_id = v_hidden AND variant_id IS NULL) = 210, v_json::text);
  PERFORM kaarbar_save_items(jsonb_build_array(v_rows -> 1));

  v_err := NULL;
  BEGIN
    UPDATE products SET is_active = true WHERE id = v_hidden;
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('A product with price 0 cannot be shown in the shop', v_err LIKE 'Set a price before showing%', COALESCE(v_err, 'no error'));

  -- ================================================ Step 2
  UPDATE money_books SET start_date = DATE '2026-08-01' WHERE id = 1;
  v_snap0 := pg_temp.snap();
  v_pos0 := money_position();
  v_parts0 := money_profit_parts(DATE '2026-08-01', DATE '2026-09-30');
  SELECT COALESCE(sum(order_due + previous_left), 0) INTO v_dues0 FROM money_customer_dues();
  -- The shop's own old bills in August / September (start date moved above).
  v_pnl0 := report_profit_loss(DATE '2026-08-01', DATE '2026-09-30');
  v_old0 := report_products(DATE '2026-08-01', DATE '2026-09-30') -> 'old_sold';

  -- S1: A 2 × 1500 + H 100 ml × 5, delivery 100, bill discount 600 → 3,000.
  -- S2: H 1 pack × 400 → 400.   R1 (return): A 1 × 1500 → 1,500.
  v_rows := jsonb_build_array(
    jsonb_build_object('kind', 'sale', 'bill_no', 'E2E50-S1', 'date', '2026-08-10', 'customer_key', 'ph:' || v_phone, 'phone_key', v_phone,
      'party_name', 'E2E Test Party', 'party_phone', v_phone, 'items_total', 3500, 'bill_discount', 600, 'delivery', 100, 'bill_total', 3000,
      'lines', jsonb_build_array(
        jsonb_build_object('item_id', v_item_a, 'kaarbar_name', 'E2E B50 Item A', 'quantity', 2, 'unit', NULL, 'rate', 1500, 'line_discount', 0, 'line_total', 3000),
        jsonb_build_object('item_id', v_item_h, 'kaarbar_name', 'E2E B50 Hidden Thing', 'quantity', 100, 'unit', 'ml', 'rate', 5, 'line_discount', 0, 'line_total', 500))),
    jsonb_build_object('kind', 'sale', 'bill_no', 'E2E50-S2', 'date', '2026-09-05', 'customer_key', NULL, 'phone_key', v_phone,
      'party_name', 'E2E Test Party', 'party_phone', v_phone, 'items_total', 400, 'bill_discount', 0, 'delivery', 0, 'bill_total', 400,
      'lines', jsonb_build_array(
        jsonb_build_object('item_id', v_item_h, 'kaarbar_name', 'E2E B50 Hidden Thing', 'quantity', 1, 'unit', NULL, 'rate', 400, 'line_discount', 0, 'line_total', 400))),
    jsonb_build_object('kind', 'return', 'bill_no', 'E2E50-R1', 'date', '2026-09-20', 'customer_key', NULL, 'phone_key', v_phone,
      'party_name', 'E2E Test Party', 'party_phone', v_phone, 'items_total', 1500, 'bill_discount', 0, 'delivery', 0, 'bill_total', 1500,
      'lines', jsonb_build_array(
        jsonb_build_object('item_id', v_item_a, 'kaarbar_name', 'E2E B50 Item A', 'quantity', 1, 'unit', NULL, 'rate', 1500, 'line_discount', 0, 'line_total', 1500))));

  v_err := NULL;
  BEGIN
    PERFORM kaarbar_import_sales(v_rows);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('A line sold by the ml needs the price of 1 ml first', v_err LIKE 'Type the buying price of 1 ml%', COALESCE(v_err, 'no error'));
  PERFORM pg_temp.ck('… and nothing of that import stayed', NOT EXISTS (SELECT 1 FROM kaarbar_bills WHERE bill_no LIKE 'E2E50-%'));

  v_int := kaarbar_set_unit_costs(jsonb_build_array(jsonb_build_object('item_id', v_item_h, 'unit', 'ml', 'cost', 2)));
  PERFORM pg_temp.ck('The price of 1 ml is saved in the Step 1 list', v_int = 1
    AND (SELECT (unit_costs ->> 'ml')::numeric FROM kaarbar_items WHERE id = v_item_h) = 2);

  v_err := NULL;
  BEGIN
    PERFORM kaarbar_import_sales(jsonb_build_array(v_rows -> 1 || jsonb_build_object('date', '2026-10-02', 'bill_no', 'E2E50-OCT')));
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('A bill after 30 Sep is refused', v_err LIKE '%already on the site%', COALESCE(v_err, 'no error'));

  v_err := NULL;
  BEGIN
    PERFORM kaarbar_import_sales(jsonb_build_array(v_rows -> 1 || jsonb_build_object('bill_total', 999)));
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('A bill whose lines do not add up is refused', v_err LIKE '%do not add up%', COALESCE(v_err, 'no error'));

  PERFORM set_config('request.jwt.claims', c_admin_np, true);
  v_err := NULL;
  BEGIN
    PERFORM kaarbar_import_sales(v_rows);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Importing needs the password again', v_err LIKE 'Type your password again%', COALESCE(v_err, 'no error'));

  PERFORM set_config('request.jwt.claims', c_admin, true);
  v_json := kaarbar_import_sales(v_rows);
  PERFORM pg_temp.ck('Import: 3 bills, total 3,000 + 400 − 1,500', (v_json ->> 'added')::int = 3 AND (v_json ->> 'total')::numeric = 1900, v_json::text);
  PERFORM pg_temp.ck('No cost is stored on a bill line',
    NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'kaarbar_bill_lines' AND column_name ILIKE '%cost%'));

  v_snap1 := pg_temp.snap();
  PERFORM pg_temp.ck('Old sales change nothing: orders, items, lots, stock, money movements, payments, dues', v_snap0 = v_snap1,
    format('before %s / after %s', v_snap0, v_snap1));
  v_pos1 := money_position();
  -- Batch 58: old bills on / after the start date count in net profit and
  -- so in the balance check, with no money side: the check moves by their
  -- profit (৳500) and nothing else does.
  PERFORM pg_temp.ck('The Money position is the same (accounts, to receive, previous balances, stock, net worth); the check moves by the old profit only',
    (v_pos0 ->> 'accounts_total') = (v_pos1 ->> 'accounts_total') AND (v_pos0 ->> 'to_receive') = (v_pos1 ->> 'to_receive')
    AND (v_pos0 ->> 'previous_balances') = (v_pos1 ->> 'previous_balances') AND (v_pos0 ->> 'stock_value') = (v_pos1 ->> 'stock_value')
    AND (v_pos0 ->> 'net_worth') = (v_pos1 ->> 'net_worth')
    AND (v_pos1 ->> 'difference')::numeric = (v_pos0 ->> 'difference')::numeric - 500,
    format('net worth %s → %s, difference %s → %s', v_pos0 ->> 'net_worth', v_pos1 ->> 'net_worth', v_pos0 ->> 'difference', v_pos1 ->> 'difference'));
  v_parts1 := money_profit_parts(DATE '2026-08-01', DATE '2026-09-30');
  PERFORM pg_temp.ck('money_profit_parts (Money page, Dashboard) counts the old bills: 3 bills, profit + 500 (Batch 58: one profit engine)',
    (v_parts1 ->> 'old_bills')::int = (v_parts0 ->> 'old_bills')::int + 3
    AND (v_parts1 ->> 'net_profit')::numeric = (v_parts0 ->> 'net_profit')::numeric + 500,
    format('bills %s → %s, net %s → %s', v_parts0 ->> 'old_bills', v_parts1 ->> 'old_bills', v_parts0 ->> 'net_profit', v_parts1 ->> 'net_profit'));
  SELECT COALESCE(sum(order_due + previous_left), 0) INTO v_dues1 FROM money_customer_dues();
  PERFORM pg_temp.ck('Customer dues do not change', v_dues0 = v_dues1, format('%s → %s', v_dues0, v_dues1));

  v_pnl := report_profit_loss(DATE '2026-08-01', DATE '2026-09-30');
  PERFORM pg_temp.ck('Profit & loss: old sales 2,400, bill discounts 600, cost 2,200 + 200 + 200 − 1,000, delivery 100 (on top of the shop''s own old bills)',
    (v_pnl -> 'parts' ->> 'old_bills')::int = (v_pnl0 -> 'parts' ->> 'old_bills')::int + 3
    AND (v_pnl -> 'parts' ->> 'old_sales_gross')::numeric = (v_pnl0 -> 'parts' ->> 'old_sales_gross')::numeric + 2400
    AND (v_pnl -> 'parts' ->> 'old_bill_discounts')::numeric = (v_pnl0 -> 'parts' ->> 'old_bill_discounts')::numeric + 600
    AND (v_pnl -> 'parts' ->> 'old_sales')::numeric = (v_pnl0 -> 'parts' ->> 'old_sales')::numeric + 1800
    AND (v_pnl -> 'parts' ->> 'old_cost')::numeric = (v_pnl0 -> 'parts' ->> 'old_cost')::numeric + 1400
    AND (v_pnl -> 'parts' ->> 'old_delivery')::numeric = (v_pnl0 -> 'parts' ->> 'old_delivery')::numeric + 100,
    (v_pnl -> 'parts')::text);
  PERFORM pg_temp.ck('Profit & loss: the profit lines include the old profit (500)',
    (v_pnl -> 'parts' ->> 'net_profit')::numeric = (v_parts0 ->> 'net_profit')::numeric + 500
    AND (v_pnl -> 'parts' ->> 'your_profit')::numeric = (v_parts0 ->> 'your_profit')::numeric + 500
    AND (v_pnl -> 'parts' ->> 'left_in_business')::numeric = (v_parts0 ->> 'left_in_business')::numeric + 500
    AND (v_pnl -> 'parts' ->> 'gross_profit')::numeric = (v_parts0 ->> 'gross_profit')::numeric + 400,
    (v_pnl -> 'parts')::text);
  PERFORM pg_temp.ck('Profit & loss month by month: August and September',
    jsonb_array_length(v_pnl -> 'months') = 2
    AND (v_pnl -> 'months' -> 0 ->> 'old_sales')::numeric = (v_pnl0 -> 'months' -> 0 ->> 'old_sales')::numeric + 2900
    AND (v_pnl -> 'months' -> 1 ->> 'old_sales')::numeric = (v_pnl0 -> 'months' -> 1 ->> 'old_sales')::numeric - 1100
    AND (v_pnl -> 'months' -> 0 ->> 'old_cost')::numeric = (v_pnl0 -> 'months' -> 0 ->> 'old_cost')::numeric + 2200
    AND (v_pnl -> 'months' -> 1 ->> 'old_cost')::numeric = (v_pnl0 -> 'months' -> 1 ->> 'old_cost')::numeric - 800,
    (v_pnl -> 'months')::text);
  v_pnl := report_profit_loss(DATE '2026-10-01', DATE '2026-10-31');
  PERFORM pg_temp.ck('A range without old months has no old lines', (v_pnl -> 'parts' ->> 'old_bills')::int = 0);

  v_json := report_products(DATE '2026-08-01', DATE '2026-09-30');
  PERFORM pg_temp.ck('Products report: old lines per product and unit; the bill discount spread by line totals',
    (pg_temp.old_line(v_json -> 'old_sold', v_prod, 'pcs') ->> 'sales')::numeric = (pg_temp.old_line(v_old0, v_prod, 'pcs') ->> 'sales')::numeric + 985.71
    AND (pg_temp.old_line(v_json -> 'old_sold', v_prod, 'pcs') ->> 'cost')::numeric = (pg_temp.old_line(v_old0, v_prod, 'pcs') ->> 'cost')::numeric + 1000
    AND (pg_temp.old_line(v_json -> 'old_sold', v_prod, 'pcs') ->> 'units')::numeric = (pg_temp.old_line(v_old0, v_prod, 'pcs') ->> 'units')::numeric + 1
    AND (pg_temp.old_line(v_json -> 'old_sold', v_hidden, 'ml') ->> 'sales')::numeric = 414.29
    AND (pg_temp.old_line(v_json -> 'old_sold', v_hidden, 'ml') ->> 'cost')::numeric = 200
    AND (SELECT sum((o ->> 'sales')::numeric) FROM jsonb_array_elements(v_json -> 'old_sold') o)
        = COALESCE((SELECT sum((o ->> 'sales')::numeric) FROM jsonb_array_elements(v_old0) o), 0) + 1800,
    format('%s / %s', pg_temp.old_line(v_json -> 'old_sold', v_prod, 'pcs'), pg_temp.old_line(v_json -> 'old_sold', v_hidden, 'ml')));

  PERFORM pg_temp.ck('The hidden product gets the latest Kaarbar sale price, and stays hidden',
    EXISTS (SELECT 1 FROM products WHERE id = v_hidden AND retail_price = 400 AND NOT is_active));

  PERFORM kaarbar_save_items(jsonb_build_array(
    jsonb_build_object('name_key', 'e2eb50itema', 'kaarbar_name', 'E2E B50 Item A', 'kaarbar_price', 0, 'choice', 'hand',
                       'product_id', v_prod, 'variant_id', NULL, 'cost_per_pack', 1100)));
  v_pnl := report_profit_loss(DATE '2026-08-01', DATE '2026-09-30');
  PERFORM pg_temp.ck('Correcting a buying price in Step 1 corrects the old profit (cost 1,400 → 1,500)',
    (v_pnl -> 'parts' ->> 'old_cost')::numeric = (v_pnl0 -> 'parts' ->> 'old_cost')::numeric + 1500, v_pnl -> 'parts' ->> 'old_cost');
  PERFORM pg_temp.ck('… and the price per ml typed in Step 2 is kept', (SELECT (unit_costs ->> 'ml')::numeric FROM kaarbar_items WHERE id = v_item_h) = 2);

  v_json := kaarbar_import_sales(v_rows);
  PERFORM pg_temp.ck('The same bills again: all skipped ("Already added")', (v_json ->> 'added')::int = 0 AND (v_json ->> 'skipped')::int = 3, v_json::text);

  v_json := kaarbar_customer_old_bills('ph:' || v_phone, v_phone);
  PERFORM pg_temp.ck('Customer page: the old bills by phone, newest first, with their lines',
    jsonb_array_length(v_json) = 3 AND (v_json -> 0 ->> 'bill_no') = 'E2E50-R1' AND (v_json -> 0 ->> 'kind') = 'return'
    AND jsonb_array_length(v_json -> 2 -> 'lines') = 2, v_json::text);
  PERFORM pg_temp.ck('Old bills are not orders: the customer list / order count do not see them',
    NOT EXISTS (SELECT 1 FROM orders WHERE bd_phone_key(customer_phone) = v_phone));

  v_json := kaarbar_remove_hidden_products();
  PERFORM pg_temp.ck('Remove hidden products: kept while old bills use it',
    -- (Batch 54: other hidden products may exist on the live shop since the
    -- real Step 1; only this test's own product is checked.)
    EXISTS (SELECT 1 FROM jsonb_array_elements(v_json -> 'kept') k WHERE k ->> 'name' = 'E2E B50 Hidden Thing' AND k ->> 'reason' = 'old bills use it')
    AND EXISTS (SELECT 1 FROM products WHERE id = v_hidden), left(v_json::text, 300));

  PERFORM set_config('request.jwt.claims', c_admin_np, true);
  v_err := NULL;
  BEGIN
    PERFORM kaarbar_undo_sales();
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Undo needs the password again', v_err LIKE 'Type your password again%', COALESCE(v_err, 'no error'));
  PERFORM set_config('request.jwt.claims', c_admin, true);
  -- The second (skipped) import added nothing: undo it first.
  v_json := kaarbar_undo_sales();
  PERFORM pg_temp.ck('Undo the last import (the empty one): nothing removed', (v_json ->> 'removed')::int = 0, v_json::text);
  v_json := kaarbar_undo_sales();
  PERFORM pg_temp.ck('Undo the import before it: its 3 bills removed, nothing else changed',
    (v_json ->> 'removed')::int = 3 AND NOT EXISTS (SELECT 1 FROM kaarbar_bills WHERE bill_no LIKE 'E2E50-%')
    AND pg_temp.snap() = v_snap0, v_json::text);

  v_json := kaarbar_remove_hidden_products();
  PERFORM pg_temp.ck('Remove hidden products: removed when nothing uses it; the item needs a product again',
    (v_json ->> 'removed')::int = 1 AND NOT EXISTS (SELECT 1 FROM products WHERE id = v_hidden)
    AND (SELECT product_id FROM kaarbar_items WHERE id = v_item_h) IS NULL, v_json::text);

  -- ================================================ correct previous balance
  PERFORM set_config('request.jwt.claims', c_cust, true);
  v_err := NULL;
  BEGIN
    PERFORM money_correct_previous_balance(v_cust_pk, 500, 'x');
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Correct previous balance: a customer is refused', v_err LIKE 'Only the Super Admin%', COALESCE(v_err, 'no error'));
  PERFORM set_config('request.jwt.claims', c_admin_np, true);
  v_err := NULL;
  BEGIN
    PERFORM money_correct_previous_balance(v_cust_pk, 500, 'x');
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Correct previous balance: needs the password again', v_err LIKE 'Type your password again%', COALESCE(v_err, 'no error'));

  PERFORM set_config('request.jwt.claims', c_admin, true);
  v_err := NULL;
  BEGIN
    PERFORM money_correct_previous_balance(v_cust_pk, -1, NULL);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Correct previous balance: no negatives', v_err LIKE 'Type an amount of 0 or more%', COALESCE(v_err, 'no error'));

  v_snap0 := pg_temp.snap();
  v_pos0 := money_position();
  v_num := money_previous_left(v_cust_pk);
  v_json := money_correct_previous_balance(v_cust_pk, v_num + 500, 'E2E B50 wrong when brought in');
  v_pos1 := money_position();
  PERFORM pg_temp.ck('Correct previous balance: the balance is now 500 more',
    money_previous_left(v_cust_pk) = v_num + 500 AND (v_json ->> 'old')::numeric = v_num, v_json::text);
  PERFORM pg_temp.ck('… the locked opening rows and every money table are untouched', pg_temp.snap() = v_snap0);
  PERFORM pg_temp.ck('… Money position: previous balances +500, accounts the same, the books check unchanged',
    (v_pos1 ->> 'previous_balances')::numeric = (v_pos0 ->> 'previous_balances')::numeric + 500
    AND (v_pos1 ->> 'accounts_total') = (v_pos0 ->> 'accounts_total')
    AND (v_pos1 ->> 'previous_corrections')::numeric = COALESCE((v_pos0 ->> 'previous_corrections')::numeric, 0) + 500
    AND (v_pos1 ->> 'difference') IS NOT DISTINCT FROM (v_pos0 ->> 'difference'),
    format('prev %s → %s, difference %s → %s', v_pos0 ->> 'previous_balances', v_pos1 ->> 'previous_balances', v_pos0 ->> 'difference', v_pos1 ->> 'difference'));
  PERFORM pg_temp.ck('… the customer list / due reminders see it (money_customer_dues)',
    EXISTS (SELECT 1 FROM money_customer_dues() d WHERE d.phone_key = v_cust_pk AND d.previous_left = v_num + 500));
  PERFORM pg_temp.ck('… the customer history lists the correction',
    EXISTS (SELECT 1 FROM jsonb_array_elements(money_customer_history('ph:' || v_cust_pk, v_cust_pk) -> 'corrections') c
            WHERE (c ->> 'new_amount')::numeric = v_num + 500 AND c ->> 'note' = 'E2E B50 wrong when brought in'));
  PERFORM pg_temp.ck('… written to the Activity Log',
    EXISTS (SELECT 1 FROM activity_log WHERE action = 'money.previous_corrected' AND summary LIKE 'Previous balance corrected from%(E2E B50 wrong when brought in)'));
  PERFORM set_config('request.jwt.claims', c_cust, true);
  PERFORM pg_temp.ck('… and the customer''s own previous balance follows', customer_previous_balance() = GREATEST(v_num + 500, 0));
  PERFORM set_config('request.jwt.claims', c_admin, true);

  v_err := NULL;
  BEGIN
    PERFORM money_correct_previous_balance(v_cust_pk, v_num + 500, NULL);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Correct previous balance: the same amount again is refused', v_err LIKE 'The previous balance is already%', COALESCE(v_err, 'no error'));
  PERFORM money_correct_previous_balance(v_cust_pk, 0, NULL);
  PERFORM pg_temp.ck('Correct previous balance: down to 0 is allowed', money_previous_left(v_cust_pk) = 0);
END
$test$;
SELECT 'TEST_RESULT' AS tag, json_agg(json_build_object('name', name, 'ok', ok, 'detail', detail) ORDER BY n)::text AS results FROM t_res;
ROLLBACK;
