-- Batch 49 database tests (run by e2e/batch-49.spec.ts through the Supabase
-- command line) against today's functions on the live database (Batch 61:
-- no old migration is replayed any more). Everything — the made-up
-- customers, expenses, investor and month lock — runs inside ONE
-- transaction that always ends with ROLLBACK. Nothing real is changed.
-- The shop's own Kaarbar imports are set aside (marked undone) inside that
-- transaction, so Undo here only ever meets this test's imports.
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
  v_int      integer;
  v_num      numeric;
  v_start    date;
  v_today    date;
  v_old      date;
  v_cash     uuid;
  v_bkash    uuid;
  v_inv      uuid;
  v_cash0    numeric;
  v_bkash0   numeric;
  v_dues0    integer;
  v_orders0  integer;
  v_cats0    integer;
  v_food     text;
  v_food_id  uuid;
  v_imp1     uuid;
  v_bills0   integer;
BEGIN
  EXECUTE 'CREATE TEMP TABLE t_res (n serial, name text, ok boolean, detail text)';
  EXECUTE $f$CREATE FUNCTION pg_temp.ck(p_name text, p_ok boolean, p_detail text DEFAULT '') RETURNS void
    LANGUAGE sql AS 'INSERT INTO t_res (name, ok, detail) VALUES (p_name, COALESCE(p_ok, false), COALESCE(p_detail, ''''))'$f$;

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

  -- ================================================ what Batch 49 added
  PERFORM pg_temp.ck('kaarbar_imports, the import marks and the Bill No column exist',
    to_regclass('kaarbar_imports') IS NOT NULL
    AND (SELECT count(*) FROM information_schema.columns WHERE table_name = 'money_movements'
           AND column_name IN ('kaarbar_import_id', 'kaarbar_bill_no')) = 2
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'customers' AND column_name = 'kaarbar_import_id'));
  PERFORM pg_temp.ck('Anonymous visitors cannot call any Kaarbar function',
    NOT has_function_privilege('anon', 'kaarbar_status()', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'kaarbar_customers_check(jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'kaarbar_import_customers(jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'kaarbar_undo_customers()', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'kaarbar_import_expenses(jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'kaarbar_undo_expenses()', 'EXECUTE'));
  PERFORM pg_temp.ck('The shop cannot read the import list',
    NOT has_table_privilege('anon', 'kaarbar_imports', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'kaarbar_imports', 'SELECT'));

  -- ================================================ who may use it
  PERFORM set_config('request.jwt.claims', c_cust, true);
  v_err := NULL;
  BEGIN
    PERFORM kaarbar_import_customers('[{"name":"E2E B49 Sneaky","phone_key":"01700000490"}]'::jsonb);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('A signed-in customer is refused by the server', v_err LIKE 'Only the Super Admin%', COALESCE(v_err, 'no error'));
  v_err := NULL;
  BEGIN
    PERFORM kaarbar_status();
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('… and cannot even read the status', v_err LIKE 'Only the Super Admin%', COALESCE(v_err, 'no error'));

  PERFORM set_config('request.jwt.claims', c_anon, true);
  v_err := NULL;
  BEGIN
    PERFORM kaarbar_import_expenses('[]'::jsonb);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('An anonymous visitor is refused by the server', v_err LIKE 'Only the Super Admin%', COALESCE(v_err, 'no error'));

  PERFORM set_config('request.jwt.claims', c_admin_np, true);
  v_err := NULL;
  BEGIN
    PERFORM kaarbar_import_customers('[{"name":"E2E B49 Late","phone_key":"01700000490"}]'::jsonb);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('The Super Admin must type the password again (older than 5 minutes is refused)',
    v_err LIKE 'Type your password again%', COALESCE(v_err, 'no error'));

  -- ================================================ customers
  PERFORM set_config('request.jwt.claims', c_admin, true);
  -- The shop's real imports stay out of this test's Undo (rolled back).
  UPDATE kaarbar_imports SET undone_at = now() WHERE undone_at IS NULL;
  SELECT count(*) INTO v_bills0 FROM money_movements WHERE kaarbar_bill_no IS NOT NULL;
  INSERT INTO customers (customer_key, phone_key, full_name, phone, added_by_hand)
  VALUES ('ph:01700000499', '01700000499', 'E2E B49 Site Name', '01700000499', true);
  SELECT count(*) INTO v_dues0 FROM customer_opening_dues;
  SELECT count(*) INTO v_orders0 FROM orders;

  v_json := kaarbar_customers_check(jsonb_build_array(
    jsonb_build_object('n', 1, 'phone_key', '01700000491', 'name', 'E2E B49 New'),
    jsonb_build_object('n', 2, 'phone_key', '01700000499', 'name', 'E2E B49 Kaarbar Name'),
    jsonb_build_object('n', 3, 'phone_key', v_cust_pk, 'name', 'E2E B49 Has Login'),
    jsonb_build_object('n', 4, 'phone_key', NULL, 'name', 'E2E B49 No Phone')));
  PERFORM pg_temp.ck('Check: a new phone is not on the site', (v_json -> 0 ->> 'site_key') IS NULL, v_json::text);
  PERFORM pg_temp.ck('Check: the same phone finds the customer already on the site',
    (v_json -> 1 ->> 'site_key') = 'ph:01700000499' AND (v_json -> 1 ->> 'site_name') = 'E2E B49 Site Name', (v_json -> 1)::text);
  PERFORM pg_temp.ck('Check: a login account with that phone counts as on the site',
    v_cust_pk IS NULL OR (v_json -> 2 ->> 'site_key') = 'p:' || v_cust, (v_json -> 2)::text);
  PERFORM pg_temp.ck('Check: a no-phone name not on the site', (v_json -> 3 ->> 'site_key') IS NULL, (v_json -> 3)::text);

  v_json := kaarbar_import_customers(jsonb_build_array(
    jsonb_build_object('name', 'E2E B49 New', 'phone_key', '01700000491'),
    jsonb_build_object('name', 'E2E B49 Kaarbar Name', 'phone_key', '01700000499'),
    jsonb_build_object('name', 'E2E B49 New Twin', 'phone_key', '01700000491'),
    jsonb_build_object('name', 'E2E B49 No Phone', 'phone_key', NULL, 'contact', '12345')));
  v_imp1 := (v_json ->> 'import_id')::uuid;
  PERFORM pg_temp.ck('Import: 2 added (new + no phone), 2 skipped (already on the site, same phone twice)',
    (v_json ->> 'added')::int = 2 AND (v_json ->> 'skipped')::int = 2, v_json::text);
  PERFORM pg_temp.ck('Import: an admin customer (added by hand, marked with the import, no login)',
    EXISTS (SELECT 1 FROM customers WHERE customer_key = 'ph:01700000491' AND added_by_hand AND kaarbar_import_id = v_imp1
            AND full_name = 'E2E B49 New' AND note = 'From Kaarbar')
    AND NOT EXISTS (SELECT 1 FROM profiles WHERE bd_phone_key(phone) = '01700000491'));
  PERFORM pg_temp.ck('Import: the no-phone party is added by name and marked',
    EXISTS (SELECT 1 FROM customers WHERE customer_key = 'n:e2e b49 no phone' AND phone_key IS NULL
            AND note = 'From Kaarbar - no phone (Kaarbar contact: 12345)'));
  PERFORM pg_temp.ck('Import: the customer already on the site is not changed',
    (SELECT full_name FROM customers WHERE customer_key = 'ph:01700000499') = 'E2E B49 Site Name'
    AND (SELECT kaarbar_import_id FROM customers WHERE customer_key = 'ph:01700000499') IS NULL);
  PERFORM pg_temp.ck('Import: no due, no order is added or changed',
    (SELECT count(*) FROM customer_opening_dues) = v_dues0 AND (SELECT count(*) FROM orders) = v_orders0);
  PERFORM pg_temp.ck('Import: one Activity Log line with the count',
    EXISTS (SELECT 1 FROM activity_log WHERE action = 'kaarbar.customers_imported' AND entity_id = v_imp1::text
            AND summary = 'Imported 2 customers from Kaarbar (2 already on the site, skipped)'));
  v_err := NULL;
  BEGIN
    PERFORM kaarbar_import_customers('[{"name":"E2E B49 Bad","phone_key":"12345"}]'::jsonb);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Import: a phone that is not a mobile number is refused', v_err LIKE '%not a Bangladeshi mobile%', COALESCE(v_err, 'no error'));

  -- A second import; one of its customers then gets a due.
  v_json := kaarbar_import_customers(jsonb_build_array(
    jsonb_build_object('name', 'E2E B49 Gone', 'phone_key', '01700000492'),
    jsonb_build_object('name', 'E2E B49 Owes', 'phone_key', '01700000493')));
  INSERT INTO customer_opening_dues (phone_key, full_name, phone, amount, choice)
  VALUES ('01700000493', 'E2E B49 Owes', '01700000493', 100, 'kaarbar');
  v_json := kaarbar_undo_customers();
  PERFORM pg_temp.ck('Undo: removes the last import''s customers, keeps the one with a due (listed)',
    (v_json ->> 'removed')::int = 1
    AND (v_json -> 'kept' -> 0 ->> 'reason') = 'has a due'
    AND NOT EXISTS (SELECT 1 FROM customers WHERE customer_key = 'ph:01700000492')
    AND EXISTS (SELECT 1 FROM customers WHERE customer_key = 'ph:01700000493'), v_json::text);
  PERFORM pg_temp.ck('Undo: the first import is untouched until it is undone itself',
    EXISTS (SELECT 1 FROM customers WHERE customer_key = 'ph:01700000491'));
  v_json := kaarbar_undo_customers();
  PERFORM pg_temp.ck('Undo again: the first import''s 2 customers are removed',
    (v_json ->> 'removed')::int = 2 AND NOT EXISTS (SELECT 1 FROM customers WHERE kaarbar_import_id = v_imp1), v_json::text);
  PERFORM pg_temp.ck('Undo: written in the Activity Log',
    (SELECT count(*) FROM activity_log WHERE action = 'kaarbar.customers_undone') >= 2);
  v_err := NULL;
  BEGIN
    PERFORM kaarbar_undo_customers();
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Undo with nothing left says so', v_err = 'There is no customer import to undo.', COALESCE(v_err, 'no error'));

  -- ================================================ expenses
  v_today := inventory_dhaka_today();
  v_start := money_start_date();
  IF v_start IS NULL THEN
    v_start := v_today - 5;
    UPDATE money_books SET start_date = v_start, confirmed_at = now() WHERE id = 1;
    IF NOT FOUND THEN
      INSERT INTO money_books (id, start_date, confirmed_at) VALUES (1, v_start, now());
    END IF;
  END IF;
  v_old := (date_trunc('month', v_start) - interval '2 months')::date + 4;
  SELECT id INTO v_cash FROM money_accounts WHERE kind = 'cash' AND NOT archived ORDER BY sort_order LIMIT 1;
  SELECT id INTO v_bkash FROM money_accounts WHERE kind = 'bkash' AND NOT archived ORDER BY sort_order LIMIT 1;
  INSERT INTO parties_payable (name, kind) VALUES ('E2E B49 Investor', 'investor') RETURNING id INTO v_inv;
  SELECT balance INTO v_cash0 FROM money_account_balances() WHERE account_id = v_cash;
  SELECT balance INTO v_bkash0 FROM money_account_balances() WHERE account_id = v_bkash;
  SELECT count(*) INTO v_cats0 FROM money_categories;
  SELECT id, upper(name) INTO v_food_id, v_food FROM money_categories WHERE NOT archived ORDER BY sort_order LIMIT 1;

  v_json := kaarbar_status();
  PERFORM pg_temp.ck('Status: the start date, and only the shop''s own Kaarbar bills (none of this test''s yet)',
    (v_json ->> 'start_date')::date = v_start AND jsonb_array_length(v_json -> 'bill_nos') = v_bills0
    AND NOT (v_json -> 'bill_nos') ? 'E2E49-1', format('start %s, %s bills', v_json ->> 'start_date', jsonb_array_length(v_json -> 'bill_nos')));

  v_json := kaarbar_import_expenses(jsonb_build_array(
    jsonb_build_object('bill_no', 'E2E49-1', 'date', v_old, 'kind', 'expense', 'category', 'E2E B49 Old Cat',
                       'account_id', v_cash, 'amount', 500, 'note', E'পুরনো খরচ\nline two'),
    jsonb_build_object('bill_no', 'E2E49-2', 'date', v_today, 'kind', 'expense', 'category', '  ' || v_food || '  ',
                       'account_id', v_cash, 'amount', 300, 'note', ''),
    jsonb_build_object('bill_no', 'E2E49-3', 'date', v_today, 'kind', 'expense', 'category', 'E2E B49 New Cat',
                       'account_id', v_bkash, 'amount', 70, 'note', ''),
    jsonb_build_object('bill_no', 'E2E49-4', 'date', v_today, 'kind', 'investor_profit_share',
                       'account_id', v_cash, 'party_id', v_inv, 'amount', 1000, 'note', 'share'),
    jsonb_build_object('bill_no', 'E2E49-5', 'date', v_start - 1, 'kind', 'owner_withdrawal',
                       'account_id', v_cash, 'amount', 9999, 'note', 'old withdrawal')));
  v_imp1 := (v_json ->> 'import_id')::uuid;
  PERFORM pg_temp.ck('Expenses: 5 added, 2 new categories', (v_json ->> 'added')::int = 5 AND (v_json ->> 'new_categories')::int = 2, v_json::text);
  SELECT balance INTO v_num FROM money_account_balances() WHERE account_id = v_cash;
  PERFORM pg_temp.ck('Money rule: Cash goes down only by the rows on or after the start date (300 + 1000), not 500 or 9999',
    v_num = v_cash0 - 1300, format('before %s after %s', v_cash0, v_num));
  SELECT balance INTO v_num FROM money_account_balances() WHERE account_id = v_bkash;
  PERFORM pg_temp.ck('Money rule: bKash goes down by its own row', v_num = v_bkash0 - 70, format('before %s after %s', v_bkash0, v_num));
  PERFORM pg_temp.ck('The row before the start date is kept as history (stored, dated, with its exact note)',
    EXISTS (SELECT 1 FROM money_movements WHERE kaarbar_bill_no = 'E2E49-1' AND entry_date = v_old AND amount = -500
            AND type = 'expense' AND note = E'পুরনো খরচ\nline two'));
  PERFORM pg_temp.ck('Category: an existing name matches ignoring case and spaces (no new one)',
    (SELECT category_id FROM money_movements WHERE kaarbar_bill_no = 'E2E49-2') = v_food_id, v_food);
  PERFORM pg_temp.ck('Category: a missing one is created with Kaarbar''s exact name',
    EXISTS (SELECT 1 FROM money_categories WHERE name = 'E2E B49 New Cat') AND (SELECT count(*) FROM money_categories) = v_cats0 + 2);
  PERFORM pg_temp.ck('PROFIT SHARE is never an expense: an investor profit share and an owner withdrawal',
    (SELECT type FROM money_movements WHERE kaarbar_bill_no = 'E2E49-4') = 'investor_profit_share'
    AND (SELECT party_id FROM money_movements WHERE kaarbar_bill_no = 'E2E49-4') = v_inv
    AND (SELECT category_id FROM money_movements WHERE kaarbar_bill_no = 'E2E49-4') IS NULL
    AND (SELECT type FROM money_movements WHERE kaarbar_bill_no = 'E2E49-5') = 'owner_withdrawal'
    AND (SELECT count(*) FROM money_movements WHERE kaarbar_import_id = v_imp1 AND type = 'expense') = 3);
  PERFORM pg_temp.ck('Expenses import: one Activity Log line',
    EXISTS (SELECT 1 FROM activity_log WHERE action = 'kaarbar.expenses_imported' AND entity_id = v_imp1::text
            AND summary LIKE 'Imported 5 expenses from Kaarbar%'));

  -- A newer Expense Report: the same Bill Nos again plus one new row.
  v_json := kaarbar_import_expenses(jsonb_build_array(
    jsonb_build_object('bill_no', 'E2E49-2', 'date', v_today, 'kind', 'expense', 'category', 'Food',
                       'account_id', v_cash, 'amount', 300, 'note', ''),
    jsonb_build_object('bill_no', 'E2E49-6', 'date', v_today, 'kind', 'expense', 'category', 'E2E B49 Second Cat',
                       'account_id', v_cash, 'amount', 40, 'note', '')));
  PERFORM pg_temp.ck('Second upload: the Bill No already on the site is skipped, only the new row comes in',
    (v_json ->> 'added')::int = 1 AND (v_json ->> 'skipped')::int = 1
    AND (SELECT count(*) FROM money_movements WHERE kaarbar_bill_no = 'E2E49-2') = 1, v_json::text);
  PERFORM pg_temp.ck('kaarbar_status lists the imported Bill Nos', jsonb_array_length(kaarbar_status() -> 'bill_nos') = v_bills0 + 6);

  v_json := kaarbar_undo_expenses();
  SELECT balance INTO v_num FROM money_account_balances() WHERE account_id = v_cash;
  PERFORM pg_temp.ck('Undo expenses: the last import is removed, its money goes back, its new category is removed',
    (v_json ->> 'removed')::int = 1 AND v_num = v_cash0 - 1300
    AND NOT EXISTS (SELECT 1 FROM money_movements WHERE kaarbar_bill_no = 'E2E49-6')
    AND NOT EXISTS (SELECT 1 FROM money_categories WHERE name = 'E2E B49 Second Cat'), v_json::text);

  -- Month locks are never bypassed.
  INSERT INTO money_month_locks (month, locked, locked_at, checklist)
  VALUES (date_trunc('month', v_old)::date, true, now(), '{}'::jsonb)
  ON CONFLICT (month) DO UPDATE SET locked = true;
  v_err := NULL;
  BEGIN
    PERFORM kaarbar_import_expenses(jsonb_build_array(
      jsonb_build_object('bill_no', 'E2E49-7', 'date', v_old, 'kind', 'expense', 'category', 'Food',
                         'account_id', v_cash, 'amount', 10, 'note', '')));
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('A row in a locked month is refused (the screen leaves those out)',
    v_err LIKE '%is locked%' AND NOT EXISTS (SELECT 1 FROM money_movements WHERE kaarbar_bill_no = 'E2E49-7'), COALESCE(v_err, 'no error'));
  v_json := kaarbar_status();
  PERFORM pg_temp.ck('kaarbar_status lists the locked month', (v_json -> 'locked_months') ? to_char(v_old, 'YYYY-MM'), v_json::text);

  v_json := kaarbar_undo_expenses();
  SELECT balance INTO v_num FROM money_account_balances() WHERE account_id = v_cash;
  PERFORM pg_temp.ck('Undo expenses: everything goes back except the row in the locked month (kept and listed)',
    (v_json ->> 'removed')::int = 4 AND (v_json -> 'kept' -> 0 ->> 'bill_no') = 'E2E49-1'
    AND EXISTS (SELECT 1 FROM money_movements WHERE kaarbar_bill_no = 'E2E49-1')
    AND v_num = v_cash0, format('%s / cash before %s after %s', v_json, v_cash0, v_num));
  PERFORM pg_temp.ck('Undo expenses: the category the kept row uses stays; the unused new one is removed',
    EXISTS (SELECT 1 FROM money_categories WHERE name = 'E2E B49 Old Cat')
    AND NOT EXISTS (SELECT 1 FROM money_categories WHERE name = 'E2E B49 New Cat'));
  SELECT balance INTO v_num FROM money_account_balances() WHERE account_id = v_bkash;
  PERFORM pg_temp.ck('Undo expenses: bKash is back where it was', v_num = v_bkash0, format('before %s after %s', v_bkash0, v_num));

  PERFORM set_config('request.jwt.claims', c_admin_np, true);
  v_err := NULL;
  BEGIN
    PERFORM kaarbar_undo_expenses();
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Undo also needs the password again', v_err LIKE 'Type your password again%', COALESCE(v_err, 'no error'));
  PERFORM pg_temp.ck('Nothing touched orders or opening dues in the whole run',
    (SELECT count(*) FROM orders) = v_orders0 AND (SELECT count(*) FROM customer_opening_dues) = v_dues0 + 1);
END
$test$;
SELECT 'TEST_RESULT' AS tag, json_agg(json_build_object('name', name, 'ok', ok, 'detail', detail) ORDER BY n)::text AS results FROM t_res;
ROLLBACK;
