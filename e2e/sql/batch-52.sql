-- Batch 52 database tests (run by e2e/batch-52.spec.ts through the Supabase
-- command line). The runner puts the whole Batch 52 migration
-- (supabase/migration-053-batch52.sql, without its own BEGIN / COMMIT) in
-- front of this script, so the tables, the made-up combos and everything
-- else run inside ONE transaction that always ends with ROLLBACK. Nothing
-- real is changed.
--
-- Result: the rows (name, ok, detail) of the SELECT before the ROLLBACK.
DO $test$
DECLARE
  v_admin  uuid;
  v_cust   uuid;
  c_admin  text;
  c_cust   text;
  c_anon   text;
  v_p1     uuid;
  v_p2     uuid;
  v_combo  uuid;
  v_json   jsonb;
  v_int    integer;
  v_err    text;
  v_stock  integer;
  v_orders integer;
  v_promo  integer;
BEGIN
  EXECUTE 'CREATE TEMP TABLE t_res (n serial, name text, ok boolean, detail text)';
  -- Results are written while acting as the admin / a customer / logged out.
  EXECUTE 'GRANT ALL ON t_res TO anon, authenticated';
  EXECUTE 'GRANT ALL ON SEQUENCE t_res_n_seq TO anon, authenticated';
  EXECUTE $f$CREATE FUNCTION pg_temp.ck(p_name text, p_ok boolean, p_detail text DEFAULT '') RETURNS void
    LANGUAGE sql AS 'INSERT INTO t_res (name, ok, detail) VALUES (p_name, COALESCE(p_ok, false), COALESCE(p_detail, ''''))'$f$;

  SELECT id INTO v_admin FROM auth.users WHERE lower(email) = lower('{{ADMIN_EMAIL}}');
  SELECT id INTO v_cust FROM auth.users WHERE lower(email) = lower('{{CUSTOMER_EMAIL}}');
  IF v_admin IS NULL OR v_cust IS NULL THEN
    RAISE EXCEPTION 'TEST_SETUP:the test accounts were not found';
  END IF;
  c_admin := json_build_object('sub', v_admin, 'role', 'authenticated', 'aal', 'aal2',
    'amr', json_build_array(json_build_object('method', 'password', 'timestamp', extract(epoch FROM now())::bigint)))::text;
  c_cust := json_build_object('sub', v_cust, 'role', 'authenticated')::text;
  c_anon := json_build_object('role', 'anon')::text;

  SELECT id INTO v_p1 FROM products WHERE is_active ORDER BY name LIMIT 1;
  SELECT id INTO v_p2 FROM products WHERE is_active ORDER BY name OFFSET 1 LIMIT 1;
  SELECT COALESCE(sum(stock_quantity), 0) INTO v_stock FROM products;
  SELECT count(*) INTO v_orders FROM orders;
  SELECT COALESCE(sum(times_used), 0) INTO v_promo FROM promo_codes;

  PERFORM pg_temp.ck('Tables exist with row security on',
    (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.combos'::regclass)
    AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.combo_items'::regclass));

  -- ------------------------------------------------------------- admin
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  v_combo := admin_create_combo('e2etest2', '  E2E glow routine  ', 'Morning and night.',
    jsonb_build_array(
      jsonb_build_object('product_id', v_p1, 'variant_id', NULL, 'quantity', 2),
      jsonb_build_object('product_id', v_p2, 'variant_id', v_p2, 'quantity', 1)));
  PERFORM pg_temp.ck('Admin makes a combo (name trimmed, lines in order)',
    v_combo IS NOT NULL
    AND (SELECT name FROM combos WHERE id = v_combo) = 'E2E glow routine'
    AND (SELECT count(*) FROM combo_items WHERE combo_id = v_combo) = 2
    AND (SELECT product_id FROM combo_items WHERE combo_id = v_combo AND sort_order = 0) = v_p1);
  PERFORM pg_temp.ck('Admin lists combos', (SELECT count(*) FROM combos WHERE code = 'e2etest2') = 1);
  UPDATE combos SET preview_url = 'https://example.com/p.jpg' WHERE id = v_combo;
  PERFORM pg_temp.ck('Admin saves the preview picture',
    (SELECT preview_url FROM combos WHERE id = v_combo) = 'https://example.com/p.jpg');

  BEGIN
    PERFORM admin_create_combo('e2etest2', 'Same code', '', jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 1)));
    v_err := 'no error';
  EXCEPTION WHEN unique_violation THEN v_err := 'unique';
  END;
  PERFORM pg_temp.ck('A code already taken is refused (the app then tries a new one)', v_err = 'unique', v_err);

  BEGIN
    PERFORM admin_create_combo('BAD-CODE', 'x', '', jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 1)));
    v_err := 'no error';
  EXCEPTION WHEN check_violation THEN v_err := 'check';
  END;
  PERFORM pg_temp.ck('A badly shaped code is refused', v_err = 'check', v_err);

  BEGIN
    PERFORM admin_create_combo('e2etest3', repeat('x', 61), '', jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 1)));
    v_err := 'no error';
  EXCEPTION WHEN check_violation THEN v_err := 'check';
  END;
  PERFORM pg_temp.ck('A name over 60 letters is refused', v_err = 'check', v_err);

  BEGIN
    PERFORM admin_create_combo('e2etest4', 'x', repeat('y', 301), jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 1)));
    v_err := 'no error';
  EXCEPTION WHEN check_violation THEN v_err := 'check';
  END;
  PERFORM pg_temp.ck('A note over 300 letters is refused', v_err = 'check', v_err);

  BEGIN
    PERFORM admin_create_combo('e2etest5', 'x', '', '[]'::jsonb);
    v_err := 'no error';
  EXCEPTION WHEN raise_exception THEN v_err := 'empty';
  END;
  PERFORM pg_temp.ck('An empty combo is refused', v_err = 'empty', v_err);

  BEGIN
    PERFORM admin_create_combo('e2etest6', 'x', '', jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 0)));
    v_err := 'no error';
  EXCEPTION WHEN check_violation THEN v_err := 'check';
  END;
  PERFORM pg_temp.ck('A quantity of 0 is refused', v_err = 'check', v_err);
  EXECUTE 'RESET ROLE';

  -- ----------------------------------------------- anyone with the link
  PERFORM set_config('request.jwt.claims', c_anon, true);
  EXECUTE 'SET LOCAL ROLE anon';
  v_json := get_combo('e2etest2');
  PERFORM pg_temp.ck('A logged-out visitor reads the combo by its code',
    v_json ->> 'name' = 'E2E glow routine'
    AND v_json ->> 'note' = 'Morning and night.'
    AND jsonb_array_length(v_json -> 'items') = 2
    AND (v_json -> 'items' -> 0 ->> 'quantity')::int = 2,
    COALESCE(v_json::text, 'null'));
  PERFORM pg_temp.ck('Only what the page needs (no id, no maker, no date)',
    NOT (v_json ? 'id') AND NOT (v_json ? 'created_by') AND NOT (v_json ? 'created_at'),
    COALESCE(v_json::text, 'null'));
  PERFORM pg_temp.ck('An unknown code reads as nothing', get_combo('zzzzzzzz') IS NULL);
  PERFORM pg_temp.ck('A badly shaped code reads as nothing', get_combo('e2etest2'' OR 1=1') IS NULL);
  BEGIN
    SELECT count(*) INTO v_int FROM combos;
    v_err := 'listed ' || v_int;
  EXCEPTION WHEN insufficient_privilege THEN v_err := 'refused';
  END;
  PERFORM pg_temp.ck('A logged-out visitor cannot list combos', v_err = 'refused', v_err);
  BEGIN
    PERFORM admin_create_combo('e2etest7', 'x', '', jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 1)));
    v_err := 'made';
  EXCEPTION WHEN insufficient_privilege THEN v_err := 'refused';
  END;
  PERFORM pg_temp.ck('A logged-out visitor cannot make a combo', v_err = 'refused', v_err);
  EXECUTE 'RESET ROLE';

  -- ----------------------------------------------------------- customer
  PERFORM set_config('request.jwt.claims', c_cust, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM pg_temp.ck('A customer cannot list combos', (SELECT count(*) FROM combos) = 0);
  PERFORM pg_temp.ck('A customer reads a combo only by its code', get_combo('e2etest2') ->> 'name' = 'E2E glow routine');
  BEGIN
    PERFORM admin_create_combo('e2etest8', 'x', '', jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 1)));
    v_err := 'made';
  EXCEPTION WHEN insufficient_privilege THEN v_err := 'refused';
  END;
  PERFORM pg_temp.ck('A customer cannot make a combo', v_err = 'refused', v_err);
  DELETE FROM combos WHERE id = v_combo;
  GET DIAGNOSTICS v_int = ROW_COUNT;
  PERFORM pg_temp.ck('A customer cannot delete a combo', v_int = 0, v_int::text);
  UPDATE combos SET name = 'hacked' WHERE id = v_combo;
  GET DIAGNOSTICS v_int = ROW_COUNT;
  PERFORM pg_temp.ck('A customer cannot change a combo', v_int = 0, v_int::text);
  EXECUTE 'RESET ROLE';

  -- ------------------------------------------------------------- delete
  PERFORM set_config('request.jwt.claims', c_admin, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  DELETE FROM combos WHERE id = v_combo;
  EXECUTE 'RESET ROLE';
  PERFORM pg_temp.ck('Admin deletes a combo: its lines go too, the link reads nothing',
    NOT EXISTS (SELECT 1 FROM combo_items WHERE combo_id = v_combo) AND get_combo('e2etest2') IS NULL);

  PERFORM pg_temp.ck('Combos never touch stock, orders or promo codes',
    (SELECT COALESCE(sum(stock_quantity), 0) FROM products) = v_stock
    AND (SELECT count(*) FROM orders) = v_orders
    AND (SELECT COALESCE(sum(times_used), 0) FROM promo_codes) = v_promo);
END
$test$;
SELECT 'TEST_RESULT' AS tag, json_agg(json_build_object('name', name, 'ok', ok, 'detail', detail) ORDER BY n)::text AS results FROM t_res;
ROLLBACK;
