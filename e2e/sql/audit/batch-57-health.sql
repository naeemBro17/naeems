-- Batch 57 audit: health check of the REAL shop data (read-only).
--
-- Safe to run again at any time, on the live database, in the Supabase SQL
-- Editor or with the Supabase command line:
--   supabase db query --linked -f e2e/sql/audit/batch-57-health.sql
-- It changes nothing: everything runs inside ONE transaction that ends with
-- ROLLBACK. (It has to be a transaction: money_position() writes today's row
-- in money_check_log every time it is read; the ROLLBACK undoes that too.)
--
-- It reads as the first admin login, so the money functions answer.
-- Result: one row, one JSON list of checks:
--   { check, count, amount (৳), examples (order numbers / lot codes, max 5), note }
-- No customer phone numbers are ever shown.
BEGIN;

SELECT set_config('request.jwt.claims', json_build_object(
  'sub', (SELECT id FROM profiles WHERE role = 'admin' ORDER BY created_at LIMIT 1),
  'role', 'authenticated', 'aal', 'aal2')::text, true);

CREATE TEMP TABLE t_h (n serial, chk text, cnt numeric, amount numeric, examples text, note text) ON COMMIT DROP;

DO $health$
DECLARE
  v_start  date := money_start_date();
  v_ts     timestamptz := money_start_ts();
  v_today  date := inventory_dhaka_today();
  v_pos    jsonb;
  v_cnt    numeric;
  v_amt    numeric;
  v_ex     text;
  v_a      jsonb;
  v_b      jsonb;
  v_c      jsonb;
  r        record;
