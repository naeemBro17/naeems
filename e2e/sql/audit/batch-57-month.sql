-- Batch 57 audit: a made-up business month, worked out by hand, compared
-- with what every money screen's function says.
--
-- SAFE ON THE LIVE DATABASE: everything runs inside ONE transaction that
-- ends with ROLLBACK, so nothing below is ever kept. Only MADE-UP rows are
-- added (products "AUDIT57 …", made-up phones 017999570xx, a made-up bank
-- account, supplier, investor and promo code); no real row is changed.
-- (Order alerts: the Telegram trigger only queues a web request, and queued
-- requests are sent only after a COMMIT — a rolled-back order sends nothing.)
--
-- How the comparison works: the real shop already has data, so the script
-- reads every number BEFORE the made-up month and AFTER it, and compares the
-- CHANGE with the hand-worked number. Everything happens "today" (the
-- functions date sales by the moment they are marked delivered).
--
-- Run:  supabase db query --linked -f e2e/sql/audit/batch-57-month.sql
-- Result: one row, a JSON list of { step, check, hand, site, ok }.
--
-- THE MONTH (all amounts ৳; checkout settings at the time of the audit:
-- inside-Dhaka delivery ৳70, advance-payment discount ৳50 fixed)
--   Opening: made-up bank account ৳50,000; customer Rahim's previous
--            balance ৳2,000.
--   Lot L1 (supplier): Cream A 10 pcs × ৳500 = ৳5,000; Toner B 2 packs ×
--            ৳1,600 (pack = 200 ml) = ৳3,200; other lot cost ৳410.
--            Shared by value: A ৳250 → ৳525 a pc; B ৳160 → ৳8.40 a ml.
--            Paid ৳5,000 from the bank, ৳3,610 still owed.
--   O1  shop checkout, promo AUDIT57 10 %: 2 × A = 2,000 − 200 + 70 = 1,870 COD.
--   O2  shop checkout, bKash in advance: 1 × A = 1,000 − 50 + 70 = 1,020 paid.
--   O3  hand delivery, 1 × A = 1,000, ৳500 paid in cash, ৳500 due.
--   O4  Rahim, 1 × A = 1,000 + 80 delivery, nothing paid (fully due), not booked.
--   O5  1 × A + 80, shipped, RETURNED; Steadfast charged 60 + 30 return.
--   O6  1 × A + 80, booked on Steadfast, CANCELLED before pickup; Steadfast charged 60.
--   O7  Serum C (no stock, buying price ৳600) 1 × 1,500 + 80, paid bKash;
--       sold without stock; later lot L2: C 2 × ৳700 (unpaid) → real cost 700.
--   O8  loose: 50 ml of Toner B × ৳12 = 600, hand delivery, cash.
--   Steadfast payout: O1 COD 1,870 − 60 − 19 COD fee = 1,791; O2 −60;
--       O5 −90; O6 −60 → ৳1,581 paid, placed into the bank.
--   Expense ৳1,000; write-off 1 A (৳525); investor capital in ৳10,000 and
--   profit share ৳300; owner withdrawal ৳700; Rahim pays ৳1,500 lump sum.
--
-- HAND-WORKED RESULT
--   Sales (items − discounts)    1,800 + 950 + 1,000 + 1,000 + 1,500 + 600 = 6,850
--   Cost of goods                1,050 + 525 + 525 + 525 + 700 + 420       = 3,745
--   Gross profit                                                            3,105
--   Delivery charged             70 + 70 + 0 + 80 + 80 + 0                   =   300
--   Courier                      79 + 60 + 90 + 60                           =   289
--   Expenses 1,000 · Write-offs 525
--   Net profit                   3,105 + 300 − 289 − 1,000 − 525             = 1,591
--   Investor share 300 → Your profit 1,291 · withdrawal 700 → Left in business 591
--   Bank 50,000 − 5,000 + 1,581 − 1,000 + 10,000 − 300 − 700 + 1,500       = 56,081
--   Cash +1,100 (O3 500 + O8 600) · bKash +2,600 (O2 1,020 + O7 1,580) · With Steadfast 0
--   To receive 1,580 (O3 500 + O4 1,080) · previous balances 500 (2,000 − 1,500)
--   Stock: A 4 × 525 + B 350 ml × 8.40 + C 1 × 700 = 2,100 + 2,940 + 700  = 5,740
--   To give: suppliers 3,610 + 1,400 = 5,010; investor capital 10,000     = 15,010
--   Net worth change = 59,781 + 0 + 1,580 + 500 + 5,740 − 15,010           = 52,591
--     = opening 52,000 + net profit 1,591 − share 300 − withdrawal 700   (balances)
BEGIN;

CREATE TEMP TABLE t_m (n serial, step text, chk text, hand numeric, site numeric, ok boolean, detail text) ON COMMIT DROP;

DO $month$
DECLARE
  v_admin  uuid := (SELECT id FROM profiles WHERE role = 'admin' ORDER BY created_at LIMIT 1);
  c_admin  text;
  -- The shop checkout needs a signed-in customer: the e2e test customer login.
  v_cust   uuid := (SELECT u.id FROM auth.users u JOIN profiles p ON p.id = u.id
                    WHERE p.role = 'customer' AND lower(u.email) LIKE '%@naeems.test' ORDER BY u.created_at LIMIT 1);
  v_start  date := money_start_date();
  v_today  date := inventory_dhaka_today();
  v_tag    text := to_char(clock_timestamp(), 'HH24MISS');
  v_bank   uuid;
  v_cash   uuid := money_account_for_method('cash');
  v_bkash  uuid := money_account_for_method('bkash');
  v_sfacc  uuid := money_steadfast_account();
  v_cat    uuid := (SELECT id FROM money_categories ORDER BY sort_order LIMIT 1);
  v_inv    uuid;
  v_sup    uuid;
  v_pa     uuid;
  v_pb     uuid;
  v_pc     uuid;
  v_pd     uuid;
  v_pe     uuid;
  v_l1     uuid;
  v_l2     uuid;
  v_l3     uuid;
  v_o      uuid[] := ARRAY[]::uuid[];
  v_id     uuid;
  v_payout uuid;
  v_total  numeric;
  -- before / after snapshots
  p0  jsonb; p1 jsonb;   -- money_profit_parts(today, today)
  s0  jsonb; s1 jsonb;   -- inventory_sales_profit(today, today) totals
  r0  jsonb; r1 jsonb;   -- report_profit_loss(today, today) parts
  d0  jsonb; d1 jsonb;   -- money_dashboard(today, today) summary profit
  x0  jsonb; x1 jsonb;   -- money_position()
  c0  numeric; k0 numeric; sf0 numeric;
  e0  numeric;           -- expected courier fees of the REAL delivered orders
  v_j jsonb;
  v_n numeric;
  ph_rahim constant text := '01799957001';
  ph_other constant text := '01799957002';
  -- Batch 58
  v_pf  uuid;
  v_pg  uuid;
  v_ol  uuid;
  v_l4  uuid;
  v_mod uuid;
  v_mv  uuid;
  v_b   boolean;
  v_txt text;
