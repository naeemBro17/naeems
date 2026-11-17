-- ============================================================
-- migration-047 — Batch 46: Steadfast payouts add up, and promo codes
-- count only real orders (version 1.46.0, reports/batch-46.txt).
--
--   PART 1  Backups of every row this script changes:
--           _b46_backup_payout_lines, _b46_backup_order_payments,
--           _b46_backup_promo_codes (staff-only, nobody else can read them).
--   PART 2  Payout lines get a "kind": 'order' (normal), 'courier_only'
--           (a parcel that was not a shop sale) or 'returned' (a returned
--           parcel whose order was deleted). A settled line keeps its kind
--           and status when Steadfast is read again.
--   PART 3  When Steadfast collected a different COD than the order's
--           "COD via Steadfast" payment says, the payment is set to what
--           Steadfast really collected (the payout is the proof), and the
--           line becomes Matched.
--   PART 4  Data: payout SFC-27728657 (14 Jan 2026) — a parcel Steadfast
--           returned was counted as ৳1,120 collected; NM-3315 settled as
--           courier only; NM-1721 settled as a returned parcel; the COD
--           payments of NM-3327 and NM-3329 set to what Steadfast collected.
--   PART 5  Money and profit: a returned parcel without an order counts its
--           charge with the other courier charges; a cancelled order's
--           courier charge counts too; a courier-only line is never a sale
--           and never a loss.
--   PART 6  Promo codes: only placing an order counts a use (inside
--           place_order, as before); nobody can call the counter directly
--           any more; cancelling or deleting the order gives the use back;
--           every code is recounted from the real orders.
--
-- Safe to run more than once: every change is "set to", never "add to".
-- ============================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- PART 1 — backups (only rows not backed up yet; a second run adds nothing)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS _b46_backup_payout_lines AS
  SELECT id, payout_id, item_key, consignment_id, invoice, order_id, cod_collected, delivery_charge, cod_fee,
         other_deduction, net_paid, expected_cod, fee_estimated, match_status, match_reason, note, raw, created_at,
         now() AS backed_up_at
  FROM steadfast_payout_items WITH NO DATA;

CREATE TABLE IF NOT EXISTS _b46_backup_order_payments AS
  SELECT p.*, now() AS backed_up_at FROM order_payments p WITH NO DATA;

CREATE TABLE IF NOT EXISTS _b46_backup_promo_codes AS
  SELECT c.*, now() AS backed_up_at FROM promo_codes c WITH NO DATA;

ALTER TABLE _b46_backup_payout_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE _b46_backup_order_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE _b46_backup_promo_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON _b46_backup_payout_lines, _b46_backup_order_payments, _b46_backup_promo_codes FROM anon, authenticated;

INSERT INTO _b46_backup_payout_lines
SELECT i.id, i.payout_id, i.item_key, i.consignment_id, i.invoice, i.order_id, i.cod_collected, i.delivery_charge,
       i.cod_fee, i.other_deduction, i.net_paid, i.expected_cod, i.fee_estimated, i.match_status, i.match_reason,
       i.note, i.raw, i.created_at, now()
FROM steadfast_payout_items i
JOIN steadfast_payouts p ON p.id = i.payout_id
WHERE (p.steadfast_payment_id = 'SFC-27728657'
       OR upper(trim(i.invoice)) IN ('NM-3315', 'NM-1721')
       OR i.match_reason = 'cod_differs')
  AND NOT EXISTS (SELECT 1 FROM _b46_backup_payout_lines b WHERE b.id = i.id);

INSERT INTO _b46_backup_order_payments
SELECT op.*, now()
FROM order_payments op
WHERE op.source = 'steadfast_cod'
  AND op.order_id IN (SELECT i.order_id FROM steadfast_payout_items i WHERE i.match_reason = 'cod_differs' AND i.order_id IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM _b46_backup_order_payments b WHERE b.id = op.id);

INSERT INTO _b46_backup_promo_codes
SELECT c.*, now()
FROM promo_codes c
WHERE NOT EXISTS (SELECT 1 FROM _b46_backup_promo_codes b WHERE b.id = c.id);

-- ---------------------------------------------------------------------------
-- PART 2 — the kind of a payout line
-- ---------------------------------------------------------------------------
ALTER TABLE steadfast_payout_items ADD COLUMN IF NOT EXISTS line_kind text NOT NULL DEFAULT 'order';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'steadfast_payout_items_line_kind_check') THEN
    ALTER TABLE steadfast_payout_items ADD CONSTRAINT steadfast_payout_items_line_kind_check
      CHECK (line_kind IN ('order', 'courier_only', 'returned'));
  END IF;
END $$;

-- PART 2 + 3 — one guard on every payout line, whoever writes it (the
-- Steadfast functions, old or new, or this script).
CREATE OR REPLACE FUNCTION steadfast_payout_item_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pay   order_payments%ROWTYPE;
  v_order orders%ROWTYPE;
  v_text  text;
