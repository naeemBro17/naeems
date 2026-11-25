-- Batch 66 (Campaigns), tested on the database (run by e2e/batch-66.spec.ts
-- through the Supabase command line).
--
-- SAFE ON THE LIVE DATABASE: everything runs inside ONE transaction that
-- always ends with ROLLBACK. Only made-up rows are added (products "B66 …",
-- campaigns "B66 …", a made-up promo code); Inventory mode is set Off and
-- the advance-discount rule is set inside the transaction only.
--
-- Before Naeem has run migration-063 the spec puts the migration in front
-- of this file (same transaction, without its BEGIN / COMMIT).
--
-- Result: the row (tag TEST_RESULT, results = JSON list of
-- { name, ok, detail }) of the SELECT before the ROLLBACK.
CREATE TEMP TABLE t_res (n serial, name text, ok boolean, detail text) ON COMMIT DROP;
GRANT ALL ON t_res TO authenticated, anon;
GRANT ALL ON SEQUENCE t_res_n_seq TO authenticated, anon;

DO $test$
DECLARE
  v_admin    uuid;
  v_cust     uuid;
  c_admin    text;
  c_cust     text;
  v_tag      text := to_char(clock_timestamp(), 'HH24MISSMS');
  d0         numeric;
  v_err      text;
  v_j        jsonb;
  v_n        integer;
  v_fee      numeric;
  v_p1       uuid;  -- 1000, no offer           (Live %: 20 % → 800)
  v_p2       uuid;  -- 1000, offer 700           (Live %: 800 vs 700 → 700)
  v_p3       uuid;  -- 900, no sizes             (Live own: 650)
  v_p4       uuid;  -- 1800 own size + sizes     (Live own: size A 1500, size B not in it)
  v_p4a      uuid;  -- size A, 2000
  v_p4b      uuid;  -- size B, 2500
  v_p5       uuid;  -- 500, never in a campaign
  v_p6       uuid;  -- scheduled campaign
  v_p7       uuid;  -- ended campaign
  v_p8       uuid;  -- switched-off campaign
  v_live     uuid;
  v_own      uuid;
  v_sched    uuid;
  v_ended    uuid;
  v_off      uuid;
  v_spare    uuid;
  v_o1       uuid;
  v_o2       uuid;
  v_o3       uuid;
  v_o4       uuid;
  v_row      record;
  v_used0    integer;
  v_code     text;
  v_slug1    text;
  v_slug2    text;