BEGIN
  -- 0. Is Batch 56's expense import there?
  SELECT count(*), COALESCE(sum(total_amount), 0) INTO v_cnt, v_amt
  FROM kaarbar_imports WHERE kind = 'expenses' AND undone_at IS NULL;
  INSERT INTO t_h (chk, cnt, amount, note) VALUES ('Kaarbar expense imports on the database (Batch 56)', v_cnt, v_amt,
    'If 0, every expense number below is incomplete.');

  -- 1. Delivered orders with an item that has no stored cost (or ৳0).
  SELECT count(DISTINCT o.id), COALESCE(sum(oi.line_total), 0),
         string_agg(DISTINCT o.order_number, ', ')
  INTO v_cnt, v_amt, v_ex
  FROM orders o JOIN order_items oi ON oi.order_id = o.id
  LEFT JOIN order_item_costs c ON c.order_item_id = oi.id
  WHERE o.status = 'delivered' AND c.unit_cost_bdt IS NULL;
  INSERT INTO t_h (chk, cnt, amount, examples, note) VALUES ('Delivered orders with an item that has NO cost', v_cnt, v_amt,
    left(v_ex, 80), 'amount = item sales on those lines. The whole order (sale, delivery, courier) is then left out of profit.');
  SELECT count(DISTINCT o.id), COALESCE(sum(oi.line_total), 0), string_agg(DISTINCT o.order_number, ', ')
  INTO v_cnt, v_amt, v_ex
  FROM orders o JOIN order_items oi ON oi.order_id = o.id
  JOIN order_item_costs c ON c.order_item_id = oi.id
  WHERE o.status = 'delivered' AND c.unit_cost_bdt = 0;
  INSERT INTO t_h (chk, cnt, amount, examples, note) VALUES ('Delivered orders with an item costed at ৳0', v_cnt, v_amt,
    left(v_ex, 80), 'amount = item sales counted as 100% profit.');
  SELECT count(*), COALESCE(sum(oi.quantity * c.unit_cost_bdt), 0),
         string_agg(o.order_number, ', ' ORDER BY o.order_number)
  INTO v_cnt, v_amt, v_ex
  FROM orders o JOIN order_items oi ON oi.order_id = o.id
  JOIN order_item_costs c ON c.order_item_id = oi.id
  WHERE o.status = 'delivered' AND c.source = 'buying_price';
  INSERT INTO t_h (chk, cnt, amount, examples, note) VALUES ('Delivered lines costed from "Set buying prices" (not from a lot)', v_cnt, v_amt,
    left(v_ex, 80), 'amount = cost used. Fine for old orders; worth knowing how much profit rests on typed-in prices.');

  -- 2. Order totals and payments.
  SELECT count(*), COALESCE(sum(total - (subtotal - discount + delivery_fee)), 0),
         string_agg(order_number, ', ' ORDER BY order_number)
  INTO v_cnt, v_amt, v_ex
  FROM orders WHERE total <> GREATEST(subtotal - discount + delivery_fee, 0);
  INSERT INTO t_h (chk, cnt, amount, examples) VALUES ('Order total ≠ items − discount + delivery', v_cnt, v_amt, left(v_ex, 80));
  SELECT count(*), COALESCE(sum(o.subtotal - x.items), 0), string_agg(o.order_number, ', ' ORDER BY o.order_number)
  INTO v_cnt, v_amt, v_ex
  FROM orders o JOIN (SELECT order_id, sum(line_total) AS items FROM order_items GROUP BY order_id) x ON x.order_id = o.id
  WHERE o.subtotal <> x.items;
  INSERT INTO t_h (chk, cnt, amount, examples) VALUES ('Order subtotal ≠ sum of its item lines', v_cnt, v_amt, left(v_ex, 80));
  SELECT count(*), COALESCE(sum(p.net - CASE WHEN o.status IN ('cancelled', 'returned') THEN 0 ELSE o.total END), 0),
         string_agg(o.order_number || ' (' || o.status || ')', ', ' ORDER BY o.order_number)
  INTO v_cnt, v_amt, v_ex
  FROM orders o JOIN (SELECT order_id, sum(CASE WHEN kind = 'refund' THEN -amount ELSE amount END) AS net
                      FROM order_payments GROUP BY order_id) p ON p.order_id = o.id
  WHERE p.net > CASE WHEN o.status IN ('cancelled', 'returned') THEN 0 ELSE o.total END;
  INSERT INTO t_h (chk, cnt, amount, examples, note) VALUES ('Orders paid MORE than they owe (customer money held)', v_cnt, v_amt,
    left(v_ex, 120), 'Money page counts this as "customer advances"; the customer dues list shows ৳0 for these orders (the extra is not shown as credit).');
  SELECT count(*), COALESCE(sum(amount), 0) INTO v_cnt, v_amt FROM order_payments WHERE amount <= 0;
  INSERT INTO t_h (chk, cnt, amount) VALUES ('Payment rows with ৳0 or a negative amount', v_cnt, v_amt);

  -- 3. Lots and stock.
  SELECT count(*), string_agg(DISTINCT lot_code || ' ' || label, '; ') INTO v_cnt, v_ex
  FROM (SELECT * FROM inventory_stock_check() LIMIT 50) s WHERE reason_code = 'ledger';
  INSERT INTO t_h (chk, cnt, examples) VALUES ('Lot rows whose units left ≠ their stock movements', v_cnt, left(v_ex, 160));
  SELECT count(*), string_agg(l.code, ', ') INTO v_cnt, v_ex
  FROM lot_items li JOIN lots l ON l.id = li.lot_id
  WHERE li.qty_remaining <> li.qty
        - COALESCE((SELECT sum(x.units - x.units_back) FROM order_item_lots x WHERE x.lot_item_id = li.id), 0)
        - COALESCE((SELECT sum(-m.qty) FROM stock_movements m WHERE m.lot_item_id = li.id
                     AND m.movement_type NOT IN ('opening', 'purchase', 'sale', 'cancel')), 0);
  INSERT INTO t_h (chk, cnt, examples, note) VALUES ('Lot rows: units left ≠ units in − units on orders (+ given back) − other moves', v_cnt, left(v_ex, 80),
    'Checked against order_item_lots, independent of the movement log.');
  SELECT count(*), string_agg(l.code, ', ') INTO v_cnt, v_ex
  FROM lot_items li JOIN lots l ON l.id = li.lot_id WHERE li.qty_remaining < 0;
  INSERT INTO t_h (chk, cnt, examples) VALUES ('Lot rows with negative units left', v_cnt, v_ex);
  SELECT count(*), string_agg(label || ' shop ' || shop_number || ' vs lots ' || lot_number, '; ') INTO v_cnt, v_ex
  FROM (SELECT * FROM inventory_stock_check() WHERE reason_code = 'shop_differs' LIMIT 5) s;
  SELECT count(*) INTO v_cnt FROM inventory_stock_check() WHERE reason_code = 'shop_differs';
  INSERT INTO t_h (chk, cnt, examples, note) VALUES ('Shop stock ≠ whole packs in lots', v_cnt, left(v_ex, 200),
    CASE WHEN inventory_mode_on() THEN 'Inventory mode is ON.' ELSE 'Inventory mode is OFF (not expected to match).' END);
  SELECT count(*), string_agg(reason_code || ': ' || label, '; ') INTO v_cnt, v_ex
  FROM (SELECT * FROM inventory_stock_check() WHERE reason_code NOT IN ('shop_differs', 'ledger') LIMIT 5) s;
  INSERT INTO t_h (chk, cnt, examples) VALUES ('Other stock-check warnings (no lot / sold with no lot / …), first 5', v_cnt, left(v_ex, 200));
  -- Goods on open orders valued at the cost written when they were taken,
  -- not the lot's current cost (a provisional ৳0, or the opening cost before
  -- Batch 45 took the weight out).
  SELECT count(DISTINCT o.id),
         COALESCE(round(sum((x.units - x.units_back) * (li.landed_unit_cost_bdt - x.unit_cost_bdt)), 2), 0),
         string_agg(DISTINCT o.order_number, ', ')
  INTO v_cnt, v_amt, v_ex
  FROM order_item_lots x JOIN lot_items li ON li.id = x.lot_item_id JOIN orders o ON o.id = x.order_id
  WHERE o.status IN ('pending', 'confirmed', 'shipped') AND x.units > x.units_back
    AND round(x.unit_cost_bdt, 2) <> round(li.landed_unit_cost_bdt, 2);
  INSERT INTO t_h (chk, cnt, amount, examples, note) VALUES ('Open orders whose goods are valued at an old / provisional cost', v_cnt, v_amt,
    left(v_ex, 80), 'amount = lot cost − value used in "Goods on open orders". Net worth is short by this much until they are delivered.');
  SELECT count(*), COALESCE(sum(o.total), 0), string_agg(o.order_number, ', ')
  INTO v_cnt, v_amt, v_ex
  FROM stock_shortfalls s JOIN orders o ON o.id = s.order_id
  WHERE s.status = 'open' AND s.provisional_unit_cost_bdt = 0;
  INSERT INTO t_h (chk, cnt, amount, examples, note) VALUES ('Open "sold without stock" rows with a ৳0 provisional cost', v_cnt, v_amt,
    left(v_ex, 80), 'amount = those orders'' totals.');

  -- 4. Steadfast.
  SELECT count(*), COALESCE(sum(p.total_amount - x.net), 0), string_agg(left(p.steadfast_payment_id::text, 12), ', ')
  INTO v_cnt, v_amt, v_ex
  FROM steadfast_payouts p JOIN (SELECT payout_id, sum(net_paid) AS net FROM steadfast_payout_items GROUP BY payout_id) x
    ON x.payout_id = p.id
  WHERE p.total_amount <> x.net;
  INSERT INTO t_h (chk, cnt, amount, examples) VALUES ('Payouts whose parcels don''t add up to what Steadfast paid', v_cnt, v_amt, v_ex);
  SELECT count(*), COALESCE(sum(i.cod_collected - i.delivery_charge - i.cod_fee - i.other_deduction - i.net_paid), 0)
  INTO v_cnt, v_amt
  FROM steadfast_payout_items i
  WHERE i.line_kind = 'order' AND i.cod_collected - i.delivery_charge - i.cod_fee - i.other_deduction <> i.net_paid;
  INSERT INTO t_h (chk, cnt, amount) VALUES ('Payout lines: COD − charges ≠ paid', v_cnt, v_amt);
  SELECT count(*), COALESCE(sum(c.amount), 0), string_agg(o.order_number || ' (' || to_char(x.at, 'DD Mon') || ')', ', ')
  INTO v_cnt, v_amt, v_ex
  FROM orders o
  CROSS JOIN LATERAL (SELECT inventory_order_counted_at(o.id, o.status) AS at) x
  JOIN LATERAL order_courier_costs_for(ARRAY[o.id]) c ON true
  WHERE o.status = 'delivered' AND c.kind = 'expected' AND x.at < now() - interval '14 days';
  INSERT INTO t_h (chk, cnt, amount, examples, note) VALUES ('Delivered > 14 days ago, still only an EXPECTED courier fee', v_cnt, v_amt, left(v_ex, 120),
    'Steadfast should have paid out by now: check the payout matched.');
  SELECT count(*), COALESCE(sum(c.amount), 0), string_agg(o.order_number, ', ')
  INTO v_cnt, v_amt, v_ex
  FROM orders o JOIN LATERAL order_courier_costs_for(ARRAY[o.id]) c ON true
  WHERE o.status = 'delivered' AND c.kind = 'expected';
  INSERT INTO t_h (chk, cnt, amount, examples, note) VALUES ('All delivered orders with only an expected courier fee', v_cnt, v_amt, left(v_ex, 80),
    'Counted in profit, but no payable is kept for it: the books-balance check shows it as a difference.');
  SELECT count(*), COALESCE(sum(bill_paid_separately), 0), string_agg(o.order_number, ', ')
  INTO v_cnt, v_amt, v_ex
  FROM order_courier_costs cc JOIN orders o ON o.id = cc.order_id WHERE cc.bill_paid_separately <> 0;
  INSERT INTO t_h (chk, cnt, amount, examples, note) VALUES ('Courier bills "paid separately" (e.g. by bKash)', v_cnt, v_amt, left(v_ex, 80),
    'Counted in profit; no account goes down for them, so the balance check shows them as a difference.');
  SELECT count(*), COALESCE(sum(p.total_amount), 0) INTO v_cnt, v_amt
  FROM steadfast_payouts p
  WHERE p.total_amount > 0 AND NOT EXISTS (SELECT 1 FROM money_movements m WHERE m.payout_id = p.id)
    AND (v_start IS NULL OR p.paid_at >= v_ts);
  INSERT INTO t_h (chk, cnt, amount, note) VALUES ('Steadfast payouts not yet placed into an account', v_cnt, v_amt,
    'Still shown as "With Steadfast" although Steadfast has paid them.');

  -- 5. Locks and the start date.
  SELECT count(*), COALESCE(sum(m.amount), 0), string_agg(DISTINCT to_char(m.entry_date, 'Mon YYYY'), ', ')
  INTO v_cnt, v_amt, v_ex
  FROM money_movements m JOIN money_month_locks k ON k.locked AND date_trunc('month', m.entry_date) = k.month
  WHERE GREATEST(m.created_at, COALESCE(m.updated_at, m.created_at)) > k.locked_at;
  INSERT INTO t_h (chk, cnt, amount, examples) VALUES ('Money movements in a locked month added / changed after the lock', v_cnt, v_amt, v_ex);
  SELECT count(*) INTO v_cnt FROM money_month_locks WHERE locked;
  INSERT INTO t_h (chk, cnt) VALUES ('Locked months', v_cnt);
  FOR r IN SELECT type, count(*) AS n, -sum(amount) AS amt FROM money_movements
           WHERE v_start IS NOT NULL AND entry_date < v_start AND type <> 'opening_balance' GROUP BY type LOOP
    INSERT INTO t_h (chk, cnt, amount, note) VALUES ('Before the start date (ignored by Money / Reports): ' || r.type, r.n, r.amt,
      'Left out of every profit number, while sales before the start date are counted.');
  END LOOP;
  SELECT count(*), COALESCE(sum(cost_bdt), 0) INTO v_cnt, v_amt FROM stock_write_offs WHERE v_start IS NOT NULL AND write_date < v_start;
  INSERT INTO t_h (chk, cnt, amount, note) VALUES ('Write-offs before the start date (these DO count in profit)', v_cnt, v_amt,
    'money_profit_parts does not apply the start date to write-offs.');
  SELECT count(*), COALESCE(sum(s.sale - s.cost + s.delivery - s.courier), 0), string_agg(s.order_number, ', ')
  INTO v_cnt, v_amt, v_ex
  FROM (SELECT (e ->> 'sale')::numeric AS sale, (e ->> 'cost')::numeric AS cost, (e ->> 'delivery')::numeric AS delivery,
               (e ->> 'courier')::numeric AS courier, e ->> 'order_number' AS order_number
        FROM jsonb_array_elements(inventory_sales_profit_core('2024-01-01', v_today, true) -> 'orders') e
        WHERE NOT (e ->> 'costed')::boolean AND e ->> 'status' = 'delivered') s;
  INSERT INTO t_h (chk, cnt, amount, examples, note) VALUES ('Delivered orders left OUT of Money profit (placed before the start, not from lots)', v_cnt, v_amt,
    left(v_ex, 80), 'amount = the profit they make on the Sales profit page.');

  -- 6. Books balance check today.
  v_pos := money_position();
  INSERT INTO t_h (chk, amount, note) VALUES ('Books balance check: difference today', (v_pos ->> 'difference')::numeric,
    format('net worth ৳%s, expected ৳%s, first wrong %s', v_pos ->> 'net_worth', v_pos ->> 'expected', COALESCE(v_pos ->> 'first_wrong', '-')));
  SELECT string_agg(to_char(check_date, 'DD Mon') || ' ' || difference, ', ' ORDER BY check_date) INTO v_ex
  FROM (SELECT * FROM money_check_log ORDER BY check_date DESC LIMIT 10) c;
  INSERT INTO t_h (chk, examples) VALUES ('Balance check history (last 10 days)', v_ex);

  -- 7. The same period on the dashboard, Reports and Sales profit.
  FOR r IN SELECT * FROM (VALUES ('Today', v_today, v_today),
                                 ('This month', date_trunc('month', v_today)::date, v_today),
                                 ('This year', date_trunc('year', v_today)::date, v_today),
                                 ('All time', DATE '2024-01-01', v_today)) p(name, f, t) LOOP
    v_a := money_profit_parts(r.f, r.t);
    v_b := report_profit_loss(r.f, r.t) -> 'parts';
    v_c := inventory_sales_profit(r.f, r.t) -> 'totals';
    INSERT INTO t_h (chk, amount, note) VALUES ('Profit — ' || r.name || ': dashboard Net profit', (v_a ->> 'net_profit')::numeric,
      format('Reports P&L net ৳%s (old Kaarbar profit ৳%s) · Sales profit page ৳%s · expenses counted ৳%s · orders on dashboard %s vs Sales profit %s',
             v_b ->> 'net_profit', v_b ->> 'old_profit', v_c ->> 'profit', v_a ->> 'expenses', v_a ->> 'orders', v_c ->> 'orders'));
  END LOOP;

  -- 8. Other.
  SELECT count(*), COALESCE(sum(share_year - share_all), 0), string_agg(name, ', ')
  INTO v_cnt, v_amt, v_ex
  FROM money_to_give_rows() WHERE kind = 'investor' AND share_year <> share_all AND share_year > share_all;
  INSERT INTO t_h (chk, cnt, amount, examples, note) VALUES ('Investors whose profit share "this year" is MORE than "all time"', v_cnt, v_amt, v_ex,
    'share_month / share_year do not apply the start date; share_all does.');
  SELECT count(*), COALESCE(sum(l.line_total), 0) INTO v_cnt, v_amt
  FROM kaarbar_bills b JOIN kaarbar_bill_lines l ON l.bill_id = b.id JOIN kaarbar_items i ON i.id = l.item_id
  WHERE kaarbar_line_unit_cost(i, l.unit) IS NULL;
  INSERT INTO t_h (chk, cnt, amount, note) VALUES ('Old Kaarbar bill lines with no cost (counted at ৳0 cost in Reports)', v_cnt, v_amt,
    'amount = their sales, counted as 100% profit.');
  SELECT count(*), COALESCE(sum(bill_total), 0) INTO v_cnt, v_amt FROM kaarbar_bills;
  INSERT INTO t_h (chk, cnt, amount, note) VALUES ('Old Kaarbar bills on the site (all of them are in Reports P&L)', v_cnt, v_amt,
    (SELECT string_agg(kind || ' ' || row_count, ', ') FROM kaarbar_imports WHERE undone_at IS NULL));
END
$health$;

SELECT json_agg(json_build_object('check', chk, 'count', cnt, 'amount', amount, 'examples', examples, 'note', note) ORDER BY n)::text AS health
FROM t_h;
ROLLBACK;
