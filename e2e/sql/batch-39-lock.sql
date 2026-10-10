-- Batch 39: "two orders at the same moment can never take the same units".
-- Run by e2e/batch-39.spec.ts as four separate database sessions, split by
-- the "-- @step <name>" lines below:
--   setup    a hidden throwaway product with ONE lot row of 3 units and two
--            throwaway orders. Triggers are off for this one transaction
--            (session_replication_role = replica), so no order alert is sent
--            and no shop number changes.
--   first    takes 2 units for order A, raises a marker lock (39, TAG),
--            then holds everything for 8 seconds before saving.
--   second   waits until it sees the marker, then tries to take 2 units for
--            order B. It must wait for the first session, then find only 1
--            unit and be refused. Ends with an error, so nothing of it is saved.
--   cleanup  removes everything the setup and the first session saved.
-- Inventory mode is on only inside "first" and "second" (inventory.test_mode).
-- {{TAG}} makes every name unique to the run.

-- @step setup
DO $setup$
DECLARE
  v_product uuid;
  v_lot     uuid;
  v_item    uuid;
  v_order   uuid;
BEGIN
  SET LOCAL session_replication_role = replica;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('E2E-B39-LOCK-{{TAG}}', 'e2e-b39-lock-{{TAG}}', 'E2E B39 Lock test {{TAG}}', 100, 'in_stock', 0, false)
  RETURNING id INTO v_product;
  INSERT INTO lots (code, kind, source_type, lot_date, supplier, notes)
  VALUES ('E2E-B39-{{TAG}}', 'purchase', 'local', current_date, 'E2E B39 supplier', 'e2e b39 lock test')
  RETURNING id INTO v_lot;
  INSERT INTO lot_items (lot_id, product_id, sort_order, qty, unit_price_foreign, unit_price_bdt, buy_value_bdt,
                         landed_unit_cost_bdt, qty_remaining)
  VALUES (v_lot, v_product, 1, 3, 50, 50, 150, 50, 3)
  RETURNING id INTO v_item;
  INSERT INTO stock_movements (lot_item_id, movement_type, qty, reference, reason)
  VALUES (v_item, 'purchase', 3, 'E2E-B39-{{TAG}}', 'e2e lock test');
  FOREACH v_order IN ARRAY ARRAY[gen_random_uuid(), gen_random_uuid()] LOOP
    INSERT INTO orders (id, order_number, customer_name, customer_phone, division, district, thana, address_line,
                        delivery_zone, delivery_fee, subtotal, total, payment_method, status, source)
    VALUES (v_order, 'E2E-B39-' || CASE WHEN NOT EXISTS (SELECT 1 FROM orders WHERE order_number = 'E2E-B39-A-{{TAG}}')
                                        THEN 'A' ELSE 'B' END || '-{{TAG}}',
            'E2E B39 lock test', '01700000000', 'Dhaka', 'Dhaka', 'Gulshan', 'Test road',
            'inside_dhaka', 0, 200, 200, 'cod', 'confirmed', 'other');
    INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, line_total, list_price)
    VALUES (v_order, v_product, 'E2E B39 Lock test {{TAG}}', 100, 2, 200, 100);
  END LOOP;
END
$setup$;

-- @step first
DO $first$
DECLARE
  v_item order_items;
BEGIN
  PERFORM set_config('inventory.test_mode', 'on', true);
  SELECT oi.* INTO v_item FROM order_items oi JOIN orders o ON o.id = oi.order_id
  WHERE o.order_number = 'E2E-B39-A-{{TAG}}';
  PERFORM inventory_take_units(v_item, 2, 'E2E-B39-A-{{TAG}}');
  -- A marker the second session can see: "the units are taken, the lot
  -- row is locked until this transaction ends".
  PERFORM pg_advisory_xact_lock(39, {{TAG}});
  PERFORM pg_sleep(8);
END
$first$;

-- @step second
DO $second$
DECLARE
  v_item    order_items;
  v_started timestamptz;
  v_err     text := 'taken';
  v_tries   integer := 0;
BEGIN
  -- Wait (up to 30 s) until the first session holds the lot row.
  WHILE NOT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = 39 AND objid = {{TAG}} AND granted) LOOP
    v_tries := v_tries + 1;
    IF v_tries > 300 THEN
      RAISE EXCEPTION 'TEST_RESULT:%', json_build_object('second', 'the first session never started', 'waited_ms', 0);
    END IF;
    PERFORM pg_sleep(0.1);
  END LOOP;
  v_started := clock_timestamp();
  PERFORM set_config('inventory.test_mode', 'on', true);
  SELECT oi.* INTO v_item FROM order_items oi JOIN orders o ON o.id = oi.order_id
  WHERE o.order_number = 'E2E-B39-B-{{TAG}}';
  BEGIN
    PERFORM inventory_take_units(v_item, 2, 'E2E-B39-B-{{TAG}}');
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
  END;
  RAISE EXCEPTION 'TEST_RESULT:%', json_build_object(
    'second', v_err,
    'waited_ms', round(extract(epoch FROM clock_timestamp() - v_started) * 1000));
END
$second$;

-- @step check
DO $check$
BEGIN
  RAISE EXCEPTION 'TEST_RESULT:%', json_build_object(
    'left', (SELECT li.qty_remaining FROM lot_items li JOIN lots l ON l.id = li.lot_id WHERE l.code = 'E2E-B39-{{TAG}}'),
    'ledger', (SELECT sum(m.qty) FROM stock_movements m JOIN lot_items li ON li.id = m.lot_item_id
               JOIN lots l ON l.id = li.lot_id WHERE l.code = 'E2E-B39-{{TAG}}'),
    'taken_a', (SELECT COALESCE(sum(x.units), 0) FROM order_item_lots x JOIN orders o ON o.id = x.order_id
                WHERE o.order_number = 'E2E-B39-A-{{TAG}}'),
    'taken_b', (SELECT COALESCE(sum(x.units), 0) FROM order_item_lots x JOIN orders o ON o.id = x.order_id
                WHERE o.order_number = 'E2E-B39-B-{{TAG}}'),
    'log', (SELECT count(*) FROM activity_log WHERE action = 'inventory.order_stock'
            AND entity_label = 'E2E-B39-A-{{TAG}}'));
END
$check$;

-- @step cleanup
DO $cleanup$
DECLARE
  v_orders uuid[] := ARRAY(SELECT id FROM orders WHERE order_number IN ('E2E-B39-A-{{TAG}}', 'E2E-B39-B-{{TAG}}'));
  v_lots   uuid[] := ARRAY(SELECT id FROM lots WHERE code = 'E2E-B39-{{TAG}}');
BEGIN
  SET LOCAL session_replication_role = replica;
  DELETE FROM order_item_lots WHERE order_id = ANY (v_orders);
  DELETE FROM stock_shortfalls WHERE order_id = ANY (v_orders);
  DELETE FROM cost_adjustments WHERE order_id = ANY (v_orders);
  DELETE FROM stock_movements WHERE lot_item_id IN (SELECT id FROM lot_items WHERE lot_id = ANY (v_lots));
  DELETE FROM lot_items WHERE lot_id = ANY (v_lots);
  DELETE FROM lots WHERE id = ANY (v_lots);
  DELETE FROM order_status_history WHERE order_id = ANY (v_orders);
  DELETE FROM order_items WHERE order_id = ANY (v_orders);
  DELETE FROM orders WHERE id = ANY (v_orders);
  DELETE FROM products WHERE sku = 'E2E-B39-LOCK-{{TAG}}';
END
$cleanup$;
