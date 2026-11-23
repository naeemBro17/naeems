-- Reopen a cancelled order (run by e2e/fix-order-actions.spec.ts through
-- the Supabase command line). Batch 61: the browser test's orders are of a
-- made-up product with no stock, which the database will not reopen, so
-- the real reopen is checked here instead. Everything — Inventory mode Off
-- for this transaction (inventory.mode_change), the made-up product with
-- 5 in stock, the order — runs inside ONE transaction that always ends
-- with ROLLBACK. Nothing real is changed.
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
  v_o     uuid;
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

  PERFORM set_config('inventory.mode_change', 'on', true);
  UPDATE app_settings SET value = 'false' WHERE key = 'inventory_mode';
  PERFORM set_config('inventory.mode_change', '', true);
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active, keep_selling)
  VALUES ('E2E-REOPEN-' || v_tag, 'e2e-reopen-' || v_tag, 'E2E Reopen Cream', 1000, 'in_stock', 5, true, false)
  RETURNING id INTO v_prod;

  PERFORM set_config('request.jwt.claims', c_cust, true);
  SELECT order_id INTO v_o FROM place_order(jsonb_build_array(jsonb_build_object('product_id', v_prod, 'quantity', 1)),
    'E2E Reopen', '01712345678', 'Dhaka', 'Dhaka', 'Gulshan', 'Test road', 'inside_dhaka', 'cod');
  PERFORM pg_temp.ck('The order takes 1 (5 → 4)', (SELECT stock_quantity FROM products WHERE id = v_prod) = 4);

  PERFORM set_config('request.jwt.claims', c_admin, true);
  PERFORM admin_set_order_status(v_o, 'confirmed');
  PERFORM admin_set_order_status(v_o, 'cancelled');
  PERFORM pg_temp.ck('Cancel gives it back (4 → 5)', (SELECT stock_quantity FROM products WHERE id = v_prod) = 5);

  PERFORM admin_reopen_order(v_o);
  PERFORM pg_temp.ck('Reopen: back to its old status (Confirmed)', (SELECT status FROM orders WHERE id = v_o) = 'confirmed',
    (SELECT status FROM orders WHERE id = v_o));
  PERFORM pg_temp.ck('Reopen takes the stock again (5 → 4)', (SELECT stock_quantity FROM products WHERE id = v_prod) = 4);
  PERFORM pg_temp.ck('Reopen is in the order history (cancelled → confirmed)',
    -- (one transaction: every history row has the same time, so it is
    -- looked for, not taken as "the newest")
    EXISTS (SELECT 1 FROM order_status_history
            WHERE order_id = v_o AND old_status = 'cancelled' AND new_status = 'confirmed'));
  PERFORM pg_temp.ck('Reopen is in the Activity Log',
    EXISTS (SELECT 1 FROM activity_log WHERE entity_id = v_o::text AND summary LIKE '%cancelled → confirmed%'));

  v_err := NULL;
  BEGIN
    PERFORM admin_reopen_order(v_o);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('A second reopen is refused', v_err LIKE '%Only a cancelled order can be reopened.%', COALESCE(v_err, 'it ran'));

  -- Short stock: the reopen is refused and nothing changes.
  PERFORM admin_set_order_status(v_o, 'cancelled');
  UPDATE products SET stock_quantity = 0 WHERE id = v_prod;
  v_err := NULL;
  BEGIN
    PERFORM admin_reopen_order(v_o);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('Short stock: reopen refused, the order stays cancelled',
    v_err LIKE 'Only 0 %' AND (SELECT status FROM orders WHERE id = v_o) = 'cancelled', COALESCE(v_err, 'it ran'));

  PERFORM set_config('request.jwt.claims', c_cust, true);
  v_err := NULL;
  BEGIN
    PERFORM admin_reopen_order(v_o);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('A customer cannot reopen', v_err IS NOT NULL, COALESCE(v_err, 'it ran'));
END
$test$;
SELECT 'TEST_RESULT' AS tag, json_agg(json_build_object('name', name, 'ok', ok, 'detail', detail) ORDER BY n)::text AS results FROM t_res;
ROLLBACK;
