-- ============================================================
-- Migration 062 — Batch 65: note to customer + "Customer paid delivery
-- charge" on returns
-- ============================================================
-- PART 1 — Note to customer
--  * orders.note_to_customer (+ when it was sent, when she saw it).
--  * admin_set_note_to_customer(): staff with "Change order status" (the
--    same switch the order page uses for the private note) write it.
--    Empty removes it. An edited note counts as new (seen is cleared).
--  * my_unseen_order_note() / mark_order_note_seen(): the customer's own
--    orders only, by the rule My Orders uses (customer_id = her login;
--    Batch 47 sets customer_id on orders cut for her account).
--
-- PART 2 — Customer paid delivery charge on a return
--  * orders.return_delivery_paid: money the customer paid when the
--    parcel came back. It counts as delivery collected on the returned
--    order (money_order_parts_for, order_profit), so the courier loss
--    shrinks by it on the day the order was marked returned.
--  * Where the money is (money_ledger, new line "return_delivery"):
--    booked on Steadfast → With Steadfast (it arrives in a payout, like
--    collected COD); otherwise → Cash, on the day it was marked returned.
--    So Money's balance check still matches.
--  * admin_mark_order_returned / admin_mark_order_returned_damaged take
--    an optional last argument p_customer_paid_delivery (default 0);
--    old callers work unchanged.
--  * admin_set_return_delivery_paid(): correct it later.
--
-- Old returned orders all get 0, so nothing changes for them.
-- Safe to run more than once.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------------
-- 1. Columns
-- ------------------------------------------------------------------
ALTER TABLE orders ADD COLUMN IF NOT EXISTS note_to_customer          text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS note_to_customer_at       timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS note_to_customer_seen_at  timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS return_delivery_paid      numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_note_to_customer_len;
ALTER TABLE orders ADD CONSTRAINT orders_note_to_customer_len CHECK (note_to_customer IS NULL OR char_length(note_to_customer) <= 500);
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_return_delivery_paid_ok;
ALTER TABLE orders ADD CONSTRAINT orders_return_delivery_paid_ok CHECK (return_delivery_paid >= 0);

-- Customers read their own orders (orders_read_own) and have no UPDATE
-- rule on orders, so they can read the note but never write these
-- columns. Staff write them only through the functions below.