BEGIN
  -- A settled line (courier only / returned) keeps its settlement when
  -- Steadfast is read again; only a deliberate change of kind changes it.
  IF TG_OP = 'UPDATE' AND OLD.line_kind <> 'order' AND NEW.line_kind = OLD.line_kind THEN
    NEW.order_id := OLD.order_id;
    NEW.match_status := OLD.match_status;
    NEW.match_reason := OLD.match_reason;
    NEW.note := OLD.note;
    RETURN NEW;
  END IF;

  -- Steadfast collected a different COD than the order's "COD via
  -- Steadfast" payment says: the payment becomes what was collected.
  IF NEW.line_kind = 'order' AND NEW.order_id IS NOT NULL AND NEW.match_reason = 'cod_differs'
     AND NEW.cod_collected > 0 THEN
    SELECT * INTO v_pay FROM order_payments
    WHERE order_id = NEW.order_id AND source = 'steadfast_cod' AND kind = 'payment';
    IF FOUND THEN
      v_text := format('Steadfast collected %s (booked %s); the order''s "COD via Steadfast" payment is %s',
                       taka_text(NEW.cod_collected), taka_text(COALESCE(NEW.expected_cod, v_pay.amount)),
                       taka_text(NEW.cod_collected));
      IF v_pay.amount = NEW.cod_collected THEN
        NEW.match_status := 'matched';
        NEW.match_reason := NULL;
        NEW.note := v_text;
      ELSE
        BEGIN
          UPDATE order_payments
          SET amount = NEW.cod_collected, updated_at = now(), updated_by_username = 'steadfast'
          WHERE id = v_pay.id;
          SELECT * INTO v_order FROM orders WHERE id = NEW.order_id;
          PERFORM order_history_line(NEW.order_id, v_order.status,
            format('COD via Steadfast changed from %s to %s: the Steadfast payout shows %s collected',
                   taka_text(v_pay.amount), taka_text(NEW.cod_collected), taka_text(NEW.cod_collected)));
          PERFORM write_activity('order.payment_changed', 'order', NEW.order_id::text, v_order.order_number,
            format('%s: COD via Steadfast changed from %s to %s (Steadfast payout)', v_order.order_number,
                   taka_text(v_pay.amount), taka_text(NEW.cod_collected)),
            jsonb_build_object('payment_id', v_pay.id, 'amount',
                               jsonb_build_object('from', v_pay.amount, 'to', NEW.cod_collected)));
          PERFORM order_payments_sync(NEW.order_id);
          NEW.match_status := 'matched';
          NEW.match_reason := NULL;
          NEW.note := v_text;
        EXCEPTION WHEN OTHERS THEN
          -- e.g. the month is locked: the line stays "to check" with why.
          NEW.note := left(COALESCE(NEW.note, '') || ' (payment not changed: ' || SQLERRM || ')', 500);
        END;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION steadfast_payout_item_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS steadfast_payout_items_guard ON steadfast_payout_items;
CREATE TRIGGER steadfast_payout_items_guard
  BEFORE INSERT OR UPDATE ON steadfast_payout_items
  FOR EACH ROW EXECUTE FUNCTION steadfast_payout_item_guard();

