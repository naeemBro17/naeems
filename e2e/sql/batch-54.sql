-- Batch 54 database tests (run by e2e/batch-54.spec.ts through the Supabase
-- command line). The runner puts the whole Batch 54 migration
-- (supabase/migration-055-batch54.sql, without its own BEGIN / COMMIT) in
-- front of this script, so everything — the migration, the made-up items,
-- the hidden product, the merged bills — runs inside ONE transaction that
-- always ends with ROLLBACK. Nothing real is changed.
--
-- Result: the rows (name, ok, detail) of the SELECT before the ROLLBACK.
DO $test$
DECLARE
  v_admin    uuid;
  v_cust     uuid;
  c_admin    text;
  c_admin_np text;
  c_cust     text;
  v_pk       text;
  v_key      text;
  v_err      text;
  v_json     jsonb;
  v_bills    jsonb;
  v_items    jsonb;
  v_prod     uuid;
  v_hidden   uuid;
  v_num      numeric;
  v_int      integer;
  v_imports  integer;
  v_snap0    text;
  v_dues0    text;
  v_parts0   jsonb;
  v_parts1   jsonb;
BEGIN
  EXECUTE 'CREATE TEMP TABLE t_res (n serial, name text, ok boolean, detail text)';
  EXECUTE $f$CREATE FUNCTION pg_temp.ck(p_name text, p_ok boolean, p_detail text DEFAULT '') RETURNS void
    LANGUAGE sql AS 'INSERT INTO t_res (name, ok, detail) VALUES (p_name, COALESCE(p_ok, false), COALESCE(p_detail, ''''))'$f$;
  -- Everything old bills must never change, as one text.
  EXECUTE $f$CREATE FUNCTION pg_temp.snap() RETURNS text LANGUAGE sql AS $s$
    SELECT concat_ws(' | ',
      (SELECT count(*) FROM orders), (SELECT count(*) FROM order_items), (SELECT count(*) FROM order_item_lots),
      (SELECT COALESCE(sum(qty_remaining), 0) FROM lot_items), (SELECT count(*) FROM lots),
      (SELECT COALESCE(sum(stock_quantity), 0) FROM products), (SELECT COALESCE(sum(stock_quantity), 0) FROM product_variants),
      (SELECT count(*) || '/' || COALESCE(sum(amount), 0) FROM money_movements),
      (SELECT count(*) FROM customer_due_payments), (SELECT COALESCE(sum(amount), 0) FROM customer_opening_dues),
      (SELECT count(*) FROM customer_previous_corrections), (SELECT count(*) FROM order_payments))
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
  -- A made-up customer (no such phone on the shop).
  v_pk := '01799954001';
  v_key := 'ph:' || v_pk;
  SELECT id INTO v_prod FROM products ORDER BY created_at LIMIT 1;

  -- ================================================ the migration itself
  PERFORM pg_temp.ck('Migration: paid, due and note on old bills; customer_key on imports',
    (SELECT count(*) FROM information_schema.columns WHERE table_name = 'kaarbar_bills' AND column_name IN ('paid_amount', 'due_amount', 'note')) = 3
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'kaarbar_imports' AND column_name = 'customer_key'));
  PERFORM pg_temp.ck('Anonymous visitors cannot call the new functions',
    NOT has_function_privilege('anon', 'kaarbar_merge_customer(text,jsonb,jsonb,text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'kaarbar_undo_customer_merge(text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'kaarbar_save_item_row(jsonb,uuid)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'kaarbar_customer_old_bills(text,text)', 'EXECUTE'));
  PERFORM pg_temp.ck('The item-row helper is never called from the browser',
    NOT has_function_privilege('authenticated', 'kaarbar_save_item_row(jsonb,uuid)', 'EXECUTE'));
  PERFORM pg_temp.ck('Old bills are still read only through the functions',
    NOT has_table_privilege('authenticated', 'kaarbar_bills', 'SELECT') AND NOT has_table_privilege('authenticated', 'kaarbar_imports', 'INSERT'));

  v_items := jsonb_build_array(
    jsonb_build_object('name_key', 'e2eb54mysterybalm', 'kaarbar_name', 'E2E B54 Mystery Balm', 'kaarbar_price', 0,
      'choice', 'hidden', 'product_id', NULL, 'variant_id', NULL, 'cost_per_pack', 320, 'unit_costs', '{}'::jsonb,
      'product_name', 'E2E B54 Balm (hidden)'),
    jsonb_build_object('name_key', 'e2eb54nightcream', 'kaarbar_name', 'E2E B54 Night Cream', 'kaarbar_price', 0,
      'choice', 'hand', 'product_id', v_prod, 'variant_id', NULL, 'cost_per_pack', 900, 'unit_costs', jsonb_build_object('ml', 5)));
  v_bills := jsonb_build_array(
    jsonb_build_object('kind', 'sale', 'bill_no', 'E2E54-1', 'date', '2026-05-18', 'party_name', 'E2E B54 Party', 'party_phone', v_pk,
      'items_total', 3600, 'bill_discount', 0, 'delivery', 130, 'bill_total', 3730, 'paid_amount', 3730, 'due_amount', 0, 'note', 'E2E B54 note',
      'lines', jsonb_build_array(
        jsonb_build_object('name_key', 'e2eb54mysterybalm', 'kaarbar_name', 'E2E B54 Mystery Balm', 'quantity', 1, 'unit', NULL, 'rate', 2000, 'line_discount', 0, 'line_total', 2000),
        jsonb_build_object('name_key', 'e2eb54nightcream', 'kaarbar_name', 'E2E B54 Night Cream', 'quantity', 1, 'unit', NULL, 'rate', 1600, 'line_discount', 0, 'line_total', 1600))),
    jsonb_build_object('kind', 'sale', 'bill_no', 'E2E54-2', 'date', '2026-09-25', 'party_name', 'E2E B54 Party', 'party_phone', v_pk,
      'items_total', 800, 'bill_discount', 0, 'delivery', 0, 'bill_total', 800, 'paid_amount', 0, 'due_amount', 800, 'note', NULL,
      'lines', jsonb_build_array(
        jsonb_build_object('name_key', 'e2eb54nightcream', 'kaarbar_name', 'E2E B54 Night Cream', 'quantity', 100, 'unit', 'ml', 'rate', 8, 'line_discount', 0, 'line_total', 800))));

  -- ===================================================== who may merge
  PERFORM set_config('request.jwt.claims', c_cust, true);
  v_err := NULL;
  BEGIN
    PERFORM kaarbar_merge_customer(v_key, v_items, v_bills, v_pk);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Merge: a signed-in customer is refused', v_err LIKE 'Only the Super Admin%', COALESCE(v_err, 'no error'));
  PERFORM set_config('request.jwt.claims', c_admin_np, true);
  v_err := NULL;
  BEGIN
    PERFORM kaarbar_merge_customer(v_key, v_items, v_bills, v_pk);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Merge needs the password again', v_err LIKE 'Type your password again%', COALESCE(v_err, 'no error'));

  -- ============================================== all or nothing
  PERFORM set_config('request.jwt.claims', c_admin, true);
  SELECT count(*) INTO v_imports FROM kaarbar_imports;
  v_err := NULL;
  BEGIN
    PERFORM kaarbar_merge_customer(v_key, v_items,
      v_bills || jsonb_build_array(jsonb_build_object('kind', 'sale', 'bill_no', 'E2E54-BAD', 'date', '2026-06-01',
        'items_total', 500, 'bill_discount', -900, 'delivery', 0, 'bill_total', 1400,
        'lines', jsonb_build_array(jsonb_build_object('name_key', 'e2eb54nightcream', 'kaarbar_name', 'E2E B54 Night Cream', 'quantity', 1, 'rate', 500, 'line_total', 500)))),
      v_pk);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('A bill that does not add up stops the whole merge', v_err LIKE '%do not add up%', COALESCE(v_err, 'no error'));
  PERFORM pg_temp.ck('… and nothing at all was saved: no item, no hidden product, no bill, no import',
    NOT EXISTS (SELECT 1 FROM kaarbar_items WHERE name_key IN ('e2eb54mysterybalm', 'e2eb54nightcream'))
    AND NOT EXISTS (SELECT 1 FROM products WHERE name = 'E2E B54 Balm (hidden)')
    AND NOT EXISTS (SELECT 1 FROM kaarbar_bills WHERE bill_no LIKE 'E2E54-%')
    AND (SELECT count(*) FROM kaarbar_imports) = v_imports);
  v_err := NULL;
  BEGIN
    PERFORM kaarbar_merge_customer(v_key, '[]'::jsonb, jsonb_build_array(jsonb_build_object('kind', 'sale', 'bill_no', 'E2E54-OCT', 'date', '2026-10-05',
      'items_total', 100, 'bill_total', 100, 'lines', '[]'::jsonb)), v_pk);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('A bill after the cut-off is refused (already a site order)', v_err LIKE 'Bill E2E54-OCT is after%', COALESCE(v_err, 'no error'));
  v_err := NULL;
  BEGIN
    PERFORM kaarbar_merge_customer(v_key, '[]'::jsonb, v_bills, v_pk);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('An item not on the site is refused', v_err LIKE '%is not on the site%', COALESCE(v_err, 'no error'));

  -- ===================================================== the merge
  v_snap0 := pg_temp.snap();
  SELECT string_agg(customer_key || '=' || order_due || '/' || previous_left, ',' ORDER BY customer_key) INTO v_dues0 FROM money_customer_dues();
  v_parts0 := money_profit_parts('2026-05-01', '2026-09-30');
  v_json := kaarbar_merge_customer(v_key, v_items, v_bills, v_pk);
  PERFORM pg_temp.ck('Merge: 2 bills added, 2 items saved, 1 hidden product made',
    (v_json ->> 'added')::int = 2 AND (v_json ->> 'items_added')::int = 2 AND (v_json ->> 'hidden_made')::int = 1, v_json::text);
  SELECT made_product_id INTO v_hidden FROM kaarbar_items WHERE name_key = 'e2eb54mysterybalm';
  PERFORM pg_temp.ck('Add as new: a hidden product with the typed name, its buying price, and the Kaarbar price as its shop price',
    EXISTS (SELECT 1 FROM products WHERE id = v_hidden AND name = 'E2E B54 Balm (hidden)' AND NOT is_active AND retail_price = 2000)
    AND EXISTS (SELECT 1 FROM product_buying_prices WHERE product_id = v_hidden AND unit_cost_bdt = 320)
    AND EXISTS (SELECT 1 FROM kaarbar_items WHERE name_key = 'e2eb54mysterybalm' AND match_how = 'hidden' AND product_id = v_hidden));
  PERFORM pg_temp.ck('Pick a product: the item points at it, with the price of one ml',
    EXISTS (SELECT 1 FROM kaarbar_items WHERE name_key = 'e2eb54nightcream' AND match_how = 'hand' AND product_id = v_prod AND (unit_costs ->> 'ml')::numeric = 5));
  PERFORM pg_temp.ck('The bills are linked to this customer (key and phone), with paid, due and the remarks line',
    (SELECT count(*) FROM kaarbar_bills WHERE bill_no LIKE 'E2E54-%' AND customer_key = v_key AND phone_key = v_pk) = 2
    AND EXISTS (SELECT 1 FROM kaarbar_bills WHERE bill_no = 'E2E54-1' AND paid_amount = 3730 AND due_amount = 0 AND note = 'E2E B54 note')
    AND EXISTS (SELECT 1 FROM kaarbar_bills WHERE bill_no = 'E2E54-2' AND paid_amount = 0 AND due_amount = 800 AND note IS NULL));
  PERFORM pg_temp.ck('One "merge" import row for this customer',
    EXISTS (SELECT 1 FROM kaarbar_imports WHERE id = (v_json ->> 'import_id')::uuid AND kind = 'merge' AND customer_key = v_key AND row_count = 2));
  PERFORM pg_temp.ck('History only: orders, stock, lots, money, dues and previous balances are untouched', pg_temp.snap() = v_snap0, pg_temp.snap() || ' vs ' || v_snap0);
  PERFORM pg_temp.ck('… every customer''s due is the same (the merged due is NOT added)',
    (SELECT string_agg(customer_key || '=' || order_due || '/' || previous_left, ',' ORDER BY customer_key) FROM money_customer_dues()) IS NOT DISTINCT FROM v_dues0);
  v_parts1 := money_profit_parts('2026-05-01', '2026-09-30');
  PERFORM pg_temp.ck('… money_profit_parts (Money page, Dashboard) is unchanged', v_parts1 = v_parts0);
  PERFORM pg_temp.ck('… Profit & loss counts them as old sales', ((kaarbar_old_parts('2026-05-01', '2026-09-30')) ->> 'old_bills')::int >= 2);

  v_json := kaarbar_customer_old_bills(v_key, v_pk);
  PERFORM pg_temp.ck('The customer page reads paid, due, note, the merge date and each line''s site product',
    jsonb_array_length(v_json) = 2
    AND (v_json -> 0 ->> 'bill_no') = 'E2E54-2' AND (v_json -> 0 ->> 'due_amount')::numeric = 800
    AND (v_json -> 1 ->> 'note') = 'E2E B54 note' AND (v_json -> 1 ->> 'from_merge')::boolean
    AND (v_json -> 1 ->> 'merged_at') IS NOT NULL
    AND (v_json -> 1 -> 'lines' -> 0 ->> 'product_name') = 'E2E B54 Balm (hidden)'
    AND (v_json -> 1 -> 'lines' -> 0 ->> 'match_how') = 'hidden'
    AND (v_json -> 1 -> 'lines' -> 0 ->> 'item_id') IS NOT NULL, left(v_json::text, 400));

  v_json := kaarbar_merge_customer(v_key, '[]'::jsonb, v_bills, v_pk);
  PERFORM pg_temp.ck('Merging again skips the bills already added', (v_json ->> 'added')::int = 0 AND (v_json ->> 'skipped')::int = 2, v_json::text);

  v_err := NULL;
  BEGIN
    PERFORM kaarbar_undo_sales();
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Step 2''s "Undo the last import" never touches a customer merge',
    (v_err LIKE 'There is no old-sales import%' OR v_err IS NULL)
    AND (SELECT count(*) FROM kaarbar_bills WHERE bill_no LIKE 'E2E54-%') = 2, COALESCE(v_err, 'no error'));

  -- ======================================================= undo
  PERFORM set_config('request.jwt.claims', c_admin_np, true);
  v_err := NULL;
  BEGIN
    PERFORM kaarbar_undo_customer_merge(v_key);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Undo needs the password again', v_err LIKE 'Type your password again%', COALESCE(v_err, 'no error'));
  PERFORM set_config('request.jwt.claims', c_admin, true);

  -- A bill in a locked month is kept by Undo.
  INSERT INTO money_month_locks (month, locked, locked_at, checklist)
  VALUES ('2026-05-01', true, now(), '{}'::jsonb)
  ON CONFLICT (month) DO UPDATE SET locked = true;
  v_json := kaarbar_undo_customer_merge(v_key);
  PERFORM pg_temp.ck('Undo removes the merged bills; a bill in a locked month is kept and listed',
    (v_json ->> 'removed')::int = 1 AND jsonb_array_length(v_json -> 'kept') = 1 AND (v_json -> 'kept' -> 0 ->> 'bill_no') = 'E2E54-1'
    AND NOT EXISTS (SELECT 1 FROM kaarbar_bills WHERE bill_no = 'E2E54-2'), v_json::text);
  PERFORM pg_temp.ck('… the items, the hidden product and its buying price stay',
    EXISTS (SELECT 1 FROM kaarbar_items WHERE name_key = 'e2eb54mysterybalm') AND EXISTS (SELECT 1 FROM products WHERE id = v_hidden)
    AND EXISTS (SELECT 1 FROM product_buying_prices WHERE product_id = v_hidden));
  PERFORM pg_temp.ck('… and the merge is marked undone', NOT EXISTS (SELECT 1 FROM kaarbar_imports WHERE kind = 'merge' AND customer_key = v_key AND undone_at IS NULL));
  PERFORM pg_temp.ck('… nothing else changed', pg_temp.snap() = v_snap0);
  v_err := NULL;
  BEGIN
    PERFORM kaarbar_undo_customer_merge(v_key);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Undo with nothing to undo says so', v_err = 'There is no merge to undo.', COALESCE(v_err, 'no error'));

  -- ================================================ Step 1 still works
  v_json := kaarbar_save_items(jsonb_build_array(
    jsonb_build_object('name_key', 'e2eb54stepone', 'kaarbar_name', 'E2E B54 Step One', 'kaarbar_price', 50, 'choice', 'hidden', 'cost_per_pack', 40)));
  PERFORM pg_temp.ck('Step 1 save still works the same (a hidden product named after the item)',
    (v_json ->> 'added')::int = 1 AND (v_json ->> 'hidden_made')::int = 1
    AND EXISTS (SELECT 1 FROM products p JOIN kaarbar_items i ON i.made_product_id = p.id WHERE i.name_key = 'e2eb54stepone' AND p.name = 'E2E B54 Step One'), v_json::text);
  v_json := kaarbar_save_items(jsonb_build_array(
    jsonb_build_object('name_key', 'e2eb54nightcream', 'kaarbar_name', 'E2E B54 Night Cream', 'choice', 'hand', 'product_id', v_prod, 'cost_per_pack', 950)));
  PERFORM pg_temp.ck('Step 1 re-save keeps the prices per ml typed before',
    (v_json ->> 'updated')::int = 1
    AND EXISTS (SELECT 1 FROM kaarbar_items WHERE name_key = 'e2eb54nightcream' AND cost_per_pack = 950 AND (unit_costs ->> 'ml')::numeric = 5), v_json::text);
END
$test$;
SELECT 'TEST_RESULT' AS tag, json_agg(json_build_object('name', name, 'ok', ok, 'detail', detail) ORDER BY n)::text AS results FROM t_res;
ROLLBACK;
