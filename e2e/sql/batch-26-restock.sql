-- Restock (run by e2e/batch-26.spec.ts through the Supabase command line).
-- Batch 61: the live shop runs Inventory mode, where Restock is refused on
-- purpose (stock comes from lots), so the browser test can no longer save
-- a restock. Here, inside ONE transaction that always ends with ROLLBACK,
-- Inventory mode is set Off and then On (inventory.mode_change) on a
-- made-up product with an option. Nothing real is changed.
--
-- Result: the rows (name, ok, detail) of the SELECT before the ROLLBACK.
DO $test$
DECLARE
  v_admin uuid;
  v_cust  uuid;
  c_admin text;
  c_cust  text;
  v_tag   text := to_char(clock_timestamp(), 'HH24MISSMS');
  v_prod  uuid;
  v_var   uuid;
  v_json  jsonb;
  v_err   text;
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
  c_cust := json_build_object('sub', v_cust, 'role', 'authenticated')::text;

  -- ================================================ Inventory mode Off
  PERFORM set_config('inventory.mode_change', 'on', true);
  UPDATE app_settings SET value = 'false' WHERE key = 'inventory_mode';
  PERFORM set_config('inventory.mode_change', '', true);
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('E2E-B26R-' || v_tag, 'e2e-b26r-' || v_tag, 'E2E B26 Restock', 1000, 'in_stock', 5, false)
  RETURNING id INTO v_prod;
  INSERT INTO product_variants (product_id, region, size, retail_price, in_stock, stock_quantity, sort_order)
  VALUES (v_prod, 'E2E', '50ml', 1500, true, 3, 1) RETURNING id INTO v_var;

  PERFORM set_config('request.jwt.claims', c_admin, true);
  v_json := admin_restock(v_prod, NULL, 'add', 24);
  PERFORM pg_temp.ck('Add 24 to 5 → 29', (SELECT stock_quantity FROM products WHERE id = v_prod) = 29
    AND (v_json ->> 'before')::int = 5 AND (v_json ->> 'after')::int = 29, v_json::text);
  v_json := admin_restock(v_prod, v_var, 'set', 7);
  PERFORM pg_temp.ck('Set the option to 7 (from 3)', (SELECT stock_quantity FROM product_variants WHERE id = v_var) = 7, v_json::text);
  PERFORM pg_temp.ck('Both are in the Activity Log, by the admin',
    (SELECT array_agg(summary ORDER BY id) FROM activity_log WHERE action = 'product.restock' AND entity_id = v_prod::text)
      = ARRAY['Restock: 5 → 29', 'Restock (E2E · 50ml): 3 → 7'],
    (SELECT string_agg(summary, ' | ' ORDER BY id) FROM activity_log WHERE action = 'product.restock' AND entity_id = v_prod::text));
  PERFORM pg_temp.ck('"Last updated" is stamped', (SELECT last_edited_at >= now() - interval '1 minute' FROM products WHERE id = v_prod));

  v_err := NULL;
  BEGIN
    PERFORM admin_restock(v_prod, NULL, 'add', 0);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Add 0 is refused', v_err = 'Enter a whole number of 0 or more.', COALESCE(v_err, 'it ran'));

  PERFORM set_config('request.jwt.claims', c_cust, true);
  v_err := NULL;
  BEGIN
    PERFORM admin_restock(v_prod, NULL, 'add', 5);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Without "Edit products and stock" it is refused, nothing changes',
    v_err = 'Not authorized.' AND (SELECT stock_quantity FROM products WHERE id = v_prod) = 29, COALESCE(v_err, 'it ran'));

  -- ================================================ Inventory mode On
  PERFORM set_config('inventory.mode_change', 'on', true);
  UPDATE app_settings SET value = 'true' WHERE key = 'inventory_mode';
  PERFORM set_config('inventory.mode_change', '', true);
  PERFORM set_config('request.jwt.claims', c_admin, true);
  v_err := NULL;
  BEGIN
    PERFORM admin_restock(v_prod, NULL, 'add', 5);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Inventory mode On: refused, add a lot instead',
    v_err = 'Inventory mode is On: stock comes from lots. Add a lot instead (Inventory → New lot).', COALESCE(v_err, 'it ran'));
END
$test$;
SELECT 'TEST_RESULT' AS tag, json_agg(json_build_object('name', name, 'ok', ok, 'detail', detail) ORDER BY n)::text AS results FROM t_res;
ROLLBACK;