-- ---------------------------------------------------------------------------
-- PART 4 — data
-- ---------------------------------------------------------------------------
-- 4a. Payout SFC-27728657 (14 Jan 2026): parcel 127690312 was returned
-- ("cancelled") by Steadfast but counted as ৳1,120 collected, and ৳1,120 of
-- invented "other charges" was spread over the other parcels to make the
-- payout add up. Recalculated with the fixed rule (the same code the
-- Steadfast sync now uses): COD ৳2,680 (Steadfast's own figure), fees
-- ৳1,353, paid ৳1,327 — unchanged.
UPDATE steadfast_payout_items i
SET cod_collected = v.cod, delivery_charge = v.dc, cod_fee = v.fee, other_deduction = v.oth, net_paid = v.net,
    fee_estimated = true,
    note = CASE WHEN v.item_key = 'c:127690312' THEN 'Returned by Steadfast: nothing collected' ELSE i.note END
FROM (VALUES
  ('c:127690312', 0, 40.61, 0, 0, -40.61),
  ('c:169071751', 60, 40.61, 0.29, 0, 19.1),
  ('c:171600158', 100, 40.61, 0.49, 0, 58.9),
  ('c:172768748', 70, 40.61, 0.34, 0, 29.05),
  ('c:174094013', 100, 40.61, 0.49, 0, 58.9),
  ('c:175432029', 10, 40.61, 0.05, 0, -30.66),
  ('c:183516117', 70, 40.61, 0.34, 0, 29.05),
  ('c:186818010', 130, 40.61, 0.63, 0, 88.76),
  ('c:186822481', 130, 40.61, 0.63, 0, 88.76),
  ('c:187653364', 70, 40.6, 0.34, 0, 29.06),
  ('c:189398579', 130, 40.6, 0.63, 0, 88.77),
  ('c:190016091', 130, 40.6, 0.63, 0, 88.77),
  ('c:190017047', 70, 40.6, 0.34, 0, 29.06),
  ('c:191696556', 110, 40.6, 0.53, 0, 68.87),
  ('c:199417148', 110, 40.6, 0.53, 0, 68.87),
  ('c:207671782', 70, 40.6, 0.34, 0, 29.06),
  ('c:207907550', 1320, 40.6, 6.4, 0, 1273)
) AS v(item_key, cod, dc, fee, oth, net)
WHERE i.item_key = v.item_key
  AND i.payout_id = (SELECT id FROM steadfast_payouts WHERE steadfast_payment_id = 'SFC-27728657');

-- 4b. NM-3315: not a shop sale (a parcel sent to a friend; Steadfast kept
-- the delivery charge and the friend paid it back). No order, no sale, no
-- loss.
UPDATE steadfast_payout_items
SET line_kind = 'courier_only', match_status = 'matched', match_reason = NULL,
    note = 'Not a shop sale: courier only (the delivery charge was paid back)'
WHERE upper(trim(invoice)) = 'NM-3315' AND order_id IS NULL;

-- 4c. NM-1721: the customer returned it; the order was deleted. No sale;
-- Steadfast's charge counts as a delivery cost.
UPDATE steadfast_payout_items
SET line_kind = 'returned', match_status = 'matched', match_reason = NULL,
    note = 'Returned parcel (order deleted): no sale; the charge counts as a delivery cost'
WHERE upper(trim(invoice)) = 'NM-1721' AND order_id IS NULL;

-- 4d. Every "COD differs" line goes through the guard once (NM-3327:
-- ৳8,935 → ৳8,930; NM-3329: ৳1,199 → ৳1,150). A line whose order has no
-- "COD via Steadfast" payment stays "to check" (NM-3301).
UPDATE steadfast_payout_items
SET match_reason = match_reason
WHERE line_kind = 'order' AND match_reason = 'cod_differs' AND order_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- PART 5 — money and profit
-- ---------------------------------------------------------------------------
-- The ledger: an unmatched line stays "not matched to an order"; a returned
-- line without an order is a courier charge; a courier-only line has its
-- own type, kept outside profit like an unmatched parcel.
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
            m.id::text AS source_id,
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
          WHERE money_start_date() IS NULL OR m.entry_date >= money_start_date()
        UNION ALL
         SELECT 'payout_out'::text,
            m.id::text AS id,
            m.entry_date,
            money_steadfast_account() AS money_steadfast_account,
            - m.amount,
            'steadfast_payout_out'::text,
            NULL::uuid,
            NULL::uuid,
            NULL::uuid,
            NULL::uuid,
            NULL::uuid,
            m.payout_id,
            m.note,
            m.reference,
            m.created_by_username,
            m.created_at
           FROM money_movements m
          WHERE m.type = 'steadfast_payout_in'::text AND (money_start_date() IS NULL OR m.entry_date >= money_start_date())
        UNION ALL
         SELECT 'payment'::text,
            p.id::text AS id,
            (p.paid_at AT TIME ZONE 'Asia/Dhaka'::text)::date AS timezone,
            money_account_for_method(p.method) AS money_account_for_method,
                CASE
                    WHEN p.kind = 'refund'::text THEN - p.amount
                    ELSE p.amount
                END AS amount,
                CASE
                    WHEN p.kind = 'refund'::text THEN 'customer_refund'::text
                    ELSE 'customer_payment'::text
                END AS "case",
            NULL::uuid,
            NULL::uuid,
            NULL::uuid,
            NULL::uuid,
            p.order_id,
            NULL::uuid,
            p.note,
            o.order_number,
            p.created_by_username,
            p.created_at
           FROM order_payments p
             JOIN orders o ON o.id = p.order_id
          WHERE money_start_date() IS NULL OR p.paid_at >= money_start_ts()
        UNION ALL
         SELECT 'due_payment'::text,
            d.id::text AS id,
            d.paid_date,
            d.account_id,
            d.amount,
            'previous_balance_payment'::text,
            NULL::uuid,
            NULL::uuid,
            NULL::uuid,
            NULL::uuid,
            NULL::uuid,
            NULL::uuid,
            d.note,
            d.phone_key,
            d.created_by_username,
            d.created_at
           FROM customer_due_payments d
          WHERE money_start_date() IS NULL OR d.paid_date >= money_start_date()
        UNION ALL
         SELECT 'payout_fees'::text,
            i.id::text AS id,
            (sp.paid_at AT TIME ZONE 'Asia/Dhaka'::text)::date AS timezone,
            money_steadfast_account() AS money_steadfast_account,
            - (i.delivery_charge + i.cod_fee + i.other_deduction),
            'courier_fees'::text,
            NULL::uuid,
            NULL::uuid,
            NULL::uuid,
            NULL::uuid,
            i.order_id,
            sp.id,
            NULL::text,
            o.order_number,
            'steadfast'::text,
            sp.last_synced_at
           FROM steadfast_payout_items i
             JOIN steadfast_payouts sp ON sp.id = i.payout_id
             JOIN orders o ON o.id = i.order_id
          WHERE (i.delivery_charge + i.cod_fee + i.other_deduction) <> 0::numeric AND (money_start_date() IS NULL OR sp.paid_at >= money_start_ts() AND COALESCE(( SELECT max(h.changed_at) AS max
                   FROM order_status_history h
                  WHERE h.order_id = o.id AND (h.new_status = ANY (ARRAY['delivered'::text, 'returned'::text]))), o.created_at) >= money_start_ts())
        UNION ALL
         SELECT 'payout_unmatched'::text,
            i.id::text AS id,
            (sp.paid_at AT TIME ZONE 'Asia/Dhaka'::text)::date AS timezone,
            money_steadfast_account() AS money_steadfast_account,
            i.net_paid,
            'steadfast_unmatched'::text,
            NULL::uuid,
            NULL::uuid,
            NULL::uuid,
            NULL::uuid,
            NULL::uuid,
            sp.id,
            COALESCE(i.invoice, i.consignment_id) AS "coalesce",
            NULL::text,
            'steadfast'::text,
            sp.last_synced_at
           FROM steadfast_payout_items i
             JOIN steadfast_payouts sp ON sp.id = i.payout_id
          WHERE i.order_id IS NULL AND i.line_kind = 'order'::text AND i.net_paid <> 0::numeric AND money_start_date() IS NOT NULL AND sp.paid_at >= money_start_ts()
        UNION ALL
         SELECT 'payout_settled'::text,
            i.id::text AS id,
            (sp.paid_at AT TIME ZONE 'Asia/Dhaka'::text)::date AS timezone,
            money_steadfast_account() AS money_steadfast_account,
                CASE
                    WHEN i.line_kind = 'returned'::text THEN - (i.delivery_charge + i.cod_fee + i.other_deduction)
                    ELSE i.net_paid
                END AS amount,
                CASE
                    WHEN i.line_kind = 'returned'::text THEN 'courier_fees'::text
                    ELSE 'steadfast_courier_only'::text
                END AS "case",
            NULL::uuid,
            NULL::uuid,
            NULL::uuid,
            NULL::uuid,
            NULL::uuid,
            sp.id,
            i.note,
            COALESCE(i.invoice, i.consignment_id) AS "coalesce",
            'steadfast'::text,
            sp.last_synced_at
           FROM steadfast_payout_items i
             JOIN steadfast_payouts sp ON sp.id = i.payout_id
          WHERE i.order_id IS NULL AND i.line_kind <> 'order'::text AND i.net_paid <> 0::numeric AND money_start_date() IS NOT NULL AND sp.paid_at >= money_start_ts()) ledger
  WHERE money_can_view();