-- ------------------------------------------------------------------
-- 2. Note to customer
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION admin_set_note_to_customer(p_order_id uuid, p_note text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_text   text := btrim(COALESCE(p_note, ''));
  v_number text;
BEGIN
  IF NOT staff_can('change_order_status') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF char_length(v_text) > 500 THEN
    RAISE EXCEPTION 'A note can be at most 500 characters.';
  END IF;
  SELECT order_number INTO v_number FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;
  IF v_text = '' THEN
    UPDATE orders
    SET note_to_customer = NULL, note_to_customer_at = NULL, note_to_customer_seen_at = NULL
    WHERE id = p_order_id;
    PERFORM write_activity('order.note_to_customer', 'order', p_order_id::text, v_number,
      format('%s: note to customer removed', v_number), '{}'::jsonb);
  ELSE
    UPDATE orders
    SET note_to_customer = v_text, note_to_customer_at = now(), note_to_customer_seen_at = NULL
    WHERE id = p_order_id;
    PERFORM write_activity('order.note_to_customer', 'order', p_order_id::text, v_number,
      format('%s: note to customer sent', v_number), jsonb_build_object('note', v_text));
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION admin_set_note_to_customer(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_set_note_to_customer(uuid, text) TO authenticated;

-- The newest note on her own orders she has not seen since it was sent.
CREATE OR REPLACE FUNCTION my_unseen_order_note()
RETURNS TABLE (order_id uuid, order_number text, note text, note_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.id, o.order_number, o.note_to_customer, o.note_to_customer_at
  FROM orders o
  WHERE auth.uid() IS NOT NULL
    AND o.customer_id = auth.uid()
    AND o.note_to_customer IS NOT NULL
    AND (o.note_to_customer_seen_at IS NULL OR o.note_to_customer_seen_at < o.note_to_customer_at)
  ORDER BY o.note_to_customer_at DESC NULLS LAST, o.created_at DESC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION my_unseen_order_note() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION my_unseen_order_note() TO authenticated;

-- Seen: only her own order with a note; anything else does nothing.
CREATE OR REPLACE FUNCTION mark_order_note_seen(p_order_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE orders
  SET note_to_customer_seen_at = now()
  WHERE id = p_order_id
    AND auth.uid() IS NOT NULL
    AND customer_id = auth.uid()
    AND note_to_customer IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION mark_order_note_seen(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION mark_order_note_seen(uuid) TO authenticated;

-- ------------------------------------------------------------------
-- 3. Mark returned, with the delivery charge the customer paid
-- ------------------------------------------------------------------
-- Same body as migration-042 (Batch 39), plus p_customer_paid_delivery.
DROP FUNCTION IF EXISTS admin_mark_order_returned(uuid, text);
CREATE OR REPLACE FUNCTION admin_mark_order_returned(p_order_id uuid, p_note text DEFAULT NULL,
                                                     p_customer_paid_delivery numeric DEFAULT 0)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order orders%ROWTYPE;
  v_line  record;
BEGIN
  IF NOT staff_can('change_order_status') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;
  IF v_order.status NOT IN ('shipped', 'delivered') THEN
    RAISE EXCEPTION 'Only an order that was sent (In transit or Delivered) can be marked returned.';
  END IF;

  IF NOT v_order.stock_released AND NOT inventory_mode_on() THEN
    PERFORM set_config('app.order_stock_change', 'on', true);
    FOR v_line IN SELECT * FROM order_items WHERE order_id = p_order_id AND sold_unit IS NULL LOOP
      IF v_line.variant_id IS NOT NULL THEN
        UPDATE product_variants SET stock_quantity = stock_quantity + v_line.quantity
          WHERE id = v_line.variant_id AND stock_quantity IS NOT NULL;
      ELSIF v_line.product_id IS NOT NULL THEN
        UPDATE products SET stock_quantity = stock_quantity + v_line.quantity
          WHERE id = v_line.product_id AND stock_quantity IS NOT NULL;
      END IF;
    END LOOP;
    PERFORM set_config('app.order_stock_change', 'off', true);
  END IF;

  UPDATE orders
  SET status = 'returned', stock_released = true, updated_at = now(),
      return_delivery_paid = GREATEST(COALESCE(p_customer_paid_delivery, 0), 0)
  WHERE id = p_order_id;
  INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, note)
  VALUES (p_order_id, v_order.status, 'returned', auth.uid(), NULLIF(btrim(COALESCE(p_note, '')), ''));
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION admin_mark_order_returned(uuid, text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_mark_order_returned(uuid, text, numeric) TO authenticated;

-- Same body as migration-043 (Batch 41), plus p_customer_paid_delivery.
DROP FUNCTION IF EXISTS admin_mark_order_returned_damaged(uuid, text, jsonb);
CREATE OR REPLACE FUNCTION admin_mark_order_returned_damaged(p_order_id uuid, p_note text, p_damaged jsonb,
                                                             p_customer_paid_delivery numeric DEFAULT 0)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_d     jsonb;
  v_item  order_items%ROWTYPE;
  v_units integer;
  v_rows  jsonb;
  v_back  integer;
BEGIN
  IF COALESCE(jsonb_array_length(COALESCE(p_damaged, '[]'::jsonb)), 0) > 0 THEN
    IF NOT money_can_view() THEN
      RAISE EXCEPTION 'Only someone with "View profit & costs" can mark items damaged.';
    END IF;
    IF NOT inventory_mode_on() THEN
      RAISE EXCEPTION 'Damaged returns work only while Inventory mode is On.';
    END IF;
  END IF;

  PERFORM admin_mark_order_returned(p_order_id, p_note, p_customer_paid_delivery);

  FOR v_d IN SELECT * FROM jsonb_array_elements(COALESCE(p_damaged, '[]'::jsonb)) LOOP
    v_units := (v_d ->> 'units')::integer;
    CONTINUE WHEN v_units IS NULL OR v_units <= 0;
    SELECT * INTO v_item FROM order_items WHERE id = (v_d ->> 'order_item_id')::uuid AND order_id = p_order_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Item not found on this order.';
    END IF;
    SELECT COALESCE(sum(g.units), 0)::integer,
           COALESCE(jsonb_agg(jsonb_build_object('lot_item_id', g.lot_item_id, 'units', g.units, 'unit_cost', g.unit_cost)
                              ORDER BY g.last_seq DESC), '[]'::jsonb)
    INTO v_back, v_rows
    FROM (
      SELECT lot_item_id, sum(units_back) AS units, sum(units_back * unit_cost_bdt) / sum(units_back) AS unit_cost,
             max(seq) AS last_seq
      FROM order_item_lots WHERE order_item_id = v_item.id AND units_back > 0
      GROUP BY lot_item_id
    ) g;
    v_units := v_units * inventory_item_factor(v_item);
    IF v_units > v_back THEN
      RAISE EXCEPTION '"%": only % units came back from lots.', v_item.product_name, v_back;
    END IF;
    PERFORM money_write_off_units(v_item.product_id, v_item.variant_id, v_units, 'damaged_return',
      NULLIF(btrim(COALESCE(p_note, '')), ''), NULL, p_order_id, v_rows);
  END LOOP;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION admin_mark_order_returned_damaged(uuid, text, jsonb, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_mark_order_returned_damaged(uuid, text, jsonb, numeric) TO authenticated;

-- Correct the amount later (returned orders only). A returned order
-- counted in a locked month posts the change today (money_lock_sync_order).
CREATE OR REPLACE FUNCTION admin_set_return_delivery_paid(p_order_id uuid, p_amount numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order  orders%ROWTYPE;
  v_amount numeric := round(COALESCE(p_amount, 0), 2);
BEGIN
  IF NOT staff_can('change_order_status') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF v_amount < 0 THEN
    RAISE EXCEPTION 'The amount cannot be below 0.';
  END IF;
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;
  IF v_order.status <> 'returned' THEN
    RAISE EXCEPTION 'Only a returned order has a delivery charge paid on return.';
  END IF;
  IF v_order.return_delivery_paid = v_amount THEN
    RETURN;
  END IF;
  UPDATE orders SET return_delivery_paid = v_amount, updated_at = now() WHERE id = p_order_id;
  PERFORM money_lock_sync_order(p_order_id);
  PERFORM write_activity('order.return_delivery_paid', 'order', p_order_id::text, v_order.order_number,
    format('%s: delivery charge paid on return changed from %s to %s', v_order.order_number,
           taka_text(v_order.return_delivery_paid), taka_text(v_amount)),
    jsonb_build_object('amount', jsonb_build_object('from', v_order.return_delivery_paid, 'to', v_amount)));
END;
$$;

REVOKE ALL ON FUNCTION admin_set_return_delivery_paid(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_set_return_delivery_paid(uuid, numeric) TO authenticated;

-- ------------------------------------------------------------------
-- 4. Profit: the paid charge is delivery collected on the returned order
-- ------------------------------------------------------------------
-- Same as migration-058, except: a returned order's delivery is what the
-- customer paid on return (0 for every older return).
CREATE OR REPLACE FUNCTION money_order_parts_for(p_ids uuid[])
 RETURNS TABLE(order_id uuid, order_number text, status text, counts boolean, counted_at timestamptz,
               sale numeric, discount numeric, delivery numeric, courier numeric, courier_known boolean,
               courier_kind text, cost numeric, provisional numeric, costed boolean, items_missing integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH base AS (
    SELECT o.id, o.order_number, o.status, o.discount,
           (o.status IN ('delivered', 'returned') OR (o.status = 'cancelled' AND cc.order_id IS NOT NULL)) AS counts,
           -- A cancelled order Steadfast charged for counts the charge on the payout's date.
           COALESCE(inventory_order_counted_at(o.id, o.status), CASE WHEN o.status = 'cancelled' THEN cc.paid_at END) AS at,
           CASE WHEN o.status = 'delivered' THEN GREATEST(o.subtotal - o.discount, 0) ELSE 0 END AS sale,
           -- Batch 65: on a return, what the customer paid for delivery.
           CASE WHEN o.status = 'delivered' THEN o.delivery_fee
                WHEN o.status = 'returned' THEN o.return_delivery_paid
                ELSE 0 END AS delivery,
           COALESCE(cc.total_kept, 0) AS kept,
           cc.order_id IS NOT NULL AS known
    FROM orders o
    LEFT JOIN order_courier_costs cc ON cc.order_id = o.id
    WHERE o.id = ANY (p_ids)
  ), items AS (
    SELECT c.order_id, sum(c.cost) AS cost, sum(c.provisional) AS prov, bool_and(c.costed) AS costed,
           (count(*) FILTER (WHERE NOT c.costed))::integer AS missing
    FROM inventory_item_costs(p_ids) c
    GROUP BY c.order_id
  )
  SELECT b.id, b.order_number, b.status, b.counts, b.at, b.sale, b.discount, b.delivery,
         CASE WHEN b.status = 'delivered' THEN COALESCE(k.amount, 0) ELSE b.kept END,
         b.known OR k.kind = 'none',
         CASE WHEN b.status = 'delivered' OR b.known OR k.kind IN ('none', 'not_booked') THEN k.kind ELSE 'unknown' END,
         CASE WHEN b.status = 'delivered' THEN COALESCE(i.cost, 0) ELSE 0 END,
         CASE WHEN b.status = 'delivered' THEN COALESCE(i.prov, 0) ELSE 0 END,
         COALESCE(i.costed, false),
         CASE WHEN b.status = 'delivered' THEN COALESCE(i.missing, 0) ELSE 0 END
  FROM base b
  LEFT JOIN items i ON i.order_id = b.id
  LEFT JOIN order_courier_costs_for(p_ids) k ON k.order_id = b.id;
$function$;
REVOKE ALL ON FUNCTION money_order_parts_for(uuid[]) FROM PUBLIC, anon, authenticated;

-- The order's Profit card. Same as migration-058, plus
-- return_delivery_paid (a returned order's "Delivery charge paid on
-- return"), which is in its profit.
CREATE OR REPLACE FUNCTION order_profit(p_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order    orders%ROWTYPE;
  v_courier  order_courier_costs%ROWTYPE;
  v_known    boolean;
  v_sale     numeric;
  v_cost     numeric;
  v_prov     numeric;
  v_costed   boolean;
  v_missing  integer;
  v_delivery numeric;
  v_kept     numeric;
  v_profit   numeric;
  v_filled   numeric;
  v_cc       record;
  v_ret_paid numeric := 0;
BEGIN
  IF NOT staff_can('view_profit_costs') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;
  SELECT * INTO v_courier FROM order_courier_costs WHERE order_id = p_order_id;
  v_known := FOUND;
  -- Batch 53: the courier cost and how sure it is (order_courier_costs_for).
  SELECT * INTO v_cc FROM order_courier_costs_for(ARRAY[p_order_id]);

  SELECT COALESCE(sum(c.cost), 0), COALESCE(sum(c.provisional), 0), COALESCE(bool_and(c.costed), false),
         (count(*) FILTER (WHERE NOT c.costed))::integer
  INTO v_cost, v_prov, v_costed, v_missing
  FROM inventory_item_costs(ARRAY[p_order_id]) c;

  SELECT COALESCE(sum(amount_bdt), 0) INTO v_filled
  FROM cost_adjustments WHERE order_id = p_order_id AND reason IN ('shortfall_filled', 'given_back');

  IF v_order.status IN ('cancelled', 'returned') THEN
    v_sale := 0; v_cost := 0; v_prov := 0; v_delivery := 0; v_missing := 0;
    v_kept := CASE WHEN v_known THEN v_courier.total_kept ELSE 0 END;
    IF v_order.status = 'returned' THEN
      v_ret_paid := v_order.return_delivery_paid;
    END IF;
  ELSE
    v_sale := GREATEST(v_order.subtotal - v_order.discount, 0);
    v_delivery := v_order.delivery_fee;
    v_kept := COALESCE(v_cc.amount, 0);
  END IF;
  v_profit := v_sale - v_cost + v_delivery + v_ret_paid - v_kept;

  RETURN jsonb_build_object(
    'status', v_order.status,
    'costed', v_costed OR v_order.status IN ('cancelled', 'returned'),
    'items_missing_cost', v_missing,
    'sale', v_sale,
    'cost', v_cost,
    'provisional', v_prov,
    'delivery', v_delivery,
    'return_delivery_paid', v_ret_paid,
    'courier', v_kept,
    'courier_known', v_known OR v_cc.kind = 'none',
    'courier_kind', CASE WHEN v_order.status IN ('cancelled', 'returned') AND NOT v_known
                         THEN CASE WHEN v_cc.kind IN ('none', 'not_booked') THEN v_cc.kind ELSE 'unknown' END
                         ELSE v_cc.kind END,
    'courier_charge', COALESCE(v_cc.delivery_bill, 0),
    'cod_fee', COALESCE(v_cc.cod_fee, 0),
    'bill_paid_separately', CASE WHEN v_known THEN v_courier.bill_paid_separately ELSE 0 END,
    'profit', v_profit,
    'margin', CASE WHEN v_sale > 0 THEN round(v_profit / v_sale * 100, 1) END,
    'counted_at', COALESCE(inventory_order_counted_at(p_order_id, v_order.status),
                           CASE WHEN v_order.status = 'cancelled' AND v_known THEN v_courier.paid_at END),
    'filled_adjustments', v_filled
  );
END;
$function$;

-- ------------------------------------------------------------------
-- 5. Where the money is: the account ledger
-- ------------------------------------------------------------------
-- Same as migration-060, plus one line per returned order whose customer
-- paid the delivery charge: into With Steadfast when the parcel was booked
-- on Steadfast (the payout takes it out again, like collected COD), else
-- into Cash; dated the day the order was marked returned (the same moment
-- its profit counts). The date is worked out here, not with
-- inventory_order_counted_at(), because this view's readers may not call
-- that function.
CREATE OR REPLACE VIEW money_ledger AS
 SELECT source,
    source_id,
    entry_date,
    account_id,
    amount,
    type,
    category_id,
    party_id,
    supplier_id,
    lot_id,
    order_id,
    payout_id,
    note,
    reference,
    created_by_username,
    created_at
   FROM ( SELECT 'movement'::text AS source,
            (m.id)::text AS source_id,
            m.entry_date,
            m.account_id,
            m.amount,
            m.type,
            m.category_id,
            m.party_id,
            m.supplier_id,
            m.lot_id,
            m.order_id,
            m.payout_id,
            m.note,
            m.reference,
            m.created_by_username,
            m.created_at
           FROM money_movements m
          WHERE ((money_start_date() IS NULL) OR (m.entry_date >= money_start_date()))
        UNION ALL
         SELECT 'payout_out'::text AS text,
            (m.id)::text AS id,
            m.entry_date,
            money_steadfast_account() AS money_steadfast_account,
            (- m.amount),
            'steadfast_payout_out'::text AS text,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            m.payout_id,
            m.note,
            m.reference,
            m.created_by_username,
            m.created_at
           FROM money_movements m
          WHERE ((m.type = 'steadfast_payout_in'::text) AND ((money_start_date() IS NULL) OR (m.entry_date >= money_start_date())))
        UNION ALL
         SELECT 'payment'::text AS text,
            (p.id)::text AS id,
            ((p.paid_at AT TIME ZONE 'Asia/Dhaka'::text))::date AS timezone,
            money_account_for_method(p.method) AS money_account_for_method,
                CASE
                    WHEN (p.kind = 'refund'::text) THEN (- p.amount)
                    ELSE p.amount
                END AS amount,
                CASE
                    WHEN (p.kind = 'refund'::text) THEN 'customer_refund'::text
                    ELSE 'customer_payment'::text
                END AS "case",
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            p.order_id,
            NULL::uuid AS uuid,
            p.note,
            o.order_number,
            p.created_by_username,
            p.created_at
           FROM (order_payments p
             JOIN orders o ON ((o.id = p.order_id)))
          WHERE (p.method <> 'store_wallet'::text) AND ((money_start_date() IS NULL) OR (p.paid_at >= money_start_ts()))
        UNION ALL
         SELECT 'due_payment'::text AS text,
            (d.id)::text AS id,
            d.paid_date,
            d.account_id,
            d.amount,
            'previous_balance_payment'::text AS text,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            d.note,
            d.phone_key,
            d.created_by_username,
            d.created_at
           FROM customer_due_payments d
          WHERE ((money_start_date() IS NULL) OR (d.paid_date >= money_start_date()))
        UNION ALL
         SELECT 'store_wallet'::text AS text,
            (w.id)::text AS id,
            w.entry_date,
            w.account_id,
            w.amount,
            'store_wallet_in'::text AS text,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            w.note,
            customer_name_for_key(store_wallet_owner(w.customer_key)) AS reference,
            w.created_by_username,
            w.created_at
           FROM store_wallet_entries w
          WHERE (w.kind = 'added'::text) AND (w.account_id IS NOT NULL)
            AND ((money_start_date() IS NULL) OR (w.entry_date >= money_start_date()))
        UNION ALL
         SELECT 'payout_fees'::text AS text,
            (i.id)::text AS id,
            ((sp.paid_at AT TIME ZONE 'Asia/Dhaka'::text))::date AS timezone,
            money_steadfast_account() AS money_steadfast_account,
            (- ((i.delivery_charge + i.cod_fee) + i.other_deduction)),
            'courier_fees'::text AS text,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            i.order_id,
            sp.id,
            NULL::text AS text,
            o.order_number,
            'steadfast'::text AS text,
            sp.last_synced_at
           FROM ((steadfast_payout_items i
             JOIN steadfast_payouts sp ON ((sp.id = i.payout_id)))
             JOIN orders o ON ((o.id = i.order_id)))
          WHERE ((((i.delivery_charge + i.cod_fee) + i.other_deduction) <> (0)::numeric) AND ((money_start_date() IS NULL) OR ((sp.paid_at >= money_start_ts()) AND (COALESCE(( SELECT max(h.changed_at) AS max
                   FROM order_status_history h
                  WHERE ((h.order_id = o.id) AND (h.new_status = ANY (ARRAY['delivered'::text, 'returned'::text])))), o.created_at) >= money_start_ts()))))
        UNION ALL
         SELECT 'payout_unmatched'::text AS text,
            (i.id)::text AS id,
            ((sp.paid_at AT TIME ZONE 'Asia/Dhaka'::text))::date AS timezone,
            money_steadfast_account() AS money_steadfast_account,
            i.net_paid,
            'steadfast_unmatched'::text AS text,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            sp.id,
            COALESCE(i.invoice, i.consignment_id) AS "coalesce",
            NULL::text AS text,
            'steadfast'::text AS text,
            sp.last_synced_at
           FROM (steadfast_payout_items i
             JOIN steadfast_payouts sp ON ((sp.id = i.payout_id)))
          WHERE ((i.order_id IS NULL) AND (i.line_kind = 'order'::text) AND (i.net_paid <> (0)::numeric) AND (money_start_date() IS NOT NULL) AND (sp.paid_at >= money_start_ts()))
        UNION ALL
         SELECT 'payout_settled'::text AS text,
            (i.id)::text AS id,
            ((sp.paid_at AT TIME ZONE 'Asia/Dhaka'::text))::date AS timezone,
            money_steadfast_account() AS money_steadfast_account,
                CASE
                    WHEN (i.line_kind = 'returned'::text) THEN (- ((i.delivery_charge + i.cod_fee) + i.other_deduction))
                    ELSE i.net_paid
                END AS amount,
                CASE
                    WHEN (i.line_kind = 'returned'::text) THEN 'courier_fees'::text
                    ELSE 'steadfast_courier_only'::text
                END AS "case",
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            sp.id,
            i.note,
            COALESCE(i.invoice, i.consignment_id) AS "coalesce",
            'steadfast'::text AS text,
            sp.last_synced_at
           FROM (steadfast_payout_items i
             JOIN steadfast_payouts sp ON ((sp.id = i.payout_id)))
          WHERE ((i.order_id IS NULL) AND (i.line_kind <> 'order'::text) AND (i.net_paid <> (0)::numeric) AND (money_start_date() IS NOT NULL) AND (sp.paid_at >= money_start_ts()))
        UNION ALL
         SELECT 'return_delivery'::text AS text,
            (o.id)::text AS id,
            ((r.at AT TIME ZONE 'Asia/Dhaka'::text))::date AS timezone,
                CASE
                    WHEN (o.steadfast_consignment_id IS NOT NULL) THEN money_steadfast_account()
                    ELSE money_account_for_method('cash'::text)
                END AS account_id,
            o.return_delivery_paid,
            'return_delivery_paid'::text AS text,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            o.id,
            NULL::uuid AS uuid,
            NULL::text AS text,
            o.order_number,
            NULL::text AS text,
            r.at
           FROM (orders o
             CROSS JOIN LATERAL ( SELECT COALESCE(( SELECT max(h.changed_at) AS max
                           FROM order_status_history h
                          WHERE ((h.order_id = o.id) AND (h.new_status = 'returned'::text) AND (h.old_status IS DISTINCT FROM 'returned'::text))), o.updated_at) AS at) r)
          WHERE ((o.status = 'returned'::text) AND (o.return_delivery_paid > (0)::numeric) AND ((money_start_date() IS NULL) OR (r.at >= money_start_ts())))) ledger
  WHERE money_can_view();

-- The new ledger line's name (same list as migration-060, plus one).
CREATE OR REPLACE FUNCTION money_type_label(p_type text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT CASE p_type
    WHEN 'opening_balance' THEN 'Opening balance'
    WHEN 'expense' THEN 'Expense'
    WHEN 'transfer_out' THEN 'Moved out'
    WHEN 'transfer_in' THEN 'Moved in'
    WHEN 'investor_in' THEN 'Investor money in'
    WHEN 'investor_profit_share' THEN 'Investor profit share'
    WHEN 'investor_capital_back' THEN 'Investor capital returned'
    WHEN 'owner_withdrawal' THEN 'My withdrawal'
    WHEN 'owner_money_in' THEN 'My money put in'
    WHEN 'non_business_in' THEN 'Not shop money in'
    WHEN 'non_business_out' THEN 'Not shop money out'
    WHEN 'supplier_payment' THEN 'Paid what I owe'
    WHEN 'steadfast_payout_in' THEN 'Steadfast payout'
    WHEN 'adjustment' THEN 'Count difference'
    WHEN 'lot_payment' THEN 'Paid for a lot'
    WHEN 'courier_bill_payment' THEN 'Steadfast bill paid'
    WHEN 'customer_payment' THEN 'Customer payment'
    WHEN 'customer_refund' THEN 'Refund to customer'
    WHEN 'previous_balance_payment' THEN 'Previous balance paid'
    WHEN 'store_wallet_in' THEN 'Added to a customer wallet'
    WHEN 'steadfast_payout_out' THEN 'Paid out by Steadfast'
    WHEN 'courier_fees' THEN 'Courier & COD fees (in order profit)'
    WHEN 'steadfast_unmatched' THEN 'Steadfast parcel not matched to an order'
    WHEN 'steadfast_courier_only' THEN 'Courier only, not a shop sale'
    WHEN 'return_delivery_paid' THEN 'Delivery charge paid on return'
    ELSE p_type
  END;
$function$;

-- The website reads the new function arguments at once.
NOTIFY pgrst, 'reload schema';

COMMIT;