BEGIN
  SELECT id INTO v_admin FROM auth.users WHERE lower(email) = lower('{{ADMIN_EMAIL}}');
  SELECT id INTO v_cust FROM auth.users WHERE lower(email) = lower('{{CUSTOMER_EMAIL}}');
  IF v_admin IS NULL OR v_cust IS NULL THEN
    RAISE EXCEPTION 'TEST_SETUP:the test accounts were not found';
  END IF;
  c_admin := json_build_object('sub', v_admin, 'role', 'authenticated', 'aal', 'aal2')::text;
  c_cust := json_build_object('sub', v_cust, 'role', 'authenticated')::text;

  EXECUTE $f$CREATE FUNCTION pg_temp.ck(p_name text, p_ok boolean, p_detail text DEFAULT '') RETURNS void
    LANGUAGE sql AS 'INSERT INTO t_res (name, ok, detail) VALUES (p_name, COALESCE(p_ok, false), COALESCE(p_detail, ''''))'$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.diff() RETURNS numeric LANGUAGE sql AS
    'SELECT (money_position() ->> ''difference'')::numeric'$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.sale(p_product uuid, p_variant uuid) RETURNS numeric LANGUAGE sql AS
    'SELECT s.price FROM campaign_sale_price(p_product, p_variant,
       COALESCE((SELECT retail_price FROM product_variants WHERE id = p_variant), (SELECT retail_price FROM products WHERE id = p_product)),
       CASE WHEN p_variant IS NULL THEN (SELECT offer_price FROM products WHERE id = p_product)
            ELSE (SELECT offer_price FROM product_variants WHERE id = p_variant) END) s'$f$;

  PERFORM set_config('request.jwt.claims', c_admin, true);
  d0 := pg_temp.diff();
  PERFORM pg_temp.ck('0 Balance check difference before the test is ৳0.00', abs(d0) < 0.01, d0::text);

  -- ------------------------------------------------------------ 0. who may read
  PERFORM pg_temp.ck('0 Signed-out and signed-in people cannot read the tables directly',
    NOT has_table_privilege('anon', 'campaigns', 'SELECT') AND NOT has_table_privilege('authenticated', 'campaigns', 'SELECT')
    AND NOT has_table_privilege('anon', 'campaign_items', 'SELECT') AND NOT has_table_privilege('authenticated', 'campaign_items', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'campaigns', 'INSERT'));
  PERFORM pg_temp.ck('0 Anyone may ask for the live campaigns; only signed-in people for the admin functions',
    has_function_privilege('anon', 'live_campaigns()', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'admin_campaigns()', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'admin_save_campaign(jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'campaign_sale_price(uuid,uuid,numeric,numeric)', 'EXECUTE'));

  -- ------------------------------------------------------------ setup (rolled back)
  PERFORM set_config('inventory.mode_change', 'on', true);
  UPDATE app_settings SET value = 'false' WHERE key = 'inventory_mode';
  PERFORM set_config('inventory.mode_change', '', true);
  PERFORM set_config('inventory.test_mode', '', true);
  INSERT INTO app_settings (key, value) VALUES ('advance_discount_enabled', 'true'), ('advance_discount_type', 'percent'),
    ('advance_discount_value', '10')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
  SELECT COALESCE((SELECT value::numeric FROM app_settings WHERE key = 'delivery_fee_inside_dhaka'), 80) INTO v_fee;

  INSERT INTO products (sku, slug, name, retail_price, offer_price, stock_status, stock_quantity, is_active) VALUES
    ('B66-1-' || v_tag, 'b66-1-' || v_tag, 'B66 One ' || v_tag, 1000, NULL, 'in_stock', 50, true) RETURNING id INTO v_p1;
  INSERT INTO products (sku, slug, name, retail_price, offer_price, stock_status, stock_quantity, is_active) VALUES
    ('B66-2-' || v_tag, 'b66-2-' || v_tag, 'B66 Two ' || v_tag, 1000, 700, 'in_stock', 50, true) RETURNING id INTO v_p2;
  INSERT INTO products (sku, slug, name, retail_price, offer_price, stock_status, stock_quantity, is_active) VALUES
    ('B66-3-' || v_tag, 'b66-3-' || v_tag, 'B66 Three ' || v_tag, 900, NULL, 'in_stock', 50, true) RETURNING id INTO v_p3;
  INSERT INTO products (sku, slug, name, retail_price, offer_price, stock_status, stock_quantity, is_active) VALUES
    ('B66-4-' || v_tag, 'b66-4-' || v_tag, 'B66 Four ' || v_tag, 1800, NULL, 'in_stock', 50, true) RETURNING id INTO v_p4;
  INSERT INTO product_variants (product_id, region, size, retail_price, offer_price, in_stock, stock_quantity, sort_order)
    VALUES (v_p4, 'AU', '100ml', 2000, NULL, true, 50, 0) RETURNING id INTO v_p4a;
  INSERT INTO product_variants (product_id, region, size, retail_price, offer_price, in_stock, stock_quantity, sort_order)
    VALUES (v_p4, 'AU', '200ml', 2500, NULL, true, 50, 1) RETURNING id INTO v_p4b;
  INSERT INTO products (sku, slug, name, retail_price, offer_price, stock_status, stock_quantity, is_active) VALUES
    ('B66-5-' || v_tag, 'b66-5-' || v_tag, 'B66 Five ' || v_tag, 500, NULL, 'in_stock', 50, true) RETURNING id INTO v_p5;
  INSERT INTO products (sku, slug, name, retail_price, offer_price, stock_status, stock_quantity, is_active) VALUES
    ('B66-6-' || v_tag, 'b66-6-' || v_tag, 'B66 Six ' || v_tag, 1000, NULL, 'in_stock', 50, true) RETURNING id INTO v_p6;
  INSERT INTO products (sku, slug, name, retail_price, offer_price, stock_status, stock_quantity, is_active) VALUES
    ('B66-7-' || v_tag, 'b66-7-' || v_tag, 'B66 Seven ' || v_tag, 1000, NULL, 'in_stock', 50, true) RETURNING id INTO v_p7;
  INSERT INTO products (sku, slug, name, retail_price, offer_price, stock_status, stock_quantity, is_active) VALUES
    ('B66-8-' || v_tag, 'b66-8-' || v_tag, 'B66 Eight ' || v_tag, 1000, NULL, 'in_stock', 50, true) RETURNING id INTO v_p8;

  v_code := 'B66' || v_tag;
  INSERT INTO promo_codes (code, discount_amount, discount_type, max_uses, times_used, active)
  VALUES (v_code, 10, 'percent', 10, 0, true);

  -- ------------------------------------------------------------ 1. saving
  v_live := admin_save_campaign(jsonb_build_object(
    'name', 'B66 Live ' || v_tag, 'style', 'glitter', 'discount_mode', 'percent', 'percent', 20,
    'starts_at', now() - interval '1 hour', 'ends_at', now() + interval '2 days', 'is_enabled', true,
    'items', jsonb_build_array(
      jsonb_build_object('product_id', v_p2, 'sort_order', 0),
      jsonb_build_object('product_id', v_p1, 'sort_order', 1))));
  v_own := admin_save_campaign(jsonb_build_object(
    'name', 'B66 Own ' || v_tag, 'style', 'plain', 'discount_mode', 'own_price',
    'starts_at', now() - interval '1 hour', 'ends_at', now() + interval '3 days', 'is_enabled', true,
    'items', jsonb_build_array(
      jsonb_build_object('product_id', v_p3, 'campaign_price', 650, 'sort_order', 0),
      jsonb_build_object('product_id', v_p4, 'variant_id', v_p4a, 'campaign_price', 1500, 'sort_order', 1))));
  v_sched := admin_save_campaign(jsonb_build_object(
    'name', 'B66 Later ' || v_tag, 'discount_mode', 'percent', 'percent', 30,
    'starts_at', now() + interval '1 day', 'ends_at', now() + interval '2 days', 'is_enabled', true,
    'items', jsonb_build_array(jsonb_build_object('product_id', v_p6, 'sort_order', 0))));
  v_ended := admin_save_campaign(jsonb_build_object(
    'name', 'B66 Past ' || v_tag, 'discount_mode', 'percent', 'percent', 30,
    'starts_at', now() - interval '3 days', 'ends_at', now() - interval '1 day', 'is_enabled', true,
    'items', jsonb_build_array(jsonb_build_object('product_id', v_p7, 'sort_order', 0))));
  v_off := admin_save_campaign(jsonb_build_object(
    'name', 'B66 Off ' || v_tag, 'discount_mode', 'percent', 'percent', 30,
    'starts_at', now() - interval '1 hour', 'ends_at', now() + interval '1 day', 'is_enabled', false,
    'items', jsonb_build_array(jsonb_build_object('product_id', v_p8, 'sort_order', 0))));

  SELECT slug INTO v_slug1 FROM campaigns WHERE id = v_live;
  PERFORM pg_temp.ck('1 Slug made from the name', v_slug1 = 'b66-live-' || v_tag, v_slug1);
  v_spare := admin_save_campaign(jsonb_build_object(
    'name', 'B66 Live ' || v_tag, 'discount_mode', 'percent', 'percent', 5,
    'starts_at', now() + interval '10 days', 'ends_at', now() + interval '11 days', 'is_enabled', true,
    'items', jsonb_build_array(jsonb_build_object('product_id', v_p5, 'sort_order', 0))));
  SELECT slug INTO v_slug2 FROM campaigns WHERE id = v_spare;
  PERFORM pg_temp.ck('1 Same name again gets -2', v_slug2 = v_slug1 || '-2', v_slug2);
  PERFORM admin_save_campaign(jsonb_build_object(
    'id', v_spare, 'name', 'B66 Renamed ' || v_tag, 'discount_mode', 'percent', 'percent', 5,
    'starts_at', now() + interval '10 days', 'ends_at', now() + interval '11 days', 'is_enabled', true,
    'items', jsonb_build_array(jsonb_build_object('product_id', v_p5, 'sort_order', 0))));
  PERFORM pg_temp.ck('1 Editing keeps the old slug and replaces the name',
    (SELECT slug = v_slug2 AND name = 'B66 Renamed ' || v_tag FROM campaigns WHERE id = v_spare));

  -- Overlap refused (product One is already in Live at the same time).
  BEGIN
    PERFORM admin_save_campaign(jsonb_build_object(
      'name', 'B66 Clash ' || v_tag, 'discount_mode', 'percent', 'percent', 10,
      'starts_at', now(), 'ends_at', now() + interval '1 day', 'is_enabled', true,
      'items', jsonb_build_array(jsonb_build_object('product_id', v_p1, 'sort_order', 0))));
    v_err := 'saved';
  EXCEPTION WHEN others THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('1 Overlap refused with the product and the other campaign',
    v_err = format('B66 One %s is already in B66 Live %s at the same time.', v_tag, v_tag), v_err);
  -- Switched off, the same campaign may be saved; switching it on is refused.
  v_n := (SELECT count(*) FROM campaigns);
  v_spare := admin_save_campaign(jsonb_build_object(
    'name', 'B66 Clash ' || v_tag, 'discount_mode', 'percent', 'percent', 10,
    'starts_at', now(), 'ends_at', now() + interval '1 day', 'is_enabled', false,
    'items', jsonb_build_array(jsonb_build_object('product_id', v_p1, 'sort_order', 0))));
  BEGIN
    PERFORM admin_set_campaign_enabled(v_spare, true);
    v_err := 'switched on';
  EXCEPTION WHEN others THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('1 Switching on a clashing campaign is refused', v_err LIKE '%is already in B66 Live%', v_err);
  PERFORM pg_temp.ck('1 ... and it stays off', NOT (SELECT is_enabled FROM campaigns WHERE id = v_spare));
  PERFORM admin_delete_campaign(v_spare);
  PERFORM pg_temp.ck('1 A campaign with no orders can be deleted', NOT EXISTS (SELECT 1 FROM campaigns WHERE id = v_spare));

  BEGIN
    PERFORM admin_save_campaign(jsonb_build_object(
      'name', 'B66 Dear ' || v_tag, 'discount_mode', 'own_price',
      'starts_at', now() + interval '20 days', 'ends_at', now() + interval '21 days', 'is_enabled', true,
      'items', jsonb_build_array(jsonb_build_object('product_id', v_p5, 'campaign_price', 500, 'sort_order', 0))));
    v_err := 'saved';
  EXCEPTION WHEN others THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('1 Own price equal to retail refused', v_err = format('B66 Five %s: the sale price must be below ৳500.', v_tag), v_err);
  BEGIN
    PERFORM admin_save_campaign(jsonb_build_object(
      'name', 'B66 Dear ' || v_tag, 'discount_mode', 'own_price',
      'starts_at', now() + interval '20 days', 'ends_at', now() + interval '21 days', 'is_enabled', true,
      'items', jsonb_build_array(jsonb_build_object('product_id', v_p4, 'variant_id', v_p4b, 'campaign_price', 2600, 'sort_order', 0))));
    v_err := 'saved';
  EXCEPTION WHEN others THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('1 Own price above a size''s retail refused (size retail, with comma)',
    v_err = format('B66 Four %s: the sale price must be below ৳2,500.', v_tag), v_err);
  BEGIN
    PERFORM admin_save_campaign(jsonb_build_object(
      'name', 'B66 Empty ' || v_tag, 'discount_mode', 'percent', 'percent', 10,
      'starts_at', now() + interval '20 days', 'ends_at', now() + interval '21 days', 'items', '[]'::jsonb));
    v_err := 'saved';
  EXCEPTION WHEN others THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('1 At least 1 product', v_err = 'Add at least 1 product.', v_err);
  BEGIN
    PERFORM admin_save_campaign(jsonb_build_object(
      'name', 'B66 Size ' || v_tag, 'discount_mode', 'percent', 'percent', 10,
      'starts_at', now() + interval '20 days', 'ends_at', now() + interval '21 days',
      'items', jsonb_build_array(jsonb_build_object('product_id', v_p4, 'variant_id', v_p4a, 'sort_order', 0))));
    v_err := 'saved';
  EXCEPTION WHEN others THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('1 Same % takes the product, not one size', v_err LIKE '%covers every size%', v_err);
  BEGIN
    PERFORM admin_save_campaign(jsonb_build_object(
      'name', 'B66 Back ' || v_tag, 'discount_mode', 'percent', 'percent', 10,
      'starts_at', now() + interval '20 days', 'ends_at', now() + interval '19 days',
      'items', jsonb_build_array(jsonb_build_object('product_id', v_p5, 'sort_order', 0))));
    v_err := 'saved';
  EXCEPTION WHEN others THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('1 End before start refused', v_err = 'The end must be after the start.', v_err);

  -- Only the Super Admin.
  PERFORM set_config('request.jwt.claims', c_cust, true);
  BEGIN
    PERFORM admin_campaigns();
    v_err := 'read';
  EXCEPTION WHEN others THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('1 A customer cannot open the admin list', v_err LIKE 'Only the Super Admin%', v_err);
  BEGIN
    PERFORM admin_set_campaign_enabled(v_live, false);
    v_err := 'changed';
  EXCEPTION WHEN others THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('1 A customer cannot switch a campaign off', v_err LIKE 'Only the Super Admin%', v_err);

  -- ------------------------------------------------------------ 2. live / prices
  v_j := live_campaigns();
  PERFORM pg_temp.ck('2 Live list has Live and Own, not Later / Past / Off',
    EXISTS (SELECT 1 FROM jsonb_array_elements(v_j) e WHERE (e ->> 'id')::uuid = v_live)
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_j) e WHERE (e ->> 'id')::uuid = v_own)
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_j) e WHERE (e ->> 'id')::uuid IN (v_sched, v_ended, v_off)));
  PERFORM pg_temp.ck('2 Live list is ending soonest first, items in Naeem''s order',
    (SELECT array_agg((e ->> 'id')::uuid ORDER BY o) FROM jsonb_array_elements(v_j) WITH ORDINALITY x(e, o)
       WHERE (e ->> 'id')::uuid IN (v_live, v_own)) = ARRAY[v_live, v_own]
    AND (SELECT (e -> 'items' -> 0 ->> 'product_id')::uuid FROM jsonb_array_elements(v_j) e WHERE (e ->> 'id')::uuid = v_live) = v_p2);
  PERFORM pg_temp.ck('2 Percent, no offer: 20% off ৳1,000 = ৳800', pg_temp.sale(v_p1, NULL) = 800, pg_temp.sale(v_p1, NULL)::text);
  PERFORM pg_temp.ck('2 Percent, lower offer wins: ৳700 (not ৳800)', pg_temp.sale(v_p2, NULL) = 700, pg_temp.sale(v_p2, NULL)::text);
  PERFORM pg_temp.ck('2 Own price: ৳650', pg_temp.sale(v_p3, NULL) = 650, pg_temp.sale(v_p3, NULL)::text);
  PERFORM pg_temp.ck('2 Own price size A: ৳1,500', pg_temp.sale(v_p4, v_p4a) = 1500, pg_temp.sale(v_p4, v_p4a)::text);
  PERFORM pg_temp.ck('2 Own price: size B and the product''s own size are not on sale',
    pg_temp.sale(v_p4, v_p4b) IS NULL AND pg_temp.sale(v_p4, NULL) IS NULL);
  PERFORM pg_temp.ck('2 Scheduled, ended and switched off change nothing',
    pg_temp.sale(v_p6, NULL) IS NULL AND pg_temp.sale(v_p7, NULL) IS NULL AND pg_temp.sale(v_p8, NULL) IS NULL);
  PERFORM pg_temp.ck('2 Percent rounds to whole taka (20% off ৳999 = ৳799; off ৳1,003.13 = ৳803)',
    (SELECT price FROM campaign_sale_price(v_p1, NULL, 999, NULL)) = 799
    AND (SELECT price FROM campaign_sale_price(v_p1, NULL, 1003.13, NULL)) = 803);

  -- ------------------------------------------------------------ 3. orders
  SELECT times_used INTO v_used0 FROM promo_codes WHERE code = v_code;
  PERFORM set_config('request.jwt.claims', c_cust, true);
  -- Two sale items (One ×2 at ৳800) + one normal (Five ৳500), 10% code.
  SELECT order_id INTO v_o1 FROM place_order(
    jsonb_build_array(jsonb_build_object('product_id', v_p1, 'quantity', 2), jsonb_build_object('product_id', v_p5, 'quantity', 1)),
    'B66 Customer', '01799966001', 'Dhaka', 'Dhaka', 'Gulshan', 'B66 road', 'inside_dhaka', 'cod', NULL, NULL, v_code);
  PERFORM set_config('request.jwt.claims', c_admin, true);
  SELECT * INTO v_row FROM orders WHERE id = v_o1;
  PERFORM pg_temp.ck('3 Sale price charged: subtotal ৳1,600 + ৳500 = ৳2,100', v_row.subtotal = 2100, v_row.subtotal::text);
  PERFORM pg_temp.ck('3 Promo only on the normal item: 10% of ৳500 = ৳50', v_row.discount = 50 AND v_row.promo_code = v_code,
    format('%s %s', v_row.discount, v_row.promo_code));
  PERFORM pg_temp.ck('3 Total = 2,100 + delivery − 50', v_row.total = 2050 + v_fee, v_row.total::text);
  PERFORM pg_temp.ck('3 The code was counted once', (SELECT times_used FROM promo_codes WHERE code = v_code) = v_used0 + 1);
  SELECT * INTO v_row FROM order_items WHERE order_id = v_o1 AND product_id = v_p1;
  PERFORM pg_temp.ck('3 Sale line keeps campaign and normal price (৳800, normal ৳1,000)',
    v_row.unit_price = 800 AND v_row.campaign_id = v_live AND v_row.campaign_normal_price = 1000 AND v_row.line_total = 1600,
    format('%s %s %s', v_row.unit_price, v_row.campaign_id, v_row.campaign_normal_price));
  SELECT * INTO v_row FROM order_items WHERE order_id = v_o1 AND product_id = v_p5;
  PERFORM pg_temp.ck('3 Normal line has no campaign', v_row.campaign_id IS NULL AND v_row.campaign_normal_price IS NULL AND v_row.unit_price = 500);

  -- Only sale items: the code is ignored and not counted.
  PERFORM set_config('request.jwt.claims', c_cust, true);
  SELECT order_id INTO v_o2 FROM place_order(
    jsonb_build_array(jsonb_build_object('product_id', v_p3, 'quantity', 1),
                      jsonb_build_object('product_id', v_p4, 'variant_id', v_p4a, 'quantity', 1)),
    'B66 Customer', '01799966001', 'Dhaka', 'Dhaka', 'Gulshan', 'B66 road', 'inside_dhaka', 'cod', NULL, NULL, v_code);
  PERFORM set_config('request.jwt.claims', c_admin, true);
  SELECT * INTO v_row FROM orders WHERE id = v_o2;
  PERFORM pg_temp.ck('3 Own price and size: ৳650 + ৳1,500 = ৳2,150', v_row.subtotal = 2150, v_row.subtotal::text);
  PERFORM pg_temp.ck('3 All sale items: no promo discount, no code saved', v_row.discount = 0 AND v_row.promo_code IS NULL,
    format('%s %s', v_row.discount, v_row.promo_code));
  PERFORM pg_temp.ck('3 ... and the code is not counted', (SELECT times_used FROM promo_codes WHERE code = v_code) = v_used0 + 1);
  PERFORM pg_temp.ck('3 Size line: campaign Own, normal ৳2,000',
    (SELECT campaign_id = v_own AND campaign_normal_price = 2000 AND unit_price = 1500 FROM order_items WHERE order_id = v_o2 AND variant_id = v_p4a));

  -- Advance discount (10% here) only on the normal items.
  PERFORM set_config('request.jwt.claims', c_cust, true);
  SELECT order_id INTO v_o3 FROM place_order(
    jsonb_build_array(jsonb_build_object('product_id', v_p2, 'quantity', 1), jsonb_build_object('product_id', v_p5, 'quantity', 2)),
    'B66 Customer', '01799966001', 'Dhaka', 'Dhaka', 'Gulshan', 'B66 road', 'inside_dhaka', 'bkash', 'B66T' || v_tag, '01899966001');
  PERFORM set_config('request.jwt.claims', c_admin, true);
  SELECT * INTO v_row FROM orders WHERE id = v_o3;
  PERFORM pg_temp.ck('3 Advance: subtotal ৳700 + ৳1,000; 10% of the ৳1,000 normal part = ৳100',
    v_row.subtotal = 1700 AND v_row.advance_discount = 100 AND v_row.total = 1600 + v_fee,
    format('sub %s adv %s total %s', v_row.subtotal, v_row.advance_discount, v_row.total));
  PERFORM pg_temp.ck('3 Lower offer line: ৳700 with normal ৳700 (no extra off, still a sale item)',
    (SELECT unit_price = 700 AND campaign_normal_price = 700 AND campaign_id = v_live FROM order_items WHERE order_id = v_o3 AND product_id = v_p2));

  -- A product not in any live campaign (scheduled / ended) costs its normal price.
  PERFORM set_config('request.jwt.claims', c_cust, true);
  SELECT order_id INTO v_o4 FROM place_order(
    jsonb_build_array(jsonb_build_object('product_id', v_p6, 'quantity', 1), jsonb_build_object('product_id', v_p7, 'quantity', 1)),
    'B66 Customer', '01799966001', 'Dhaka', 'Dhaka', 'Gulshan', 'B66 road', 'inside_dhaka', 'cod');
  PERFORM set_config('request.jwt.claims', c_admin, true);
  PERFORM pg_temp.ck('3 Scheduled and ended: normal ৳1,000 each, no campaign',
    (SELECT subtotal FROM orders WHERE id = v_o4) = 2000
    AND NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = v_o4 AND campaign_id IS NOT NULL));

  -- ------------------------------------------------------------ 4. numbers
  v_j := (SELECT e FROM jsonb_array_elements(admin_campaigns()) e WHERE (e ->> 'id')::uuid = v_live);
  PERFORM pg_temp.ck('4 Live: 2 orders, sold ৳1,600 + ৳700 = ৳2,300, given off ৳400',
    (v_j ->> 'orders')::integer = 2 AND (v_j ->> 'sold')::numeric = 2300 AND (v_j ->> 'given_off')::numeric = 400, v_j::text);
  v_j := (SELECT e FROM jsonb_array_elements(admin_campaigns()) e WHERE (e ->> 'id')::uuid = v_own);
  PERFORM pg_temp.ck('4 Own: 1 order, sold ৳2,150, given off ৳250 + ৳500 = ৳750',
    (v_j ->> 'orders')::integer = 1 AND (v_j ->> 'sold')::numeric = 2150 AND (v_j ->> 'given_off')::numeric = 750, v_j::text);
  PERFORM cancel_order(v_o2, 'B66 test');
  v_j := (SELECT e FROM jsonb_array_elements(admin_campaigns()) e WHERE (e ->> 'id')::uuid = v_own);
  PERFORM pg_temp.ck('4 A cancelled order no longer counts', (v_j ->> 'orders')::integer = 0 AND (v_j ->> 'sold')::numeric = 0, v_j::text);

  BEGIN
    PERFORM admin_delete_campaign(v_live);
    v_err := 'deleted';
  EXCEPTION WHEN others THEN v_err := SQLERRM;
  END;
  PERFORM pg_temp.ck('4 Delete refused when orders use it', v_err = 'This campaign has orders. Switch it off instead.', v_err);
  PERFORM admin_set_campaign_enabled(v_live, false);
  PERFORM pg_temp.ck('4 Switched off: prices back at once', pg_temp.sale(v_p1, NULL) IS NULL);
  PERFORM pg_temp.ck('4 Existing orders never change', (SELECT unit_price FROM order_items WHERE order_id = v_o1 AND product_id = v_p1) = 800);

  PERFORM pg_temp.ck('9 Balance check difference at the end is still ৳0.00 (All figures match)', abs(pg_temp.diff() - d0) < 0.01,
    pg_temp.diff()::text);
END
$test$;
SELECT 'TEST_RESULT' AS tag, json_agg(json_build_object('name', name, 'ok', ok, 'detail', detail) ORDER BY n)::text AS results FROM t_res;
ROLLBACK;