CREATE OR REPLACE FUNCTION public.money_type_label(p_type text)
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
    WHEN 'customer_payment' THEN 'Customer payment'
    WHEN 'customer_refund' THEN 'Refund to customer'
    WHEN 'previous_balance_payment' THEN 'Previous balance paid'
    WHEN 'steadfast_payout_out' THEN 'Paid out by Steadfast'
    WHEN 'courier_fees' THEN 'Courier & COD fees (in order profit)'
    WHEN 'steadfast_unmatched' THEN 'Steadfast parcel not matched to an order'
    WHEN 'steadfast_courier_only' THEN 'Courier only, not a shop sale'
    ELSE p_type
  END;
$function$;

-- The balance check: a returned line without an order is now inside profit
-- (not "outside"); a courier-only line stays outside profit.
CREATE OR REPLACE FUNCTION public.money_position()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_start     date := money_start_date();
  v_ts        timestamptz := money_start_ts();
  v_today     date := inventory_dhaka_today();
  v_accounts  jsonb;
  v_acc_sum   numeric;
  v_sf        numeric;
  v_recv      numeric;
  v_adv       numeric;
  v_prev      numeric;
  v_stock     numeric;
  v_goods     numeric;
  v_open_val  numeric;
  v_short     numeric;
  v_give      numeric;
  v_give_inv  numeric;
  v_give_sup  numeric;
  v_give_oth  numeric;
  v_have      numeric;
  v_owe       numeric;
  v_open      jsonb;
  v_parts     jsonb;
  v_outside   numeric := 0;
  v_out_orders numeric := 0;
  v_out_fees  numeric := 0;
  v_out_unm   numeric := 0;
  v_rhs       numeric;
  v_diff      numeric;
  v_first     date;
  v_last_ok   date;
  v_sf_reported numeric;
  v_sf_at     timestamptz;
  v_unplaced  jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('account_id', b.account_id, 'name', b.name, 'kind', b.kind,
                    'archived', b.archived, 'balance', b.balance)), '[]'::jsonb),
         COALESCE(sum(b.balance) FILTER (WHERE b.kind <> 'steadfast'), 0),
         COALESCE(sum(b.balance) FILTER (WHERE b.kind = 'steadfast'), 0)
  INTO v_accounts, v_acc_sum, v_sf
  FROM money_account_balances() b;

  -- Customers (per order: owed − paid; Cancelled / Returned owe nothing).
  WITH per AS (
    SELECT o.id, o.status, o.total, money_order_costed(o.id) AS costed,
           (CASE WHEN o.status IN ('cancelled', 'returned') THEN 0 ELSE o.total END)
           - COALESCE((SELECT sum(CASE WHEN p.kind = 'refund' THEN -p.amount ELSE p.amount END)
                       FROM order_payments p WHERE p.order_id = o.id), 0) AS r
    FROM orders o
  )
  SELECT COALESCE(sum(GREATEST(r, 0)), 0), COALESCE(sum(GREATEST(-r, 0)), 0),
         COALESCE(sum(total) FILTER (WHERE costed AND status IN ('pending', 'confirmed', 'shipped')), 0)
  INTO v_recv, v_adv, v_open_val
  FROM per;

  SELECT COALESCE(sum(amount), 0) INTO v_prev FROM customer_opening_dues;
  v_prev := v_prev - COALESCE((SELECT sum(amount) FROM customer_due_payments), 0);

  SELECT COALESCE(round(sum(qty_remaining * landed_unit_cost_bdt), 2), 0) INTO v_stock FROM lot_items;

  -- Goods on orders not delivered yet (taken from lots, at their cost).
  SELECT COALESCE(round(sum((x.units - x.units_back) * x.unit_cost_bdt), 2), 0) INTO v_goods
  FROM order_item_lots x JOIN orders o ON o.id = x.order_id
  WHERE o.status IN ('pending', 'confirmed', 'shipped');

  -- Sold without stock (counted in profit at a provisional cost, not yet
  -- taken from any lot).
  SELECT COALESCE(round(sum(s.units * s.provisional_unit_cost_bdt), 2), 0) INTO v_short
  FROM stock_shortfalls s JOIN orders o ON o.id = s.order_id
  WHERE s.status = 'open' AND o.status = 'delivered';

  SELECT COALESCE(sum(owed) FILTER (WHERE kind = 'investor'), 0),
         COALESCE(sum(owed) FILTER (WHERE kind = 'supplier'), 0),
         COALESCE(sum(owed) FILTER (WHERE kind = 'other'), 0)
  INTO v_give_inv, v_give_sup, v_give_oth
  FROM money_to_give_rows();
  v_give := v_give_inv + v_give_sup + v_give_oth;

  v_have := v_acc_sum + v_sf + v_recv + v_prev + v_stock + v_goods;
  v_owe := v_give + v_adv + v_open_val + v_short;

  SELECT current_balance, balance_at INTO v_sf_reported, v_sf_at FROM steadfast_sync_state WHERE id = 1;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('payout_id', p.id, 'paid_at', p.paid_at, 'amount', p.total_amount,
                    'parcels', p.parcel_count) ORDER BY p.paid_at), '[]'::jsonb)
  INTO v_unplaced
  FROM steadfast_payouts p
  WHERE p.total_amount > 0
    AND NOT EXISTS (SELECT 1 FROM money_movements m WHERE m.payout_id = p.id)
    AND (v_start IS NULL OR p.paid_at >= v_ts);

  IF v_start IS NOT NULL THEN
    v_open := money_opening_net_worth();
    v_parts := money_profit_parts(v_start, v_today);
    -- Orders outside profit (no lot cost: placed before Inventory mode):
    -- what changed on them since the start date, and what Steadfast kept on
    -- them; parcels that match no order.
    SELECT COALESCE(sum(
             (CASE WHEN o.status IN ('cancelled', 'returned') THEN 0 ELSE o.total END)
             - CASE WHEN o.created_at >= v_ts OR money_order_status_at(o.id, v_ts) IN ('cancelled', 'returned') THEN 0
                    ELSE o.total END), 0)
    INTO v_out_orders
    FROM orders o
    WHERE NOT money_order_costed(o.id);
    SELECT COALESCE(sum(l.amount) FILTER (WHERE l.type = 'courier_fees' AND l.order_id IS NOT NULL AND NOT money_order_costed(l.order_id)), 0),
           COALESCE(sum(l.amount) FILTER (WHERE l.type IN ('steadfast_unmatched', 'steadfast_courier_only')), 0)
    INTO v_out_fees, v_out_unm
    FROM money_ledger l WHERE l.type IN ('courier_fees', 'steadfast_unmatched', 'steadfast_courier_only');
    v_outside := v_out_orders + v_out_fees + v_out_unm;

    v_rhs := (v_open ->> 'total')::numeric + (v_parts ->> 'net_profit')::numeric
             - (v_parts ->> 'profit_share')::numeric - (v_parts ->> 'withdrawals')::numeric
             + (v_parts ->> 'owner_money_in')::numeric + (v_parts ->> 'not_shop_money')::numeric
             + (v_parts ->> 'count_differences')::numeric + v_outside;
    v_diff := round((v_have - v_owe) - v_rhs, 2);

    INSERT INTO money_check_log (check_date, difference, checked_at) VALUES (v_today, v_diff, now())
    ON CONFLICT (check_date) DO UPDATE SET difference = EXCLUDED.difference, checked_at = now();
    IF abs(v_diff) > 1 THEN
      SELECT max(check_date) INTO v_last_ok FROM money_check_log WHERE abs(difference) <= 1 AND check_date < v_today;
      SELECT min(check_date) INTO v_first FROM money_check_log
      WHERE abs(difference) > 1 AND (v_last_ok IS NULL OR check_date > v_last_ok);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'start_date', v_start,
    'accounts', v_accounts,
    'accounts_total', v_acc_sum,
    'with_steadfast', v_sf,
    'steadfast_reported', v_sf_reported,
    'steadfast_reported_at', v_sf_at,
    'unplaced_payouts', v_unplaced,
    'to_receive', v_recv,
    'previous_balances', v_prev,
    'customer_advances', v_adv,
    'stock_value', v_stock,
    'goods_on_open_orders', v_goods,
    'open_orders_value', v_open_val,
    'sold_without_stock', v_short,
    'to_give', v_give,
    'to_give_investors', v_give_inv,
    'to_give_suppliers', v_give_sup,
    'to_give_others', v_give_oth,
    'have', v_have,
    'owe', v_owe,
    'net_worth', v_have - v_owe,
    'opening', v_open,
    'since_start', v_parts,
    'outside_orders', v_out_orders,
    'outside_fees', v_out_fees,
    'outside_unmatched', v_out_unm,
    'outside', v_outside,
    'expected', v_rhs,
    'difference', v_diff,
    'balanced', CASE WHEN v_start IS NULL THEN NULL ELSE abs(v_diff) <= 1 END,
    'first_wrong', v_first);