BEGIN
  IF v_cust IS NULL THEN
    RAISE EXCEPTION 'The e2e test customer login (@naeems.test) was not found.';
  END IF;
  IF v_start IS NULL THEN
    RAISE EXCEPTION 'The money start date is not confirmed; this audit needs it.';
  END IF;
  c_admin := json_build_object('sub', v_admin, 'role', 'authenticated', 'aal', 'aal2')::text;
  PERFORM set_config('request.jwt.claims', c_admin, true);

  EXECUTE $f$CREATE FUNCTION pg_temp.ck(p_step text, p_chk text, p_hand numeric, p_site numeric, p_detail text DEFAULT '')
    RETURNS void LANGUAGE sql AS
    'INSERT INTO t_m (step, chk, hand, site, ok, detail) VALUES (p_step, p_chk, p_hand, p_site,
       p_site IS NOT NULL AND abs(p_hand - p_site) < 0.01, p_detail)'$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.bal(p_account uuid) RETURNS numeric LANGUAGE sql AS
    'SELECT COALESCE(sum(amount), 0) FROM money_ledger WHERE account_id = p_account'$f$;
  EXECUTE $f$CREATE FUNCTION pg_temp.num(p jsonb, k text) RETURNS numeric LANGUAGE sql AS
    'SELECT COALESCE((p ->> k)::numeric, 0)'$f$;

  -- ------------------------------------------------------------ BEFORE
  p0 := money_profit_parts(v_today, v_today);
  s0 := inventory_sales_profit(v_today, v_today) -> 'totals';
  r0 := report_profit_loss(v_today, v_today) -> 'parts';
  d0 := money_dashboard(v_today, v_today, NULL, NULL) -> 'summary' -> 'profit';
  x0 := money_position();
  c0 := pg_temp.bal(v_cash); k0 := pg_temp.bal(v_bkash); sf0 := pg_temp.bal(v_sfacc);
  SELECT COALESCE(sum(amount), 0) INTO e0
  FROM order_courier_costs_for((SELECT array_agg(id) FROM orders WHERE status = 'delivered')) WHERE kind = 'expected';

  -- ------------------------------------------------------------ SETUP
  v_bank := money_save_account(NULL, 'AUDIT57 Bank ' || v_tag, 'bank');
  -- Opening balances (the books are already confirmed, so the made-up
  -- opening is written directly, dated on the start date like the real one).
  INSERT INTO money_movements (entry_date, account_id, amount, type, note, created_by, created_by_username)
  VALUES (v_start, v_bank, 50000, 'opening_balance', 'AUDIT57 opening', v_admin, 'audit57');
  INSERT INTO customer_opening_dues (phone_key, full_name, phone, amount, choice, kaarbar_amount, site_due_then, created_by_username)
  VALUES (ph_rahim, 'AUDIT57 Rahim', ph_rahim, 2000, 'kaarbar', 2000, 0, 'audit57');
  PERFORM money_save_party(NULL, 'AUDIT57 Investor ' || v_tag, NULL, 'investor');
  SELECT id INTO v_inv FROM parties_payable WHERE name = 'AUDIT57 Investor ' || v_tag;
  PERFORM inventory_save_supplier('AUDIT57 Supplier ' || v_tag);
  SELECT id INTO v_sup FROM suppliers WHERE name = 'AUDIT57 Supplier ' || v_tag;

  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('AUDIT57-A-' || v_tag, 'audit57-a-' || v_tag, 'AUDIT57 Cream A', 1000, 'in_stock', 0, true) RETURNING id INTO v_pa;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('AUDIT57-B-' || v_tag, 'audit57-b-' || v_tag, 'AUDIT57 Toner B 200 ml', 2000, 'in_stock', 0, true) RETURNING id INTO v_pb;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('AUDIT57-C-' || v_tag, 'audit57-c-' || v_tag, 'AUDIT57 Serum C', 1500, 'in_stock', 0, true) RETURNING id INTO v_pc;
  PERFORM inventory_set_pack(v_pb, NULL, 'ml', 200);
  PERFORM inventory_set_buying_prices(jsonb_build_array(jsonb_build_object('product_id', v_pc, 'variant_id', NULL, 'price', '600')));
  INSERT INTO promo_codes (code, discount_amount, discount_type, max_uses, active)
  VALUES ('AUDIT57' || v_tag, 10, 'percent', 5, true);

  -- Lot L1 with another cost, part paid.
  v_l1 := inventory_save_lot(jsonb_build_object('source_type', 'local', 'country', 'Bangladesh', 'lot_date', v_today::text,
    'costs_pending', false, 'notes', 'AUDIT57 L1', 'supplier_id', v_sup,
    'items', jsonb_build_array(
      jsonb_build_object('product_id', v_pa, 'qty', 10, 'unit_price_foreign', '500', 'expiry_date', '2028-06-01'),
      jsonb_build_object('product_id', v_pb, 'qty', 2, 'entry_unit', 'pack', 'unit_price_foreign', '1600', 'expiry_date', '2028-06-01')),
    'costs', jsonb_build_array(jsonb_build_object('cost_type', 'other', 'amount_bdt', '410', 'note', 'AUDIT57 carriage'))));
  PERFORM money_set_lot_payments(v_l1, jsonb_build_array(jsonb_build_object('account_id', v_bank, 'amount', 5000, 'date', v_today)));
  PERFORM pg_temp.ck('Lot', 'L1 landed cost (৳5,000 + ৳3,200 + ৳410)', 8610, money_lot_landed(v_l1));
  PERFORM pg_temp.ck('Lot', 'Cream A landed per pc (500 + 250 share of the other cost)', 525,
    (SELECT landed_unit_cost_bdt FROM lot_items WHERE lot_id = v_l1 AND product_id = v_pa));
  PERFORM pg_temp.ck('Lot', 'Toner B landed per ml ((3,200 + 160) ÷ 400 ml)', 8.40,
    round((SELECT landed_unit_cost_bdt FROM lot_items WHERE lot_id = v_l1 AND product_id = v_pb), 4));
  PERFORM pg_temp.ck('Lot', 'L1 still owed to the supplier', 3610, money_lot_owed(v_l1));

  -- ------------------------------------------------------------ ORDERS
  -- O1: shop checkout with the promo code (COD).
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_cust, 'role', 'authenticated')::text, true);
  SELECT order_id INTO v_id FROM place_order(
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_pa, 'quantity', 2)),
    p_full_name => 'AUDIT57 One', p_phone => ph_other, p_division => 'Dhaka', p_district => 'Dhaka',
    p_thana => 'Gulshan', p_address_line => 'Audit road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'cod',
    p_promo_code => 'AUDIT57' || v_tag);
  v_o := v_o || v_id;
  -- O2: shop checkout paying by bKash in advance (advance discount).
  SELECT order_id INTO v_id FROM place_order(
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_pa, 'quantity', 1)),
    p_full_name => 'AUDIT57 Two', p_phone => '01799957003', p_division => 'Dhaka', p_district => 'Dhaka',
    p_thana => 'Gulshan', p_address_line => 'Audit road', p_delivery_zone => 'inside_dhaka', p_payment_method => 'bkash',
    p_bkash_trx_id => 'AUDIT57TRX' || v_tag, p_bkash_sender => '01799957003');
  v_o := v_o || v_id;
  PERFORM set_config('request.jwt.claims', c_admin, true);
  PERFORM pg_temp.ck('Orders', 'O1 total (2,000 − 10 % promo + 70)', 1870, (SELECT total FROM orders WHERE id = v_o[1]));
  PERFORM pg_temp.ck('Orders', 'O2 total (1,000 − ৳50 advance discount + 70)', 1020, (SELECT total FROM orders WHERE id = v_o[2]));

  -- O3 .. O8 entered by the admin.
  SELECT order_id INTO v_id FROM admin_create_order_v2(p_source => 'phone',
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_pa, 'quantity', 1)),
    p_full_name => 'AUDIT57 Three', p_phone => '01799957004', p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Audit road', p_delivery_zone => 'hand_delivered', p_delivery_fee => 0);
  v_o := v_o || v_id;                                                   -- O3
  SELECT order_id INTO v_id FROM admin_create_order_v2(p_source => 'phone',
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_pa, 'quantity', 1)),
    p_full_name => 'AUDIT57 Rahim', p_phone => ph_rahim, p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Audit road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80);
  v_o := v_o || v_id;                                                   -- O4
  SELECT order_id INTO v_id FROM admin_create_order_v2(p_source => 'phone',
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_pa, 'quantity', 1)),
    p_full_name => 'AUDIT57 Five', p_phone => '01799957005', p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Audit road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80);
  v_o := v_o || v_id;                                                   -- O5
  SELECT order_id INTO v_id FROM admin_create_order_v2(p_source => 'phone',
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_pa, 'quantity', 1)),
    p_full_name => 'AUDIT57 Six', p_phone => '01799957006', p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Audit road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80);
  v_o := v_o || v_id;                                                   -- O6
  SELECT order_id INTO v_id FROM admin_create_order_v2(p_source => 'phone',
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_pc, 'quantity', 1)),
    p_full_name => 'AUDIT57 Seven', p_phone => '01799957007', p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Audit road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80, p_allow_negative_stock => true);
  v_o := v_o || v_id;                                                   -- O7
  SELECT order_id INTO v_id FROM admin_create_order_v2(p_source => 'phone',
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_pb, 'quantity', 50, 'sold_price', 12, 'sold_unit', 'ml')),
    p_full_name => 'AUDIT57 Eight', p_phone => '01799957008', p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Audit road', p_delivery_zone => 'hand_delivered', p_delivery_fee => 0);
  v_o := v_o || v_id;                                                   -- O8
  PERFORM pg_temp.ck('Orders', 'O8 loose sale total (50 ml × ৳12)', 600, (SELECT total FROM orders WHERE id = v_o[8]));

  -- Payments recorded by hand (the shop never auto-adds them here).
  IF order_payment_net(v_o[2]) < 1020 THEN
    PERFORM admin_add_order_payment(v_o[2], 1020 - order_payment_net(v_o[2]), 'bkash', 'AUDIT57TRX' || v_tag, now(), 'advance');
  END IF;
  PERFORM admin_add_order_payment(v_o[3], 500, 'cash', NULL, now(), 'part paid');
  PERFORM admin_add_order_payment(v_o[7], 1580, 'bkash', 'AUDIT57TRX7' || v_tag, now(), 'paid');
  PERFORM admin_add_order_payment(v_o[8], 600, 'cash', NULL, now(), 'paid');

  -- Statuses.
  PERFORM admin_set_order_status(v_o[1], 'delivered', 'audit57');
  PERFORM admin_set_order_status(v_o[2], 'delivered', 'audit57');
  PERFORM admin_set_order_status(v_o[3], 'delivered', 'audit57');
  PERFORM admin_set_order_status(v_o[4], 'delivered', 'audit57');
  PERFORM admin_set_order_status(v_o[5], 'shipped', 'audit57');
  PERFORM admin_mark_order_returned(v_o[5], 'audit57 returned');
  PERFORM admin_set_order_status(v_o[6], 'confirmed', 'audit57');
  PERFORM admin_set_order_status(v_o[6], 'cancelled', 'audit57');
  PERFORM admin_set_order_status(v_o[7], 'delivered', 'audit57');
  PERFORM admin_set_order_status(v_o[8], 'delivered', 'audit57');
  -- Steadfast collected O1's COD.
  INSERT INTO order_payments (order_id, amount, method, paid_at, note, source, created_by_username)
  VALUES (v_o[1], 1870, 'cod_steadfast', now(), 'AUDIT57 COD', 'steadfast_cod', 'audit57');
  UPDATE orders SET steadfast_consignment_id = 'AUDIT57-' || v_tag || '-' || order_number
  WHERE id IN (v_o[1], v_o[2], v_o[5], v_o[6]);

  -- O7 before its real cost is known: provisional ৳600.
  v_j := order_profit(v_o[7]);
  PERFORM pg_temp.ck('Sold without stock', 'O7 cost before the lot arrives (provisional = buying price)', 600, pg_temp.num(v_j, 'cost'));
  PERFORM pg_temp.ck('Sold without stock', 'Money: "sold without stock" owed back to stock (৳600)', 600,
    pg_temp.num(money_position(), 'sold_without_stock') - pg_temp.num(x0, 'sold_without_stock'));
  -- Lot L2 brings Serum C at ৳700: fills O7.
  v_l2 := inventory_save_lot(jsonb_build_object('source_type', 'local', 'country', 'Bangladesh', 'lot_date', v_today::text,
    'costs_pending', false, 'notes', 'AUDIT57 L2', 'supplier_id', v_sup,
    'items', jsonb_build_array(jsonb_build_object('product_id', v_pc, 'qty', 2, 'unit_price_foreign', '700', 'expiry_date', '2028-06-01')),
    'costs', '[]'::jsonb));
  IF EXISTS (SELECT 1 FROM stock_shortfalls WHERE order_id = v_o[7] AND status = 'open') THEN
    PERFORM inventory_fill_shortfalls(v_l2);
  END IF;
  v_j := order_profit(v_o[7]);
  PERFORM pg_temp.ck('Sold without stock', 'O7 cost after the lot arrives (real ৳700)', 700, pg_temp.num(v_j, 'cost'));

  -- Steadfast payout: O1 delivered, O2 prepaid, O5 returned, O6 cancelled.
  INSERT INTO steadfast_payouts (steadfast_payment_id, paid_at, total_amount, parcel_count, items_synced)
  VALUES ('AUDIT57-' || v_tag, now(), 1581, 4, true) RETURNING id INTO v_payout;
  INSERT INTO steadfast_payout_items (payout_id, item_key, consignment_id, invoice, order_id, cod_collected, delivery_charge,
                                      cod_fee, other_deduction, net_paid, expected_cod, match_status, line_kind)
  SELECT v_payout, 'audit57:' || o.order_number, o.steadfast_consignment_id, o.order_number, o.id, x.cod, x.dc, x.fee, x.oth,
         x.cod - x.dc - x.fee - x.oth, x.cod, 'matched', 'order'
  FROM (VALUES (1, 1870, 60, 19, 0), (2, 0, 60, 0, 0), (5, 0, 60, 0, 30), (6, 0, 60, 0, 0)) x(i, cod, dc, fee, oth)
  JOIN orders o ON o.id = v_o[x.i];
  INSERT INTO order_courier_costs (order_id, cod_collected, delivery_charge, cod_fee, other_deduction, total_kept, net_received, payout_id, paid_at)
  SELECT v_o[x.i], x.cod, x.dc, x.fee, x.oth, x.dc + x.fee + x.oth, x.cod - x.dc - x.fee - x.oth, v_payout, now()
  FROM (VALUES (1, 1870, 60, 19, 0), (2, 0, 60, 0, 0), (5, 0, 60, 0, 30), (6, 0, 60, 0, 0)) x(i, cod, dc, fee, oth);
  PERFORM money_place_payout(v_payout, v_bank);

  -- ------------------------------------------------------------ MONEY ENTRIES
  PERFORM money_add_entry('expense', 1000, v_bank, v_today, 'AUDIT57 expense', v_cat);
  PERFORM money_write_off(v_pa, NULL, 1, 'expired', 'AUDIT57', NULL);
  PERFORM money_add_entry('investor_in', 10000, v_bank, v_today, 'AUDIT57', NULL, v_inv);
  PERFORM money_add_entry('investor_profit_share', 300, v_bank, v_today, 'AUDIT57', NULL, v_inv);
  PERFORM money_add_entry('owner_withdrawal', 700, v_bank, v_today, 'AUDIT57');
  PERFORM money_add_due_payment(ph_rahim, 1500, v_bank, v_today, 'AUDIT57 lump sum');

  -- ------------------------------------------------------------ AFTER
  p1 := money_profit_parts(v_today, v_today);
  s1 := inventory_sales_profit(v_today, v_today) -> 'totals';
  r1 := report_profit_loss(v_today, v_today) -> 'parts';
  d1 := money_dashboard(v_today, v_today, NULL, NULL) -> 'summary' -> 'profit';
  x1 := money_position();

  -- Per order (Profit card).
  FOR v_n IN 1..8 LOOP
    v_j := order_profit(v_o[v_n]);
    PERFORM pg_temp.ck('Order Profit card', 'O' || v_n || ' profit',
      (ARRAY[741, 435, 475, 555, -90, -60, 880, 180])[v_n], pg_temp.num(v_j, 'profit'),
      format('sale %s cost %s delivery %s courier %s (%s)', v_j ->> 'sale', v_j ->> 'cost', v_j ->> 'delivery', v_j ->> 'courier', v_j ->> 'courier_kind'));
  END LOOP;

  -- Profit: dashboard / Money (money_profit_parts), Reports, Sales profit.
  PERFORM pg_temp.ck('Money / dashboard', 'Sales', 6850, pg_temp.num(p1, 'sales') - pg_temp.num(p0, 'sales'));
  PERFORM pg_temp.ck('Money / dashboard', 'Cost of goods', 3745, pg_temp.num(p1, 'cost') - pg_temp.num(p0, 'cost'));
  PERFORM pg_temp.ck('Money / dashboard', 'Delivery charged', 300, pg_temp.num(p1, 'delivery') - pg_temp.num(p0, 'delivery'));
  PERFORM pg_temp.ck('Money / dashboard', 'Courier', 289, pg_temp.num(p1, 'courier') - pg_temp.num(p0, 'courier'));
  PERFORM pg_temp.ck('Money / dashboard', 'Expenses', 1000, pg_temp.num(p1, 'expenses') - pg_temp.num(p0, 'expenses'));
  PERFORM pg_temp.ck('Money / dashboard', 'Write-offs', 525, pg_temp.num(p1, 'write_offs') - pg_temp.num(p0, 'write_offs'));
  PERFORM pg_temp.ck('Money / dashboard', 'Net profit', 1591, pg_temp.num(p1, 'net_profit') - pg_temp.num(p0, 'net_profit'));
  PERFORM pg_temp.ck('Money / dashboard', 'Investor profit share', 300, pg_temp.num(p1, 'profit_share') - pg_temp.num(p0, 'profit_share'));
  PERFORM pg_temp.ck('Money / dashboard', 'Your profit', 1291, pg_temp.num(p1, 'your_profit') - pg_temp.num(p0, 'your_profit'));
  PERFORM pg_temp.ck('Money / dashboard', 'Owner withdrawals', 700, pg_temp.num(p1, 'withdrawals') - pg_temp.num(p0, 'withdrawals'));
  PERFORM pg_temp.ck('Money / dashboard', 'Left in the business', 591, pg_temp.num(p1, 'left_in_business') - pg_temp.num(p0, 'left_in_business'));
  PERFORM pg_temp.ck('Home dashboard (money_dashboard)', 'Your profit', 1291, pg_temp.num(d1, 'your_profit') - pg_temp.num(d0, 'your_profit'));
  PERFORM pg_temp.ck('Reports P&L', 'Net profit', 1591, pg_temp.num(r1, 'net_profit') - pg_temp.num(r0, 'net_profit'));
  PERFORM pg_temp.ck('Reports P&L', 'Gross profit (sales − cost of goods)', 3105, pg_temp.num(r1, 'gross_profit') - pg_temp.num(r0, 'gross_profit'));
  PERFORM pg_temp.ck('Inventory → Sales profit', 'Sales', 6850, pg_temp.num(s1, 'sales') - pg_temp.num(s0, 'sales'));
  PERFORM pg_temp.ck('Inventory → Sales profit', 'Profit before expenses (3,105 + 300 − 289)', 3116, pg_temp.num(s1, 'profit') - pg_temp.num(s0, 'profit'));

  -- Money position.
  PERFORM pg_temp.ck('Money position', 'Made-up bank account', 56081, pg_temp.bal(v_bank));
  PERFORM pg_temp.ck('Money position', 'Cash account change', 1100, pg_temp.bal(v_cash) - c0);
  PERFORM pg_temp.ck('Money position', 'bKash account change', 2600, pg_temp.bal(v_bkash) - k0);
  PERFORM pg_temp.ck('Money position', 'With Steadfast change', 0, pg_temp.bal(v_sfacc) - sf0);
  PERFORM pg_temp.ck('Money position', 'To receive', 1580, pg_temp.num(x1, 'to_receive') - pg_temp.num(x0, 'to_receive'));
  PERFORM pg_temp.ck('Money position', 'Previous balances', 500, pg_temp.num(x1, 'previous_balances') - pg_temp.num(x0, 'previous_balances'));
  PERFORM pg_temp.ck('Money position', 'Stock value', 5740, pg_temp.num(x1, 'stock_value') - pg_temp.num(x0, 'stock_value'));
  PERFORM pg_temp.ck('Money position', 'Goods on open orders', 0, pg_temp.num(x1, 'goods_on_open_orders') - pg_temp.num(x0, 'goods_on_open_orders'));
  PERFORM pg_temp.ck('Money position', 'Sold without stock (after the fill)', 0, pg_temp.num(x1, 'sold_without_stock') - pg_temp.num(x0, 'sold_without_stock'));
  PERFORM pg_temp.ck('Money position', 'To give (suppliers 5,010 + investor capital 10,000)', 15010, pg_temp.num(x1, 'to_give') - pg_temp.num(x0, 'to_give'));
  PERFORM pg_temp.ck('Money position', 'Customer advances', 0, pg_temp.num(x1, 'customer_advances') - pg_temp.num(x0, 'customer_advances'));
  PERFORM pg_temp.ck('Money position', 'Net worth change', 52591, pg_temp.num(x1, 'net_worth') - pg_temp.num(x0, 'net_worth'));
  PERFORM pg_temp.ck('Money position', 'Opening total change (made-up opening)', 52000,
    pg_temp.num(x1 -> 'opening', 'total') - pg_temp.num(x0 -> 'opening', 'total'));
  PERFORM pg_temp.ck('Courier', 'Expected courier fees of the REAL orders do not move (they are history)', e0,
    (SELECT COALESCE(sum(amount), 0) FROM order_courier_costs_for(
       (SELECT array_agg(id) FROM orders WHERE status = 'delivered' AND id <> ALL (v_o))) WHERE kind = 'expected'),
    'They are worked out from the last 10 inside-Dhaka bills, so our 2 new bills move them.');
  PERFORM pg_temp.ck('Books balance', 'Balance-check difference change (should be 0)', 0,
    pg_temp.num(x1, 'difference') - pg_temp.num(x0, 'difference'));
  PERFORM pg_temp.ck('Books balance', 'Net worth change − opening change = Your profit − withdrawals (591)', 591,
    (pg_temp.num(x1, 'net_worth') - pg_temp.num(x0, 'net_worth'))
    - (pg_temp.num(x1 -> 'opening', 'total') - pg_temp.num(x0 -> 'opening', 'total')));

  -- Investors / suppliers.
  SELECT row_to_json(r)::jsonb INTO v_j FROM money_to_give_rows() r WHERE r.id = v_inv;
  PERFORM pg_temp.ck('Investors', 'Investor capital owed', 10000, pg_temp.num(v_j, 'owed'));
  PERFORM pg_temp.ck('Investors', 'Investor profit share this month / all time', 300, pg_temp.num(v_j, 'share_all'),
    format('month %s year %s all %s', v_j ->> 'share_month', v_j ->> 'share_year', v_j ->> 'share_all'));
  SELECT row_to_json(r)::jsonb INTO v_j FROM money_to_give_rows() r WHERE r.id = v_sup;
  PERFORM pg_temp.ck('Suppliers', 'Supplier owed (L1 3,610 + L2 1,400)', 5010, pg_temp.num(v_j, 'owed'));

  -- Customer dues.
  SELECT row_to_json(d)::jsonb INTO v_j FROM money_customer_dues() d WHERE d.customer_key = 'ph:' || ph_rahim;
  PERFORM pg_temp.ck('Customer dues', 'Rahim: order dues', 1080, pg_temp.num(v_j, 'order_due'));
  PERFORM pg_temp.ck('Customer dues', 'Rahim: previous balance left', 500, pg_temp.num(v_j, 'previous_left'));
  SELECT row_to_json(d)::jsonb INTO v_j FROM money_customer_dues() d WHERE d.customer_key = 'ph:01799957004';
  PERFORM pg_temp.ck('Customer dues', 'O3 customer: order dues', 500, pg_temp.num(v_j, 'order_due'));

  -- Stock in the shop (whole packs) and in lots.
  PERFORM pg_temp.ck('Stock', 'Cream A units left', 4, inventory_units_left(v_pa, NULL));
  PERFORM pg_temp.ck('Stock', 'Toner B ml left', 350, inventory_units_left(v_pb, NULL));
  PERFORM pg_temp.ck('Stock', 'Toner B whole packs in the shop', 1, (SELECT stock_quantity FROM products WHERE id = v_pb));
  PERFORM pg_temp.ck('Stock', 'Serum C units left', 1, inventory_units_left(v_pc, NULL));

  -- ============================================================ EXTRA CASES
  -- Each one is compared with the moment just before it.

  -- X1. Sold without stock on an order still OPEN, then filled by a lot that
  -- costs more: "Goods on open orders" keeps the provisional ৳600.
  x0 := money_position();
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('AUDIT57-E-' || v_tag, 'audit57-e-' || v_tag, 'AUDIT57 Mask E', 1500, 'in_stock', 0, true) RETURNING id INTO v_pe;
  PERFORM inventory_set_buying_prices(jsonb_build_array(jsonb_build_object('product_id', v_pe, 'variant_id', NULL, 'price', '600')));
  SELECT order_id INTO v_id FROM admin_create_order_v2(p_source => 'phone',
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_pe, 'quantity', 1)),
    p_full_name => 'AUDIT57 Nine', p_phone => '01799957009', p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Audit road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80, p_allow_negative_stock => true);
  PERFORM admin_set_order_status(v_id, 'shipped', 'audit57');
  v_l3 := inventory_save_lot(jsonb_build_object('source_type', 'local', 'country', 'Bangladesh', 'lot_date', v_today::text,
    'costs_pending', false, 'notes', 'AUDIT57 L3', 'supplier_id', v_sup,
    'items', jsonb_build_array(jsonb_build_object('product_id', v_pe, 'qty', 1, 'unit_price_foreign', '700', 'expiry_date', '2028-06-01')),
    'costs', '[]'::jsonb));
  IF EXISTS (SELECT 1 FROM stock_shortfalls WHERE order_id = v_id AND status = 'open') THEN
    PERFORM inventory_fill_shortfalls(v_l3);
  END IF;
  x1 := money_position();
  PERFORM pg_temp.ck('X1 open order filled from a lot', 'Goods on open orders (lot cost ৳700)', 700,
    pg_temp.num(x1, 'goods_on_open_orders') - pg_temp.num(x0, 'goods_on_open_orders'));
  PERFORM pg_temp.ck('X1 open order filled from a lot', 'Balance-check difference change (should be 0)', 0,
    pg_temp.num(x1, 'difference') - pg_temp.num(x0, 'difference'));

  -- X2. A product with NO buying price and no stock, sold and delivered.
  x0 := money_position(); p0 := money_profit_parts(v_today, v_today); s0 := inventory_sales_profit(v_today, v_today) -> 'totals';
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('AUDIT57-D-' || v_tag, 'audit57-d-' || v_tag, 'AUDIT57 Oil D', 900, 'in_stock', 0, true) RETURNING id INTO v_pd;
  SELECT order_id INTO v_id FROM admin_create_order_v2(p_source => 'phone',
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_pd, 'quantity', 1)),
    p_full_name => 'AUDIT57 Ten', p_phone => '01799957010', p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Audit road', p_delivery_zone => 'hand_delivered', p_delivery_fee => 0, p_allow_negative_stock => true);
  PERFORM admin_add_order_payment(v_id, 900, 'cash', NULL, now(), 'paid');
  PERFORM admin_set_order_status(v_id, 'delivered', 'audit57');
  x1 := money_position(); p1 := money_profit_parts(v_today, v_today); s1 := inventory_sales_profit(v_today, v_today) -> 'totals';
  PERFORM pg_temp.ck('X2 no cost known', 'Money: the ৳900 sale counted in Sales', 900,
    pg_temp.num(p1, 'sales') - pg_temp.num(p0, 'sales'), 'left out = 0 here');
  PERFORM pg_temp.ck('X2 no cost known', 'Money: "orders without a cost" count goes up by 1', 1,
    pg_temp.num(p1, 'uncosted_orders') - pg_temp.num(p0, 'uncosted_orders'));
  PERFORM pg_temp.ck('X2 no cost known', 'Balance-check difference change (should be 0)', 0,
    pg_temp.num(x1, 'difference') - pg_temp.num(x0, 'difference'));
  -- … then the buying price is typed in (৳400).
  x0 := x1; p0 := p1;
  PERFORM inventory_set_buying_prices(jsonb_build_array(jsonb_build_object('product_id', v_pd, 'variant_id', NULL, 'price', '400')));
  x1 := money_position(); p1 := money_profit_parts(v_today, v_today);
  -- Batch 58 (I3): the ৳900 sale is counted at once with a ৳0 cost, so typing
  -- the ৳400 price lowers profit by 400 (the audit expected +500: sale and
  -- cost arriving together under the old rule).
  PERFORM pg_temp.ck('X2 no cost known', 'After "Set buying prices" ৳400: net profit −400 (the sale already counted)', -400,
    pg_temp.num(p1, 'net_profit') - pg_temp.num(p0, 'net_profit'));
  PERFORM pg_temp.ck('X2 no cost known', 'After it: "sold without stock" owed back = ৳400', 400,
    pg_temp.num(x1, 'sold_without_stock') - pg_temp.num(x0, 'sold_without_stock'));
  PERFORM pg_temp.ck('X2 no cost known', 'After it: balance-check difference change (should be 0)', 0,
    pg_temp.num(x1, 'difference') - pg_temp.num(x0, 'difference'));

  -- X3. A customer pays ৳200 more than the order (no refund yet).
  x0 := money_position();
  SELECT order_id INTO v_id FROM admin_create_order_v2(p_source => 'phone',
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_pa, 'quantity', 1)),
    p_full_name => 'AUDIT57 Eleven', p_phone => '01799957011', p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Audit road', p_delivery_zone => 'hand_delivered', p_delivery_fee => 0);
  PERFORM admin_add_order_payment(v_id, 1200, 'cash', NULL, now(), 'paid 200 extra');
  PERFORM admin_set_order_status(v_id, 'delivered', 'audit57');
  x1 := money_position();
  SELECT row_to_json(d)::jsonb INTO v_j FROM money_customer_dues() d WHERE d.customer_key = 'ph:01799957011';
  PERFORM pg_temp.ck('X3 overpaid order', 'Money position: customer advances +200', 200,
    pg_temp.num(x1, 'customer_advances') - pg_temp.num(x0, 'customer_advances'));
  -- Batch 58 (I11): the extra is shown as the customer's credit (its own
  -- column), not as a negative due.
  PERFORM pg_temp.ck('X3 overpaid order', 'Customer dues list: credit ৳200 (paid more than owed)', 200,
    CASE WHEN v_j IS NULL THEN 0 ELSE pg_temp.num(v_j, 'credit') END,
    CASE WHEN v_j IS NULL THEN 'customer not in the dues list at all' ELSE v_j::text END);

  -- X4. Investor profit share paid BEFORE the money start date (direct, like
  -- the Batch 56 import): "this year" vs "all time".
  INSERT INTO money_movements (entry_date, account_id, amount, type, party_id, note, created_by, created_by_username)
  VALUES (v_start - 1, v_bank, -250, 'investor_profit_share', v_inv, 'AUDIT57 old share', v_admin, 'audit57');
  SELECT row_to_json(r)::jsonb INTO v_j FROM money_to_give_rows() r WHERE r.id = v_inv;
  PERFORM pg_temp.ck('X4 share before the start date', 'Investor share this year = all time (both 300 or both 550)',
    pg_temp.num(v_j, 'share_all'), pg_temp.num(v_j, 'share_year'),
    format('year %s · all time %s', v_j ->> 'share_year', v_j ->> 'share_all'));

  -- X5. The same day before the start date: sales count, expenses don't.
  p0 := money_profit_parts(v_start - 1, v_start - 1);
  INSERT INTO money_movements (entry_date, account_id, amount, type, category_id, note, created_by, created_by_username)
  VALUES (v_start - 1, v_bank, -400, 'expense', v_cat, 'AUDIT57 old expense', v_admin, 'audit57');
  INSERT INTO stock_write_offs (write_date, product_id, label, units, reason, cost_bdt, created_by_username)
  VALUES (v_start - 1, v_pa, 'AUDIT57 old write-off', 1, 'expired', 300, 'audit57');
  p1 := money_profit_parts(v_start - 1, v_start - 1);
  -- Batch 58 (C1, I9): ONE date rule — nothing dated before the start date
  -- counts (the audit asked that the two be equal; both are now 0).
  PERFORM pg_temp.ck('X5 before the start date', 'A ৳400 expense dated before the start date: not counted (0)', 0,
    pg_temp.num(p1, 'expenses') - pg_temp.num(p0, 'expenses'));
  PERFORM pg_temp.ck('X5 before the start date', 'A ৳300 write-off dated before the start date: not counted (0)', 0,
    pg_temp.num(p1, 'write_offs') - pg_temp.num(p0, 'write_offs'));

  -- ============================================================ BATCH 58 CHECKS
  -- N1. The expected courier fee is frozen once: new bills don't move it.
  SELECT order_id INTO v_id FROM admin_create_order_v2(p_source => 'phone',
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_pa, 'quantity', 1)),
    p_full_name => 'AUDIT57 Twelve', p_phone => '01799957012', p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Audit road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80);
  UPDATE orders SET steadfast_consignment_id = 'AUDIT57-' || v_tag || '-N1' WHERE id = v_id;
  x0 := money_position();
  PERFORM admin_set_order_status(v_id, 'delivered', 'audit57');
  x1 := money_position();
  v_n := (SELECT amount FROM order_courier_expected WHERE order_id = v_id);
  PERFORM pg_temp.ck('N1 frozen expected fee', 'Stored once when the booked parcel is delivered', 1,
    CASE WHEN v_n IS NULL THEN 0 ELSE 1 END, format('frozen ৳%s', v_n));
  PERFORM pg_temp.ck('N1 frozen expected fee', 'To give: "Courier (not billed yet)" rises by it', v_n,
    pg_temp.num(x1, 'to_give_courier') - pg_temp.num(x0, 'to_give_courier'));
  PERFORM pg_temp.ck('N1 frozen expected fee', 'Balance-check difference change (should be 0)', 0,
    pg_temp.num(x1, 'difference') - pg_temp.num(x0, 'difference'));
  -- Two much dearer inside-Dhaka bills arrive (they move the "last 10" average).
  INSERT INTO order_courier_costs (order_id, cod_collected, delivery_charge, cod_fee, other_deduction, total_kept, net_received, payout_id, paid_at)
  VALUES (v_o[4], 0, 400, 0, 0, 400, 0, NULL, now()), (v_o[7], 0, 400, 0, 0, 400, 0, NULL, now());
  PERFORM pg_temp.ck('N1 frozen expected fee', 'After two ৳400 bills arrive, the frozen fee does not move', v_n,
    (SELECT amount FROM order_courier_costs_for(ARRAY[v_id])));
  x0 := money_position();
  INSERT INTO order_courier_costs (order_id, cod_collected, delivery_charge, cod_fee, other_deduction, total_kept, net_received, payout_id, paid_at)
  VALUES (v_id, 0, 70, 0, 0, 70, 0, NULL, now());
  x1 := money_position();
  PERFORM pg_temp.ck('N1 frozen expected fee', 'The real bill (৳70) replaces it: the order''s courier is ৳70', 70,
    (SELECT amount FROM order_courier_costs_for(ARRAY[v_id])));
  PERFORM pg_temp.ck('N1 frozen expected fee', 'and "Courier (not billed yet)" drops by the frozen fee', -v_n,
    pg_temp.num(x1, 'to_give_courier') - pg_temp.num(x0, 'to_give_courier'));

  -- N2. A Steadfast bill paid outside the payout: owed until recorded.
  SELECT order_id INTO v_id FROM admin_create_order_v2(p_source => 'phone',
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_pa, 'quantity', 1)),
    p_full_name => 'AUDIT57 Thirteen', p_phone => '01799957013', p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Audit road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80);
  PERFORM admin_add_order_payment(v_id, 1080, 'cash', NULL, now(), 'paid');
  PERFORM admin_set_order_status(v_id, 'delivered', 'audit57');
  x0 := money_position(); p0 := money_profit_parts(v_today, v_today);
  INSERT INTO steadfast_payouts (steadfast_payment_id, paid_at, total_amount, parcel_count, items_synced)
  VALUES ('AUDIT57-N2-' || v_tag, now(), 0, 1, true) RETURNING id INTO v_payout;
  UPDATE orders SET steadfast_consignment_id = 'AUDIT57-' || v_tag || '-N2' WHERE id = v_id;
  INSERT INTO steadfast_payout_items (payout_id, item_key, consignment_id, invoice, order_id, cod_collected, delivery_charge,
                                      cod_fee, other_deduction, net_paid, expected_cod, match_status, line_kind, bill_paid_separately)
  SELECT v_payout, 'audit57:n2', o.steadfast_consignment_id, o.order_number, o.id, 0, 0, 0, 0, 0, 0, 'matched', 'order', 65
  FROM orders o WHERE o.id = v_id;
  INSERT INTO order_courier_costs (order_id, cod_collected, delivery_charge, cod_fee, other_deduction, total_kept, net_received,
                                   payout_id, paid_at, bill_paid_separately)
  VALUES (v_id, 0, 0, 0, 0, 65, 0, v_payout, now(), 65);
  x1 := money_position(); p1 := money_profit_parts(v_today, v_today);
  PERFORM pg_temp.ck('N2 bill paid outside the payout', 'Courier cost in profit +65', 65,
    pg_temp.num(p1, 'courier') - pg_temp.num(p0, 'courier'));
  PERFORM pg_temp.ck('N2 bill paid outside the payout', 'Owed (To give, courier) +65 until recorded', 65,
    pg_temp.num(x1, 'to_give_courier') - pg_temp.num(x0, 'to_give_courier'));
  PERFORM pg_temp.ck('N2 bill paid outside the payout', 'Balance-check difference change (should be 0)', 0,
    pg_temp.num(x1, 'difference') - pg_temp.num(x0, 'difference'));
  PERFORM pg_temp.ck('N2 bill paid outside the payout', 'Order page: ৳65 not taken from any account yet', 65,
    pg_temp.num(money_courier_bill_status(v_id), 'owed'));
  x0 := x1; v_n := pg_temp.bal(v_bank);
  v_mv := money_record_courier_bill(v_id, v_bank, v_today);
  x1 := money_position();
  PERFORM pg_temp.ck('N2 bill paid outside the payout', 'Record payment: the chosen account goes down by 65', -65, pg_temp.bal(v_bank) - v_n);
  PERFORM pg_temp.ck('N2 bill paid outside the payout', 'and nothing is owed any more', -65,
    pg_temp.num(x1, 'to_give_courier') - pg_temp.num(x0, 'to_give_courier'));
  PERFORM pg_temp.ck('N2 bill paid outside the payout', 'Order page: owed 0', 0, pg_temp.num(money_courier_bill_status(v_id), 'owed'));
  PERFORM pg_temp.ck('N2 bill paid outside the payout', 'Balance-check difference change (should be 0)', 0,
    pg_temp.num(x1, 'difference') - pg_temp.num(x0, 'difference'));
  x0 := x1;
  PERFORM money_delete_entry(v_mv, 65);
  x1 := money_position();
  PERFORM pg_temp.ck('N2 bill paid outside the payout', 'Deleting that money movement makes it owed again', 65,
    pg_temp.num(x1, 'to_give_courier') - pg_temp.num(x0, 'to_give_courier'));

  -- N5. Move the money start date back (as Batch 59 will): every screen
  -- function follows it, with nothing else changed.
  UPDATE money_books SET start_date = DATE '2026-01-01' WHERE id = 1;
  p1 := money_profit_parts(v_start - 1, v_start - 1);
  PERFORM pg_temp.ck('N5 start date moved back', 'Expenses of the day before the old start date now count (the ৳400 of X5 too)',
    (SELECT COALESCE(-sum(amount), 0) FROM money_movements WHERE type = 'expense' AND entry_date = v_start - 1),
    pg_temp.num(p1, 'expenses'));
  PERFORM pg_temp.ck('N5 start date moved back', 'Write-offs of that day now count (the ৳300 of X5 too)',
    (SELECT COALESCE(sum(cost_bdt), 0) FROM stock_write_offs WHERE write_date = v_start - 1), pg_temp.num(p1, 'write_offs'));
  p1 := money_profit_parts(DATE '2026-10-01', DATE '2026-10-31');
  s1 := inventory_sales_profit(DATE '2026-10-01', DATE '2026-10-31') -> 'totals';
  PERFORM pg_temp.ck('N5 start date moved back', 'October sales = every order delivered in October (orders table)',
    (SELECT COALESCE(sum(GREATEST(o.subtotal - o.discount, 0)), 0) FROM orders o
     WHERE o.status = 'delivered' AND money_dhaka_date(inventory_order_counted_at(o.id, o.status)) BETWEEN DATE '2026-10-01' AND DATE '2026-10-31'),
    pg_temp.num(p1, 'sales'));
  PERFORM pg_temp.ck('N5 start date moved back', 'October: Sales profit page sales = Money sales', pg_temp.num(p1, 'sales'), pg_temp.num(s1, 'sales'));
  PERFORM pg_temp.ck('N5 start date moved back', 'October expenses now count',
    (SELECT COALESCE(-sum(amount), 0) FROM money_movements WHERE type = 'expense' AND entry_date BETWEEN DATE '2026-10-01' AND DATE '2026-10-31'),
    pg_temp.num(p1, 'expenses'));
  p1 := money_profit_parts(DATE '2026-01-01', v_today);
  r1 := report_profit_loss(DATE '2026-01-01', v_today) -> 'parts';
  PERFORM pg_temp.ck('N5 start date moved back', 'This year: Reports P&L net = Money net', pg_temp.num(p1, 'net_profit'), pg_temp.num(r1, 'net_profit'));
  PERFORM pg_temp.ck('N5 start date moved back', 'This year: old Kaarbar bills now count (bills dated 2026)',
    (SELECT COALESCE(sum(CASE WHEN kind = 'return' THEN -(items_total - bill_discount) ELSE items_total - bill_discount END), 0)
     FROM kaarbar_bills WHERE bill_date BETWEEN DATE '2026-01-01' AND v_today),
    pg_temp.num(p1, 'old_sales'));
  PERFORM pg_temp.ck('N5 start date moved back', 'This year: Products report old totals = Money old profit',
    pg_temp.num(p1, 'old_profit'), pg_temp.num(report_products(DATE '2026-01-01', v_today) -> 'old_totals', 'old_profit'));
  d1 := money_dashboard(DATE '2026-01-01', v_today, NULL, NULL) -> 'summary' -> 'profit';
  PERFORM pg_temp.ck('N5 start date moved back', 'This year: Home Your profit = Reports Your profit', pg_temp.num(r1, 'your_profit'),
    pg_temp.num(d1, 'your_profit'));
  SELECT m INTO v_j FROM jsonb_array_elements(report_charts() -> 'months') m WHERE (m ->> 'month')::date = DATE '2026-10-01';
  PERFORM pg_temp.ck('N5 start date moved back', 'October: Charts net = Money net',
    pg_temp.num(money_profit_parts(DATE '2026-10-01', DATE '2026-10-31'), 'net_profit'), pg_temp.num(v_j, 'net_profit'));
  SELECT row_to_json(r)::jsonb INTO v_j FROM money_to_give_rows() r WHERE r.id = v_inv;
  PERFORM pg_temp.ck('N5 start date moved back', 'Investor share this year = all time (the old ৳250 of X4 now counts: 550)',
    550, pg_temp.num(v_j, 'share_year'), format('year %s · all time %s', v_j ->> 'share_year', v_j ->> 'share_all'));
  PERFORM pg_temp.ck('N5 start date moved back', 'Investor share all time = 550', 550, pg_temp.num(v_j, 'share_all'));

  -- N3. A locked month never changes (start date still 1 Jan 2026 here).
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('AUDIT57-F-' || v_tag, 'audit57-f-' || v_tag, 'AUDIT57 Gel F', 1500, 'in_stock', 0, true) RETURNING id INTO v_pf;
  INSERT INTO products (sku, slug, name, retail_price, stock_status, stock_quantity, is_active)
  VALUES ('AUDIT57-G-' || v_tag, 'audit57-g-' || v_tag, 'AUDIT57 Balm G', 900, 'in_stock', 0, true) RETURNING id INTO v_pg;
  PERFORM inventory_set_buying_prices(jsonb_build_array(jsonb_build_object('product_id', v_pf, 'variant_id', NULL, 'price', '600')));
  SELECT order_id INTO v_ol FROM admin_create_order_v2(p_source => 'phone',
    p_items => jsonb_build_array(jsonb_build_object('product_id', v_pf, 'quantity', 1), jsonb_build_object('product_id', v_pg, 'quantity', 1)),
    p_full_name => 'AUDIT57 Fourteen', p_phone => '01799957014', p_division => 'Dhaka', p_district => 'Dhaka', p_thana => 'Gulshan',
    p_address_line => 'Audit road', p_delivery_zone => 'inside_dhaka', p_delivery_fee => 80, p_allow_negative_stock => true);
  UPDATE orders SET steadfast_consignment_id = 'AUDIT57-' || v_tag || '-N3' WHERE id = v_ol;
  PERFORM admin_set_order_status(v_ol, 'delivered', 'audit57');
  -- Its life moved to October (before the month is locked).
  UPDATE order_status_history SET changed_at = TIMESTAMPTZ '2026-10-15 12:00:00+06' WHERE order_id = v_ol;
  UPDATE orders SET created_at = TIMESTAMPTZ '2026-10-14 12:00:00+06' WHERE id = v_ol;
  v_n := (SELECT amount FROM order_courier_costs_for(ARRAY[v_ol]));
  INSERT INTO money_month_locks (month, locked, locked_at, locked_by_username, checklist)
  VALUES (DATE '2026-10-01', true, now(), 'audit57', '{}'::jsonb)
  ON CONFLICT (month) DO UPDATE SET locked = true, locked_at = now();
  PERFORM money_lock_snapshot(DATE '2026-10-01');
  p0 := money_profit_parts(DATE '2026-10-01', DATE '2026-10-31');
  d0 := money_profit_parts(v_today, v_today);
  r0 := report_profit_loss(v_today, v_today) -> 'parts';
  -- (a) the real Steadfast bill arrives, ৳5 more than the frozen fee
  INSERT INTO order_courier_costs (order_id, cod_collected, delivery_charge, cod_fee, other_deduction, total_kept, net_received, payout_id, paid_at)
  VALUES (v_ol, 0, v_n + 5, 0, 0, v_n + 5, 0, NULL, now());
  -- (b) a lot fills the "sold without stock" Gel F at ৳700 (provisional ৳600)
  v_l4 := inventory_save_lot(jsonb_build_object('source_type', 'local', 'country', 'Bangladesh', 'lot_date', v_today::text,
    'costs_pending', false, 'notes', 'AUDIT57 L4', 'supplier_id', v_sup,
    'items', jsonb_build_array(jsonb_build_object('product_id', v_pf, 'qty', 1, 'unit_price_foreign', '700', 'expiry_date', '2028-06-01')),
    'costs', '[]'::jsonb));
  IF EXISTS (SELECT 1 FROM stock_shortfalls WHERE order_id = v_ol AND product_id = v_pf AND status = 'open') THEN
    PERFORM inventory_fill_shortfalls(v_l4);
  END IF;
  -- (c) a buying price ৳400 is typed for Balm G (no cost until now)
  PERFORM inventory_set_buying_prices(jsonb_build_array(jsonb_build_object('product_id', v_pg, 'variant_id', NULL, 'price', '400')));
  p1 := money_profit_parts(DATE '2026-10-01', DATE '2026-10-31');
  d1 := money_profit_parts(v_today, v_today);
  r1 := report_profit_loss(v_today, v_today) -> 'parts';
  PERFORM pg_temp.ck('N3 locked month', 'October (locked) net profit does not change', pg_temp.num(p0, 'net_profit'), pg_temp.num(p1, 'net_profit'));
  PERFORM pg_temp.ck('N3 locked month', 'October cost of goods does not change', pg_temp.num(p0, 'cost'), pg_temp.num(p1, 'cost'));
  PERFORM pg_temp.ck('N3 locked month', 'October courier does not change', pg_temp.num(p0, 'courier'), pg_temp.num(p1, 'courier'));
  PERFORM pg_temp.ck('N3 locked month', 'Today: Adjustments to locked months −505 (courier +5, Gel F +100, Balm G +400)', -505,
    pg_temp.num(d1, 'locked_adjustments') - pg_temp.num(d0, 'locked_adjustments'));
  PERFORM pg_temp.ck('N3 locked month', 'Today: net profit −505', -505, pg_temp.num(d1, 'net_profit') - pg_temp.num(d0, 'net_profit'));
  PERFORM pg_temp.ck('N3 locked month', 'Reports P&L today shows the same line', -505,
    pg_temp.num(r1, 'locked_adjustments') - pg_temp.num(r0, 'locked_adjustments'));
  PERFORM pg_temp.ck('N3 locked month', 'Note: "Courier bill for NM-… (delivered in a locked month): +৳5"', 1,
    (SELECT count(*) FROM money_lock_adjustments a JOIN orders o ON o.id = a.order_id
     WHERE a.order_id = v_ol AND a.note = 'Courier bill for ' || o.order_number || ' (delivered in a locked month): +৳5'),
    (SELECT string_agg(note, ' | ') FROM money_lock_adjustments WHERE order_id = v_ol));
  BEGIN
    PERFORM admin_set_order_status(v_ol, 'shipped', 'audit57 reopen');
    v_b := false;
  EXCEPTION WHEN others THEN
    v_b := true;
  END;
  PERFORM pg_temp.ck('N3 locked month', 'Reopening the order is refused while October is locked', 1, CASE WHEN v_b THEN 1 ELSE 0 END);

  -- N4. Deleting a delivered order: Super Admin with the Safety Lock only.
  v_mod := (SELECT p.id FROM profiles p JOIN staff_members s ON s.id = p.id
            WHERE p.role = 'moderator' AND p.status = 'approved' ORDER BY p.created_at LIMIT 1);
  IF v_mod IS NOT NULL THEN
    UPDATE staff_members SET is_disabled = false, role_id = NULL,
           permissions = array_append(array_remove(permissions, 'delete_early_orders'), 'delete_early_orders')
    WHERE id = v_mod;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_mod, 'role', 'authenticated', 'aal', 'aal2')::text, true);
    BEGIN
      SELECT x.deleted INTO v_b FROM admin_delete_orders(ARRAY[v_o[8]]) x;
    EXCEPTION WHEN others THEN
      v_b := false;
    END;
    PERFORM set_config('request.jwt.claims', c_admin, true);
    PERFORM pg_temp.ck('N4 delete a delivered order', 'Staff (with "delete early orders"): refused', 0, CASE WHEN v_b THEN 1 ELSE 0 END);
  END IF;
  DELETE FROM admin_safety_locks WHERE user_id = v_admin;
  SELECT x.deleted INTO v_b FROM admin_delete_orders(ARRAY[v_o[8]]) x;
  PERFORM pg_temp.ck('N4 delete a delivered order', 'Super Admin, Safety Lock off: refused', 0, CASE WHEN v_b THEN 1 ELSE 0 END);
  INSERT INTO admin_safety_locks (user_id, delete_any_until, opened_at) VALUES (v_admin, now() + interval '1 hour', now());
  BEGIN
    SELECT x.deleted INTO v_b FROM admin_delete_orders(ARRAY[v_ol]) x;
  EXCEPTION WHEN others THEN
    v_b := false;
  END;
  PERFORM pg_temp.ck('N4 delete a delivered order', 'Super Admin, Safety Lock on, order in a LOCKED month: refused', 0, CASE WHEN v_b THEN 1 ELSE 0 END);
  SELECT order_number INTO v_txt FROM orders WHERE id = v_o[8];
  SELECT x.deleted INTO v_b FROM admin_delete_orders(ARRAY[v_o[8]]) x;
  PERFORM pg_temp.ck('N4 delete a delivered order', 'Super Admin, Safety Lock on: deleted', 1, CASE WHEN v_b THEN 1 ELSE 0 END);
  PERFORM pg_temp.ck('N4 delete a delivered order', 'Activity Log line with the order number, total and payments', 1,
    (SELECT count(*) FROM activity_log WHERE action = 'order.delete_counted' AND entity_label = v_txt
       AND summary = 'Deleted delivered order ' || v_txt || ': total ৳600, payments ৳600'),
    (SELECT string_agg(summary, ' | ') FROM activity_log WHERE action = 'order.delete_counted' AND entity_label = v_txt));
END
$month$;

SELECT json_agg(json_build_object('step', step, 'check', chk, 'hand', hand, 'site', site, 'ok', ok, 'detail', detail) ORDER BY n)::text AS month
FROM t_m;
ROLLBACK;