END;
$function$;

-- Sales profit: a cancelled order with a courier charge counts that charge;
-- a returned parcel without an order counts its charge on the payout date.
CREATE OR REPLACE FUNCTION public.inventory_sales_profit_core(p_from date, p_to date, p_for_money boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ids      uuid[];
  v_orders   jsonb;
  v_products jsonb;
  v_adjust   jsonb;
  v_totals   jsonb;
  v_adj_sum  numeric;
  v_ret      numeric;
  v_ret_n    integer;
BEGIN
  IF NOT staff_can('view_profit_costs') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION 'Pick a date range.';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _sp_orders (
    id uuid, order_number text, status text, counted_at timestamptz, sale numeric, discount numeric,
    delivery numeric, courier numeric, courier_known boolean, cost numeric, provisional numeric, costed boolean
  ) ON COMMIT DROP;
  TRUNCATE _sp_orders;

  INSERT INTO _sp_orders (id, order_number, status, counted_at, sale, discount, delivery, courier, courier_known)
  SELECT o.id, o.order_number, o.status, x.at,
         CASE WHEN o.status = 'delivered' THEN GREATEST(o.subtotal - o.discount, 0) ELSE 0 END,
         o.discount,
         CASE WHEN o.status = 'delivered' THEN o.delivery_fee ELSE 0 END,
         COALESCE(cc.total_kept, 0), cc.order_id IS NOT NULL
  FROM orders o
  LEFT JOIN order_courier_costs cc ON cc.order_id = o.id
  -- Batch 46: a cancelled order whose parcel Steadfast charged for counts
  -- that charge (no sale), on the payout's date.
  CROSS JOIN LATERAL (SELECT COALESCE(inventory_order_counted_at(o.id, o.status),
                                     CASE WHEN o.status = 'cancelled' THEN cc.paid_at END) AS at) x
  WHERE (o.status IN ('delivered', 'returned') OR (o.status = 'cancelled' AND cc.order_id IS NOT NULL))
    AND (x.at AT TIME ZONE 'Asia/Dhaka')::date BETWEEN p_from AND p_to;

  SELECT COALESCE(array_agg(id), '{}') INTO v_ids FROM _sp_orders;

  CREATE TEMP TABLE IF NOT EXISTS _sp_items (
    order_item_id uuid, order_id uuid, product_id uuid, variant_id uuid, label text, line_total numeric,
    units integer, cost numeric, provisional numeric, costed boolean
  ) ON COMMIT DROP;
  TRUNCATE _sp_items;
  INSERT INTO _sp_items SELECT * FROM inventory_item_costs(v_ids);

  UPDATE _sp_orders o
  SET cost = CASE WHEN o.status = 'delivered' THEN COALESCE(i.cost, 0) ELSE 0 END,
      provisional = CASE WHEN o.status = 'delivered' THEN COALESCE(i.provisional, 0) ELSE 0 END,
      costed = COALESCE(i.costed, false)
  FROM (
    SELECT order_id, sum(cost) AS cost, sum(provisional) AS provisional, bool_and(costed) AS costed
    FROM _sp_items GROUP BY order_id
  ) i
  WHERE i.order_id = o.id;
  -- (Orders with no lines at all. A WHERE is required: the API refuses an
  -- UPDATE without one.)
  UPDATE _sp_orders SET cost = COALESCE(cost, 0), provisional = COALESCE(provisional, 0), costed = COALESCE(costed, false)
  WHERE cost IS NULL OR provisional IS NULL OR costed IS NULL;
  -- Batch 45: for the Money page, an order placed before the money start
  -- and not taken from lots was already owed in the opening balance; its
  -- sale is not counted a second time as profit.
  IF p_for_money AND money_start_date() IS NOT NULL THEN
    UPDATE _sp_orders so SET costed = false
    FROM orders o
    WHERE o.id = so.id AND so.costed AND o.created_at < money_start_ts()
      AND so.counted_at >= money_start_ts() AND NOT money_order_costed(o.id);
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'order_id', id, 'order_number', order_number, 'status', status, 'counted_at', counted_at,
           'sale', sale, 'cost', cost, 'provisional', provisional, 'delivery', delivery,
           'courier', courier, 'courier_known', courier_known, 'costed', costed,
           'profit', sale - cost + delivery - courier,
           'margin', CASE WHEN sale > 0 THEN round((sale - cost + delivery - courier) / sale * 100, 1) END)
         ORDER BY counted_at DESC, order_number DESC), '[]'::jsonb)
  INTO v_orders FROM _sp_orders;

  -- Per product: delivered, costed orders only.
  WITH lines AS (
    SELECT i.*, o.discount AS order_discount, o.id AS oid
    FROM _sp_items i JOIN _sp_orders o ON o.id = i.order_id
    WHERE o.status = 'delivered' AND o.costed
  ), paisa AS (
    SELECT l.*, round(l.line_total * 100) AS lp, round(l.order_discount * 100) AS dp,
           sum(round(l.line_total * 100)) OVER (PARTITION BY l.oid) AS tp
    FROM lines l
  ), floors AS (
    SELECT p.*,
           CASE WHEN p.tp > 0 THEN div(LEAST(p.dp, p.tp) * p.lp, p.tp) ELSE 0 END AS d_floor,
           CASE WHEN p.tp > 0 THEN mod(LEAST(p.dp, p.tp) * p.lp, p.tp) ELSE 0 END AS d_rem
    FROM paisa p
  ), ranked AS (
    SELECT f.*,
           row_number() OVER (PARTITION BY f.oid ORDER BY f.d_rem DESC, f.order_item_id) AS d_rank,
           LEAST(f.dp, f.tp) - sum(f.d_floor) OVER (PARTITION BY f.oid) AS d_left
    FROM floors f
  ), shared AS (
    SELECT r.product_id, r.variant_id, r.label, r.units, r.cost,
           (r.lp - r.d_floor - CASE WHEN r.d_rank <= r.d_left THEN 1 ELSE 0 END) / 100.0 AS sale
    FROM ranked r
  ), per_product AS (
    SELECT s.product_id, s.variant_id, min(s.label) AS label, sum(s.units)::bigint AS units,
           round(sum(s.sale), 2) AS sales, round(sum(s.cost), 2) AS cost
    FROM shared s
    GROUP BY s.product_id, s.variant_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'product_id', product_id, 'variant_id', variant_id, 'label', label, 'units', units,
           'stock_unit', inventory_stock_unit(product_id, variant_id),
           'pack_size', inventory_pack_size(product_id, variant_id),
           'sales', sales, 'cost', cost, 'profit', sales - cost,
           'margin', CASE WHEN sales > 0 THEN round((sales - cost) / sales * 100, 1) END)
         ORDER BY sales - cost DESC, label), '[]'::jsonb)
  INTO v_products FROM per_product;

  SELECT COALESCE(sum(amount_bdt), 0),
         COALESCE(jsonb_agg(jsonb_build_object('date', adj_date, 'amount', amount_bdt, 'reason', reason, 'note', note)
                            ORDER BY adj_date, created_at), '[]'::jsonb)
  INTO v_adj_sum, v_adjust
  FROM cost_adjustments WHERE adj_date BETWEEN p_from AND p_to
    -- Batch 45: a sale's cost is stored on the sale; these old corrections
    -- are already inside it.
    AND reason NOT IN ('late_bill', 'shortfall_filled', 'given_back');

  SELECT jsonb_build_object(
           'orders', count(*) FILTER (WHERE costed),
           'uncosted_orders', count(*) FILTER (WHERE NOT costed),
           'items_missing_cost', (SELECT count(*) FROM _sp_items i JOIN _sp_orders so ON so.id = i.order_id
                                  WHERE so.status = 'delivered' AND NOT i.costed),
           'sales', COALESCE(sum(sale) FILTER (WHERE costed), 0),
           'cost', COALESCE(sum(cost) FILTER (WHERE costed), 0),
           'provisional', COALESCE(sum(provisional) FILTER (WHERE costed), 0),
           'delivery', COALESCE(sum(delivery) FILTER (WHERE costed), 0),
           'courier', COALESCE(sum(courier) FILTER (WHERE costed), 0),
           'adjustments', v_adj_sum)
  INTO v_totals FROM _sp_orders;

  -- Batch 46: a returned parcel whose order was deleted (its payout line is
  -- marked "returned"): no sale; Steadfast's charge is a courier cost on
  -- the payout's date, with the other returned parcels' charges.
  SELECT COALESCE(sum(i.delivery_charge + i.cod_fee + i.other_deduction), 0), count(*)
  INTO v_ret, v_ret_n
  FROM steadfast_payout_items i JOIN steadfast_payouts sp ON sp.id = i.payout_id
  WHERE i.line_kind = 'returned' AND i.order_id IS NULL
    AND (sp.paid_at AT TIME ZONE 'Asia/Dhaka')::date BETWEEN p_from AND p_to
    AND (NOT p_for_money OR money_start_date() IS NULL OR sp.paid_at >= money_start_ts());
  v_totals := v_totals || jsonb_build_object(
    'courier', (v_totals ->> 'courier')::numeric + v_ret,
    'courier_no_order', v_ret, 'returned_no_order', v_ret_n);

  v_totals := v_totals || jsonb_build_object(
    'profit', (v_totals ->> 'sales')::numeric - (v_totals ->> 'cost')::numeric + (v_totals ->> 'delivery')::numeric
              - (v_totals ->> 'courier')::numeric - v_adj_sum);
  v_totals := v_totals || jsonb_build_object(
    'margin', CASE WHEN (v_totals ->> 'sales')::numeric > 0
                   THEN round((v_totals ->> 'profit')::numeric / (v_totals ->> 'sales')::numeric * 100, 1) END);

  RETURN jsonb_build_object('from', p_from, 'to', p_to, 'totals', v_totals,
                            'orders', v_orders, 'products', v_products, 'adjustments', v_adjust);
END;
$function$;

-- ---------------------------------------------------------------------------
-- PART 6 — promo codes
-- ---------------------------------------------------------------------------
-- Only place_order (which owns it) may count a use. Before Batch 18 the
-- website called this itself when the success screen opened — with no
-- order behind it — and anyone could still call it.
ALTER FUNCTION increment_promo_usage(text) SET search_path = public;
REVOKE ALL ON FUNCTION increment_promo_usage(text) FROM PUBLIC, anon, authenticated;

-- Cancelling or deleting an order gives its use back (never below zero);
-- reopening a cancelled order counts it again.
CREATE OR REPLACE FUNCTION orders_promo_use()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old text;
  v_new text;
BEGIN
  IF OLD.promo_code IS NOT NULL AND trim(OLD.promo_code) <> '' AND OLD.status <> 'cancelled' THEN
    v_old := upper(trim(OLD.promo_code));
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.promo_code IS NOT NULL AND trim(NEW.promo_code) <> '' AND NEW.status <> 'cancelled' THEN
    v_new := upper(trim(NEW.promo_code));
  END IF;
  IF v_old IS NOT DISTINCT FROM v_new THEN
    RETURN NULL;
  END IF;
  IF v_old IS NOT NULL THEN
    UPDATE promo_codes SET times_used = times_used - 1 WHERE upper(code) = v_old AND times_used > 0;
  END IF;
  IF v_new IS NOT NULL THEN
    UPDATE promo_codes SET times_used = times_used + 1 WHERE upper(code) = v_new;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION orders_promo_use() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS orders_promo_use ON orders;
CREATE TRIGGER orders_promo_use
  AFTER UPDATE OF status, promo_code OR DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_promo_use();

-- Recount: one use per order that used the code and is not cancelled.
UPDATE promo_codes c
SET times_used = (SELECT count(*) FROM orders o
                  WHERE upper(trim(o.promo_code)) = upper(c.code) AND o.status <> 'cancelled')
WHERE c.times_used IS DISTINCT FROM (SELECT count(*) FROM orders o
                                     WHERE upper(trim(o.promo_code)) = upper(c.code) AND o.status <> 'cancelled');

COMMIT;

NOTIFY pgrst, 'reload schema';

-- What it did (the same numbers on a second run).
SELECT
  (SELECT count(*) FROM _b46_backup_payout_lines b JOIN steadfast_payout_items i ON i.id = b.id
   WHERE (b.cod_collected, b.delivery_charge, b.cod_fee, b.other_deduction, b.net_paid, b.match_status)
         IS DISTINCT FROM (i.cod_collected, i.delivery_charge, i.cod_fee, i.other_deduction, i.net_paid, i.match_status)
      OR i.line_kind <> 'order') AS payout_lines_corrected,
  (SELECT count(*) FROM _b46_backup_order_payments b JOIN order_payments p ON p.id = b.id
   WHERE p.amount <> b.amount) AS order_payments_corrected,
  (SELECT count(*) FROM steadfast_payout_items
   WHERE match_status = 'to_check' AND line_kind = 'order' AND order_id IS NULL AND invoice ILIKE 'NM-%') AS unmatched_site_lines_remaining,
  (SELECT count(*) FROM steadfast_payout_items
   WHERE match_status = 'to_check' AND order_id IS NOT NULL) AS lines_still_to_check,
  (SELECT count(*) FROM steadfast_payouts p
   WHERE p.total_amount = (SELECT COALESCE(sum(i.net_paid), 0) FROM steadfast_payout_items i WHERE i.payout_id = p.id))
    || ' of ' || (SELECT count(*) FROM steadfast_payouts) AS payouts_that_add_up,
  (SELECT count(*) FROM promo_codes) AS promo_codes_recounted;
