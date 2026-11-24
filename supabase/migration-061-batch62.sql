-- ============================================================
-- Migration 061 — Batch 62
-- ============================================================
-- (059 is kept for Batch 59.)
--
--  1. My Wallet by invitation: a wallet is closed until Naeem opens it.
--     Every customer who already has wallet money or a request is opened
--     here, so nobody with money loses access.
--  2. Hide a size from the shop (product_variants.is_visible).
--  3. Stock unit "tab" (the two fish oils change from pcs to tab: only the
--     word, nothing else).
--  4. Reopen a cancelled "Keep selling" order at stock 0.
--  5. Steadfast payouts that came back with no parcel lines are asked
--     again (payout SFC-33372895).
--
-- One transaction. Safe to run more than once. Needs no signed-in user.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------------
-- 1. My Wallet: open / closed per customer
-- ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS store_wallet_access (
  customer_key        text PRIMARY KEY,
  opened_by           uuid,
  opened_by_username  text,
  opened_at           timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE store_wallet_access ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON store_wallet_access FROM anon, authenticated;
GRANT ALL ON store_wallet_access TO service_role;
-- Nobody reads or writes it directly: only the functions below.

-- True when this customer's wallet is open (a phone key follows its
-- number to its customer, like the balance does).
CREATE OR REPLACE FUNCTION store_wallet_is_open(p_key text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT p_key IS NOT NULL AND EXISTS (
    SELECT 1 FROM store_wallet_access a
    WHERE a.customer_key = store_wallet_owner(p_key)
       OR store_wallet_owner(a.customer_key) = store_wallet_owner(p_key));
$function$;

-- Opens a wallet (internal; nothing happens when it is already open).
CREATE OR REPLACE FUNCTION store_wallet_open_key(p_key text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_key text := store_wallet_owner(p_key);
BEGIN
  IF v_key IS NULL OR store_wallet_is_open(v_key) THEN
    RETURN;
  END IF;
  INSERT INTO store_wallet_access (customer_key, opened_by, opened_by_username)
  VALUES (v_key, auth.uid(), current_actor_username())
  ON CONFLICT (customer_key) DO NOTHING;
END;
$function$;

-- Money that comes INTO a wallet (added, or an order's extra) always
-- opens it: a balance is never hidden behind a closed wallet.
CREATE OR REPLACE FUNCTION store_wallet_entry_opens()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.amount > 0 THEN
    PERFORM store_wallet_open_key(NEW.customer_key);
  END IF;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS store_wallet_entry_opens ON store_wallet_entries;
CREATE TRIGGER store_wallet_entry_opens AFTER INSERT ON store_wallet_entries
  FOR EACH ROW EXECUTE FUNCTION store_wallet_entry_opens();

-- Everyone who already has a wallet entry or a request keeps the wallet.
INSERT INTO store_wallet_access (customer_key, opened_by_username)
SELECT DISTINCT store_wallet_owner(k.customer_key), 'Batch 62 (already had a wallet)'
FROM (SELECT customer_key FROM store_wallet_entries
      UNION SELECT customer_key FROM store_wallet_requests) k
WHERE store_wallet_owner(k.customer_key) IS NOT NULL
ON CONFLICT (customer_key) DO NOTHING;

-- What a wallet request is listed as: the name, else the phone, else
-- "A customer" (never the internal key).
CREATE OR REPLACE FUNCTION store_wallet_display_name(p_key text, p_name text DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_owner text := store_wallet_owner(p_key);
  v_name  text := NULLIF(btrim(COALESCE(p_name, '')), '');
  v_phone text;
BEGIN
  IF v_name IS NULL AND v_owner IS NOT NULL THEN
    v_name := NULLIF(btrim(COALESCE(customer_name_for_key(v_owner), '')), '');
  END IF;
  v_phone := customer_main_phone_key(v_owner);
  -- customer_name_for_key() ends with the phone and then the key itself.
  IF v_name IS NOT NULL AND v_name !~ '^(p|ph|n):' AND v_name IS DISTINCT FROM v_phone THEN
    RETURN v_name;
  END IF;
  RETURN COALESCE(NULLIF(v_phone, ''), 'A customer');
END;
$function$;

-- A request needs an open wallet (also for a direct insert).
CREATE OR REPLACE FUNCTION store_wallet_request_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT store_wallet_is_open(NEW.customer_key) THEN
    RAISE EXCEPTION 'Your wallet isn''t open yet. Message us on WhatsApp and we''ll open it.';
  END IF;
  NEW.trx_id := upper(regexp_replace(COALESCE(NEW.trx_id, ''), '\s', '', 'g'));
  NEW.sender := bd_phone_key(NEW.sender);
  NEW.created_at := now();
  IF NEW.trx_id = '' THEN
    RAISE EXCEPTION 'Transaction ID is required';
  END IF;
  IF NEW.trx_id !~ '^[A-Z0-9]{6,20}$' THEN
    RAISE EXCEPTION 'Enter a valid transaction ID';
  END IF;
  IF NEW.sender IS NULL OR NEW.sender !~ '^01[3-9][0-9]{8}$' THEN
    RAISE EXCEPTION 'Enter a valid number';
  END IF;
  IF NEW.amount IS NULL OR NEW.amount < 500 THEN
    RAISE EXCEPTION 'Minimum ৳500';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('store_wallet_trx:' || NEW.trx_id));
  IF store_wallet_trx_used(NEW.trx_id, NEW.id) THEN
    RAISE EXCEPTION 'This transaction ID has already been used.';
  END IF;
  IF NEW.customer_name IS NULL AND NEW.profile_id IS NOT NULL THEN
    SELECT NULLIF(btrim(p.full_name), '') INTO NEW.customer_name FROM profiles p WHERE p.id = NEW.profile_id;
  END IF;
  RETURN NEW;
END;
$function$;

-- The customer's own wallet: Batch 60 plus "open".
CREATE OR REPLACE FUNCTION store_wallet_my()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_key text := store_wallet_my_key();
  v_due numeric;
BEGIN
  IF v_key IS NULL THEN
    RETURN jsonb_build_object('available', false, 'open', false, 'balance', 0, 'due', 0, 'waiting', '[]'::jsonb,
                              'results', '[]'::jsonb, 'history', '[]'::jsonb);
  END IF;
  SELECT COALESCE(sum(k.due), 0) INTO v_due FROM order_customer_keys() k WHERE k.customer_key = v_key;
  v_due := v_due + COALESCE(customer_previous_balance(), 0);
  RETURN jsonb_build_object(
    'available', true,
    'open', store_wallet_is_open(v_key),
    'balance', store_wallet_balance(v_key),
    'due', v_due,
    'waiting', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', r.id, 'amount', r.amount, 'method', r.method, 'trx_id', r.trx_id,
                                          'created_at', r.created_at) ORDER BY r.created_at DESC)
      FROM store_wallet_requests r WHERE r.profile_id = auth.uid() AND r.status = 'waiting'), '[]'::jsonb),
    'results', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', r.id, 'amount', r.amount, 'method', r.method, 'status', r.status,
                                          'decided_at', r.decided_at) ORDER BY r.decided_at DESC)
      FROM store_wallet_requests r
      WHERE r.profile_id = auth.uid() AND r.status IN ('confirmed', 'rejected') AND r.seen_at IS NULL), '[]'::jsonb),
    'history', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', h.id, 'date', h.entry_date, 'at', h.created_at, 'kind', h.kind,
                                          'amount', h.amount, 'order_id', h.order_id, 'order_number', h.order_number,
                                          'by_shop', h.kind = 'added' AND h.request_id IS NULL)
                       ORDER BY h.created_at DESC, h.id)
      FROM (SELECT e.* FROM store_wallet_entries e
            WHERE store_wallet_owner(e.customer_key) = store_wallet_owner(v_key)
            ORDER BY e.created_at DESC LIMIT 200) h), '[]'::jsonb));
END;
$function$;

-- "I sent money": refused while the wallet is closed.
CREATE OR REPLACE FUNCTION store_wallet_request(p_amount numeric, p_method text, p_trx_id text, p_sender text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_key text := store_wallet_my_key();
  v_row store_wallet_requests%ROWTYPE;
BEGIN
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'Sign in to add money to your wallet.';
  END IF;
  IF NOT store_wallet_is_open(v_key) THEN
    RAISE EXCEPTION 'Your wallet isn''t open yet. Message us on WhatsApp and we''ll open it.';
  END IF;
  IF p_amount IS NULL OR round(p_amount, 2) < 500 THEN
    RAISE EXCEPTION 'Minimum ৳500';
  END IF;
  IF round(p_amount, 2) > 10000000 THEN
    RAISE EXCEPTION 'That amount is too large.';
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('bkash', 'nagad') THEN
    RAISE EXCEPTION 'Choose bKash or Nagad.';
  END IF;
  IF p_trx_id IS NULL OR btrim(p_trx_id) = '' THEN
    RAISE EXCEPTION 'Transaction ID is required';
  END IF;
  INSERT INTO store_wallet_requests (customer_key, profile_id, amount, method, trx_id, sender)
  VALUES (v_key, auth.uid(), round(p_amount, 2), p_method, p_trx_id, COALESCE(p_sender, ''))
  RETURNING * INTO v_row;
  PERFORM write_activity('wallet.requested', 'customer', v_key, store_wallet_display_name(v_key, v_row.customer_name),
    format('Wallet: %s sent by %s, TrxID %s (waiting)', money_short(v_row.amount), payment_method_label(v_row.method), v_row.trx_id),
    jsonb_build_object('request_id', v_row.id, 'amount', v_row.amount, 'method', v_row.method));
  RETURN jsonb_build_object('id', v_row.id, 'amount', v_row.amount, 'method', v_row.method, 'trx_id', v_row.trx_id,
                            'status', v_row.status, 'created_at', v_row.created_at);
END;
$function$;

-- A customer's wallet on their admin page: Batch 60 plus "open".
CREATE OR REPLACE FUNCTION store_wallet_customer(p_customer_key text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_owner text := store_wallet_owner(p_customer_key);
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  RETURN jsonb_build_object(
    'open', store_wallet_is_open(p_customer_key),
    'balance', store_wallet_balance(p_customer_key),
    'waiting', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', r.id, 'amount', r.amount, 'method', r.method, 'trx_id', r.trx_id,
                                          'sender', r.sender, 'created_at', r.created_at) ORDER BY r.created_at)
      FROM store_wallet_requests r WHERE store_wallet_owner(r.customer_key) = v_owner AND r.status = 'waiting'), '[]'::jsonb),
    'requests', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', r.id, 'amount', r.amount, 'method', r.method, 'trx_id', r.trx_id,
                                          'status', r.status, 'reason', r.reject_reason, 'by', r.decided_by_username,
                                          'decided_at', r.decided_at, 'created_at', r.created_at) ORDER BY r.created_at DESC)
      FROM store_wallet_requests r WHERE store_wallet_owner(r.customer_key) = v_owner AND r.status <> 'waiting'), '[]'::jsonb),
    'history', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', e.id, 'date', e.entry_date, 'at', e.created_at, 'kind', e.kind,
                                          'amount', e.amount, 'order_id', e.order_id, 'order_number', e.order_number,
                                          'account', a.name, 'note', e.note, 'by', e.created_by_username,
                                          'by_shop', e.kind = 'added' AND e.request_id IS NULL)
                       ORDER BY e.created_at DESC, e.id)
      FROM store_wallet_entries e LEFT JOIN money_accounts a ON a.id = e.account_id
      WHERE store_wallet_owner(e.customer_key) = v_owner), '[]'::jsonb));
END;
$function$;

-- Every waiting request (Home "Needs attention"): name, else phone, else
-- "A customer".
CREATE OR REPLACE FUNCTION store_wallet_waiting()
RETURNS TABLE(id uuid, customer_key text, name text, amount numeric, method text, trx_id text, created_at timestamptz)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT money_can_view() THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT r.id, store_wallet_owner(r.customer_key), store_wallet_display_name(r.customer_key, r.customer_name),
         r.amount, r.method, r.trx_id, r.created_at
  FROM store_wallet_requests r WHERE r.status = 'waiting'
  ORDER BY r.created_at;
END;
$function$;

-- Admin: the "Wallet open" switch (same permission as Add to wallet).
-- Closing is refused while the wallet holds money or a waiting request.
CREATE OR REPLACE FUNCTION store_wallet_set_open(p_customer_key text, p_open boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_key     text := store_wallet_owner(NULLIF(btrim(COALESCE(p_customer_key, '')), ''));
  v_balance numeric;
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF v_key IS NULL OR NOT customer_key_known(v_key) THEN
    RAISE EXCEPTION 'Customer not found.';
  END IF;
  IF p_open IS NULL THEN
    RAISE EXCEPTION 'Choose open or closed.';
  END IF;
  PERFORM store_wallet_lock(v_key);
  IF p_open THEN
    IF NOT store_wallet_is_open(v_key) THEN
      PERFORM store_wallet_open_key(v_key);
      PERFORM write_activity('wallet.opened', 'customer', v_key, store_wallet_display_name(v_key),
        'Wallet opened', jsonb_build_object('open', true));
    END IF;
  ELSE
    v_balance := round(store_wallet_balance(v_key), 2);
    IF v_balance <> 0 THEN
      RAISE EXCEPTION 'This wallet still has %. It can be closed when the balance is ৳0.', money_short(v_balance);
    END IF;
    IF EXISTS (SELECT 1 FROM store_wallet_requests r
               WHERE store_wallet_owner(r.customer_key) = v_key AND r.status = 'waiting') THEN
      RAISE EXCEPTION 'This wallet has a request waiting. Confirm or reject it first.';
    END IF;
    IF store_wallet_is_open(v_key) THEN
      DELETE FROM store_wallet_access a
      WHERE a.customer_key = v_key OR store_wallet_owner(a.customer_key) = v_key;
      PERFORM write_activity('wallet.closed', 'customer', v_key, store_wallet_display_name(v_key),
        'Wallet closed', jsonb_build_object('open', false));
    END IF;
  END IF;
  RETURN jsonb_build_object('open', store_wallet_is_open(v_key));
END;
$function$;

REVOKE ALL ON FUNCTION store_wallet_is_open(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION store_wallet_open_key(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION store_wallet_entry_opens() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION store_wallet_display_name(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION store_wallet_set_open(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION store_wallet_set_open(text, boolean) TO authenticated;
-- (store_wallet_my / _request / _customer / _waiting keep their Batch 60
-- grants: CREATE OR REPLACE does not change them.)

-- ------------------------------------------------------------------
-- 2. Hide a size from the shop
-- ------------------------------------------------------------------

ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS is_visible boolean NOT NULL DEFAULT true;

-- Customers and visitors never get a hidden size; staff see every size.
CREATE OR REPLACE VIEW product_variants_view AS
 SELECT pv.id,
    pv.product_id,
    pv.region,
    pv.size,
    pv.retail_price,
    pv.offer_price,
        CASE
            WHEN (p.keep_selling AND (NOT ( SELECT is_staff() AS is_staff))) THEN true
            ELSE pv.in_stock
        END AS in_stock,
        CASE
            WHEN (p.keep_selling AND (NOT ( SELECT is_staff() AS is_staff))) THEN NULL::integer
            ELSE pv.stock_quantity
        END AS stock_quantity,
    pv.image_url,
    pv.note,
    pv.sort_order,
    pv.created_at,
    pv.source_product_id,
        CASE
            WHEN is_wholesaler_or_admin() THEN pv.wholesale_price
            ELSE NULL::numeric
        END AS wholesale_price,
    (pv.wholesale_price IS NOT NULL) AS has_wholesale,
    pv.image_url_thumb,
    p.keep_selling,
        CASE
            WHEN (pv.stock_quantity IS NOT NULL) THEN (pv.stock_quantity > 0)
            ELSE pv.in_stock
        END AS in_hand,
    pv.is_visible
   FROM (product_variants pv
     JOIN products p ON ((p.id = pv.product_id)))
  WHERE pv.is_visible OR ( SELECT is_staff() AS is_staff);

DROP POLICY IF EXISTS product_variants_public_read ON product_variants;
CREATE POLICY product_variants_public_read ON product_variants
  FOR SELECT TO anon, authenticated USING (is_visible OR is_staff());

-- place_order refuses a hidden size (today's place_order_core with one check added).
CREATE OR REPLACE FUNCTION place_order_core(p_items jsonb, p_full_name text, p_phone text, p_division text, p_district text, p_thana text, p_address_line text, p_delivery_zone text, p_payment_method text, p_bkash_trx_id text DEFAULT NULL::text, p_bkash_sender text DEFAULT NULL::text, p_promo_code text DEFAULT NULL::text, p_customer_note text DEFAULT NULL::text, p_store_wallet numeric DEFAULT 0)
 RETURNS TABLE(order_id uuid, order_number text, total numeric, discount numeric, advance_discount numeric, store_wallet numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid              uuid := auth.uid();
  v_item             jsonb;
  v_product_id       uuid;
  v_variant_id       uuid;
  v_quantity         integer;
  v_unit_price       numeric(10,2);
  v_product_name     text;
  v_variant_label    text;
  v_image_url        text;
  v_is_active        boolean;
  v_stock_quantity   integer;
  v_in_stock_flag    boolean;
  v_keep             boolean;
  v_region           text;
  v_size             text;
  v_subtotal         numeric(10,2) := 0;
  v_delivery_fee     numeric(10,2);
  v_discount         numeric(10,2) := 0;
  v_advance          numeric(10,2) := 0;
  v_advance_type     text;
  v_advance_value    numeric(10,2);
  v_total            numeric(10,2);
  v_promo_row        promo_codes%ROWTYPE;
  v_promo_ok         boolean;
  v_order_id         uuid;
  v_order_number     text;
  v_item_count       integer := 0;
  -- Batch 51
  v_mode_on          boolean := inventory_mode_on();
  v_no_limit         boolean := is_wholesaler_or_admin();
  v_limit            integer := order_limit_per_item();
  v_already          integer;
  v_have             integer;
  v_short            integer;
  v_take             integer;
  v_buys_later       boolean := false;
  v_line             record;
  v_item_id          uuid;
  -- Batch 60
  v_method           text := p_payment_method;
  v_trx              text := p_bkash_trx_id;
  v_sender           text := p_bkash_sender;
  v_wallet_key       text;
  v_wallet_ask       numeric(12,2) := round(GREATEST(COALESCE(p_store_wallet, 0), 0), 2);
  v_wallet           numeric(12,2) := 0;
  v_pay_before       numeric(12,2);
  v_left             numeric(12,2);
  v_wallet_taken     numeric(12,2) := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to place an order.';
  END IF;

  IF p_payment_method NOT IN ('cod', 'bkash', 'nagad') THEN
    RAISE EXCEPTION 'Invalid payment method.';
  END IF;
  IF p_payment_method = 'bkash' AND (p_bkash_trx_id IS NULL OR trim(p_bkash_trx_id) = '') THEN
    RAISE EXCEPTION 'A bKash Transaction ID is required for bKash payment.';
  END IF;
  IF p_payment_method = 'nagad' AND (p_bkash_trx_id IS NULL OR trim(p_bkash_trx_id) = '') THEN
    RAISE EXCEPTION 'A Nagad Transaction ID is required for Nagad payment.';
  END IF;
  IF p_delivery_zone NOT IN ('inside_dhaka', 'outside_dhaka') THEN
    RAISE EXCEPTION 'Invalid delivery zone.';
  END IF;
  IF p_full_name IS NULL OR trim(p_full_name) = '' THEN
    RAISE EXCEPTION 'Full name is required.';
  END IF;
  IF p_address_line IS NULL OR trim(p_address_line) = '' THEN
    RAISE EXCEPTION 'Delivery address is required.';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Your cart is empty.';
  END IF;

  -- Batch 60: the wallet is checked again here (the screen is never
  -- trusted). The lock holds until the order is saved.
  IF v_wallet_ask > 0 THEN
    v_wallet_key := store_wallet_my_key();
    IF v_wallet_key IS NULL THEN
      RAISE EXCEPTION 'Your wallet balance changed. Please check and try again.';
    END IF;
    PERFORM store_wallet_lock(v_wallet_key);
    IF v_wallet_ask > store_wallet_balance(v_wallet_key) + 0.004 THEN
      RAISE EXCEPTION 'Your wallet balance changed. Please check and try again.';
    END IF;
  END IF;

  SELECT COALESCE(
    (SELECT value::numeric FROM app_settings WHERE key = 'delivery_fee_' || p_delivery_zone),
    CASE WHEN p_delivery_zone = 'inside_dhaka' THEN 80 ELSE 130 END
  ) INTO v_delivery_fee;

  CREATE TEMP TABLE IF NOT EXISTS _place_lines (
    seq           serial,
    product_id    uuid,
    variant_id    uuid,
    product_name  text,
    variant_label text,
    image_url     text,
    unit_price    numeric(10,2),
    quantity      integer,
    line_total    numeric(10,2),
    keep_selling  boolean,
    short_qty     integer,
    tracked       boolean
  ) ON COMMIT DROP;
  TRUNCATE _place_lines;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_item_count := v_item_count + 1;
    v_product_id := (v_item->>'product_id')::uuid;
    v_variant_id := NULLIF(v_item->>'variant_id', '')::uuid;
    -- Batch 45 Part 3: the product's own size is picked as an option whose
    -- id is the product's id. It is the product row, not an option row.
    IF v_variant_id = v_product_id THEN
      v_variant_id := NULL;
    END IF;
    v_quantity   := (v_item->>'quantity')::integer;

    IF v_product_id IS NULL OR v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Invalid item in your cart.';
    END IF;

    IF v_variant_id IS NOT NULL THEN
      SELECT
        CASE WHEN pv.offer_price IS NOT NULL AND pv.offer_price < pv.retail_price
             THEN pv.offer_price ELSE pv.retail_price END,
        pv.stock_quantity,
        pv.in_stock,
        pv.region,
        pv.size,
        COALESCE(pv.image_url, p.image_url),
        p.name,
        p.is_active,
        p.keep_selling
      INTO v_unit_price, v_stock_quantity, v_in_stock_flag, v_region, v_size,
           v_image_url, v_product_name, v_is_active, v_keep
      FROM product_variants pv
      JOIN products p ON p.id = pv.product_id
      WHERE pv.id = v_variant_id AND pv.product_id = v_product_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'One of the items in your cart is no longer available.';
      END IF;
      -- Batch 62: a size hidden from the shop cannot be ordered there.
      IF EXISTS (SELECT 1 FROM product_variants hv WHERE hv.id = v_variant_id AND NOT hv.is_visible) THEN
        RAISE EXCEPTION 'This size is no longer available.';
      END IF;
      v_variant_label := NULLIF(trim(both ' ' from concat_ws(' · ', NULLIF(v_region, ''), NULLIF(v_size, ''))), '');
    ELSE
      SELECT
        CASE WHEN p.offer_price IS NOT NULL AND p.offer_price < p.retail_price
             THEN p.offer_price ELSE p.retail_price END,
        p.stock_quantity,
        (p.stock_status <> 'out_of_stock'),
        p.image_url,
        p.name,
        p.is_active,
        p.keep_selling
      INTO v_unit_price, v_stock_quantity, v_in_stock_flag, v_image_url, v_product_name, v_is_active, v_keep
      FROM products p
      WHERE p.id = v_product_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'One of the items in your cart is no longer available.';
      END IF;
      v_variant_label := NULL;
    END IF;

    IF NOT v_is_active THEN
      RAISE EXCEPTION '"%" is no longer available.', v_product_name;
    END IF;

    SELECT COALESCE(sum(l.quantity), 0) INTO v_already
    FROM _place_lines l
    WHERE l.product_id = v_product_id AND l.variant_id IS NOT DISTINCT FROM v_variant_id;

    -- Batch 51: the order limit (Admin → Settings). Wholesalers have none.
    IF NOT v_no_limit AND v_already + v_quantity > v_limit THEN
      RAISE EXCEPTION 'Limit % per order for "%".', v_limit, v_product_name;
    END IF;

    v_short := 0;
    IF v_keep THEN
      -- Never refused for stock. What stock does not cover is bought
      -- after the order (Shopping list).
      v_have := stock_packs_on_hand(v_product_id, v_variant_id, v_already + v_quantity);
      IF v_mode_on THEN
        v_have := v_have - v_already;
      ELSIF v_stock_quantity IS NOT NULL THEN
        -- Off: the stock number, already lowered by earlier lines.
        v_have := GREATEST(v_stock_quantity, 0);
      END IF;
      v_short := GREATEST(v_quantity - GREATEST(v_have, 0), 0);
      IF v_short > 0 THEN
        v_buys_later := true;
      END IF;
    ELSIF v_stock_quantity IS NOT NULL THEN
      IF v_stock_quantity < v_quantity THEN
        RAISE EXCEPTION 'Only % of "%" left in stock.', v_stock_quantity, v_product_name;
      END IF;
    ELSIF NOT v_in_stock_flag THEN
      RAISE EXCEPTION '"%" is out of stock.', v_product_name;
    END IF;

    INSERT INTO _place_lines (product_id, variant_id, product_name, variant_label, image_url, unit_price,
                              quantity, line_total, keep_selling, short_qty, tracked)
    VALUES (v_product_id, v_variant_id, v_product_name, v_variant_label, v_image_url, v_unit_price,
            v_quantity, v_unit_price * v_quantity, v_keep, v_short, v_stock_quantity IS NOT NULL);

    v_subtotal := v_subtotal + (v_unit_price * v_quantity);

    IF v_stock_quantity IS NOT NULL THEN
      -- Off: the stock number goes down only by what it covers. On: the
      -- number follows the lots anyway (inventory_force_*_stock).
      v_take := CASE WHEN v_mode_on THEN v_quantity ELSE v_quantity - v_short END;
      IF v_variant_id IS NOT NULL THEN
        UPDATE product_variants SET stock_quantity = GREATEST(stock_quantity - v_take, 0) WHERE id = v_variant_id;
      ELSE
        UPDATE products SET stock_quantity = GREATEST(stock_quantity - v_take, 0) WHERE id = v_product_id;
      END IF;
    END IF;
  END LOOP;

  IF p_promo_code IS NOT NULL AND trim(p_promo_code) <> '' THEN
    SELECT * INTO v_promo_row FROM promo_codes WHERE lower(code) = lower(trim(p_promo_code));
    IF NOT FOUND OR NOT v_promo_row.active
       OR (v_promo_row.max_uses IS NOT NULL AND v_promo_row.times_used >= v_promo_row.max_uses)
       OR (v_promo_row.expires_at IS NOT NULL AND v_promo_row.expires_at <= now()) THEN
      RAISE EXCEPTION 'This promo code is no longer valid.';
    END IF;

    v_discount := CASE WHEN v_promo_row.discount_type = 'percent'
                        THEN v_subtotal * v_promo_row.discount_amount / 100
                        ELSE v_promo_row.discount_amount END;
    v_discount := LEAST(GREATEST(v_discount, 0), v_subtotal);

    SELECT increment_promo_usage(p_promo_code) INTO v_promo_ok;
    IF NOT v_promo_ok THEN
      RAISE EXCEPTION 'This promo code is no longer valid.';
    END IF;
  END IF;

  -- Batch 60: the wallet part comes off first. What is left is paid on
  -- delivery or in advance. Fully paid from the wallet: nothing is left to
  -- pay, so there is no bKash / Nagad payment at all.
  v_pay_before := GREATEST(v_subtotal + v_delivery_fee - v_discount, 0);
  v_wallet := LEAST(v_wallet_ask, v_pay_before);
  v_left := v_pay_before - v_wallet;
  IF v_wallet > 0 AND v_left < 0.01 THEN
    v_method := 'cod';
    v_trx := NULL;
    v_sender := NULL;
  END IF;

  -- Batch 48: paying in advance (bKash / Nagad) takes the advance discount
  -- off the products after the promo code. Delivery is never discounted.
  -- Worked out here from the setting; the browser sends no amount. It is
  -- not a promo code and never touches times_used.
  -- Batch 60: only when the part paid in advance is ৳1,000 or more, and
  -- never on the wallet part (the base is the products' part of what is
  -- left to pay).
  IF v_method IN ('bkash', 'nagad') AND v_left >= 1000 THEN
    SELECT a.amount, a.rule_type, a.rule_value
      INTO v_advance, v_advance_type, v_advance_value
      FROM advance_discount_amount(v_method, LEAST(v_subtotal - v_discount, v_left)) a;
  END IF;
  v_advance := COALESCE(v_advance, 0);
  IF v_advance <= 0 THEN
    v_advance := 0;
    v_advance_type := NULL;
    v_advance_value := NULL;
  END IF;

  v_total := GREATEST(v_subtotal + v_delivery_fee - v_discount - v_advance, 0);
  v_order_number := next_order_number();

  INSERT INTO orders (
    order_number, customer_id, customer_name, customer_phone,
    division, district, thana, address_line,
    delivery_zone, delivery_fee, subtotal, discount, list_value,
    promo_code, total, payment_method, bkash_trx_id, bkash_sender,
    payment_status, customer_note,
    advance_discount, advance_discount_type, advance_discount_value,
    buys_later
  ) VALUES (
    v_order_number, v_uid, trim(p_full_name), p_phone,
    p_division, p_district, p_thana, trim(p_address_line),
    p_delivery_zone, v_delivery_fee, v_subtotal, v_discount + v_advance, v_subtotal,
    NULLIF(trim(COALESCE(p_promo_code, '')), ''), v_total, v_method,
    NULLIF(trim(COALESCE(v_trx, '')), ''), NULLIF(trim(COALESCE(v_sender, '')), ''),
    CASE WHEN v_method IN ('bkash', 'nagad') THEN 'pending_verification' ELSE 'unpaid' END,
    NULLIF(trim(COALESCE(p_customer_note, '')), ''),
    v_advance, v_advance_type, v_advance_value,
    v_buys_later
  )
  RETURNING id INTO v_order_id;

  -- One line at a time, in cart order. Inventory mode On: a keep-selling
  -- line may take more than the lots hold; the rest is recorded as "sold
  -- without stock" (Batch 39). Every other line is refused when short.
  FOR v_line IN SELECT * FROM _place_lines ORDER BY seq LOOP
    PERFORM set_config('inventory.short_ok', CASE WHEN v_line.keep_selling THEN 'on' ELSE '' END, true);
    INSERT INTO order_items (order_id, product_id, variant_id, product_name, variant_label, image_url, unit_price, quantity, line_total, list_price)
    VALUES (v_order_id, v_line.product_id, v_line.variant_id, v_line.product_name, v_line.variant_label,
            v_line.image_url, v_line.unit_price, v_line.quantity, v_line.line_total, v_line.unit_price)
    RETURNING id INTO v_item_id;
    IF NOT v_mode_on AND v_line.tracked AND v_line.short_qty > 0 THEN
      INSERT INTO order_item_unstocked (order_item_id, qty) VALUES (v_item_id, v_line.short_qty);
      UPDATE order_items
      SET pre_inventory_units = (v_line.quantity - v_line.short_qty) * inventory_pack_size(v_line.product_id, v_line.variant_id)
      WHERE id = v_item_id;
    END IF;
  END LOOP;
  PERFORM set_config('inventory.short_ok', '', true);

  INSERT INTO order_status_history (order_id, old_status, new_status, changed_by)
  VALUES (v_order_id, NULL, 'pending', v_uid);

  IF v_wallet > 0 THEN
    v_wallet_taken := store_wallet_take(v_order_id, v_wallet, v_wallet_key);
    IF v_wallet_taken < v_wallet - 0.004 THEN
      RAISE EXCEPTION 'Your wallet balance changed. Please check and try again.';
    END IF;
  END IF;

  RETURN QUERY SELECT v_order_id, v_order_number, v_total, v_discount + v_advance, v_advance, v_wallet_taken;
END;
$function$;

-- ------------------------------------------------------------------
-- 3. Stock unit "tab"
-- ------------------------------------------------------------------

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_pack_check;
ALTER TABLE products ADD CONSTRAINT products_pack_check
  CHECK (stock_unit = ANY (ARRAY['pcs', 'ml', 'g', 'tab']) AND pack_size >= 1 AND pack_size <= 1000000);
ALTER TABLE product_variants DROP CONSTRAINT IF EXISTS product_variants_pack_check;
ALTER TABLE product_variants ADD CONSTRAINT product_variants_pack_check
  CHECK (stock_unit = ANY (ARRAY['pcs', 'ml', 'g', 'tab']) AND pack_size >= 1 AND pack_size <= 1000000);
ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_sold_unit_check;
ALTER TABLE order_items ADD CONSTRAINT order_items_sold_unit_check
  CHECK (sold_unit IS NULL OR sold_unit = ANY (ARRAY['pcs', 'ml', 'g', 'tab']));

-- The word may change on its own (pack size the same) even when stock or
-- sales are counted per unit: units stay units. A pack-size change is
-- still refused then (Batch 55.1).
CREATE OR REPLACE FUNCTION inventory_set_pack(p_product_id uuid, p_variant_id uuid, p_unit text, p_pack_size integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_unit text := lower(btrim(COALESCE(p_unit, '')));
  v_now  integer;
BEGIN
  IF NOT (staff_can('edit_products') OR staff_can('view_profit_costs')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF v_unit NOT IN ('pcs', 'ml', 'g', 'tab') THEN
    RAISE EXCEPTION 'Stock unit must be pcs, ml, g or tab.';
  END IF;
  IF p_pack_size IS NULL OR p_pack_size < 1 OR p_pack_size > 1000000 THEN
    RAISE EXCEPTION 'Pack size must be a whole number from 1 to 1000000.';
  END IF;
  PERFORM inventory_check_unit(p_product_id, p_variant_id, 'Pack size');
  v_now := inventory_pack_size(p_product_id, p_variant_id);
  IF p_pack_size IS DISTINCT FROM v_now AND inventory_pack_locked(p_product_id, p_variant_id) THEN
    RAISE EXCEPTION 'This product already has stock or sales counted per pack. Changing its pack size here would break those numbers. Ask for a safe pack-size change.';
  END IF;
  IF p_variant_id IS NULL THEN
    UPDATE products SET stock_unit = v_unit, pack_size = p_pack_size
    WHERE id = p_product_id AND (stock_unit IS DISTINCT FROM v_unit OR pack_size IS DISTINCT FROM p_pack_size);
  ELSE
    UPDATE product_variants SET stock_unit = v_unit, pack_size = p_pack_size
    WHERE id = p_variant_id AND (stock_unit IS DISTINCT FROM v_unit OR pack_size IS DISTINCT FROM p_pack_size);
  END IF;
  -- While On the shop's whole packs change with the pack size.
  PERFORM inventory_sync_unit(p_product_id, p_variant_id);
END;
$function$;

-- The two fish oils are counted in tablets: only the word changes.
UPDATE products SET stock_unit = 'tab'
WHERE stock_unit = 'pcs'
  AND name IN ('Blackmores Fish Oil 1000 | 400 Capsules', 'Blackmores Omega Triple Super Strength Fish Oil');
UPDATE product_variants v SET stock_unit = 'tab'
FROM products p
WHERE p.id = v.product_id AND v.stock_unit = 'pcs'
  AND p.name IN ('Blackmores Fish Oil 1000 | 400 Capsules', 'Blackmores Omega Triple Super Strength Fish Oil');
-- Loose lines already sold of them say the same word.
UPDATE order_items oi SET sold_unit = 'tab'
FROM products p
WHERE p.id = oi.product_id AND oi.sold_unit = 'pcs'
  AND p.name IN ('Blackmores Fish Oil 1000 | 400 Capsules', 'Blackmores Omega Triple Super Strength Fish Oil');

-- ------------------------------------------------------------------
-- 4. Reopen a cancelled "Keep selling" order at stock 0
-- ------------------------------------------------------------------
-- Placing such an order is never refused for stock; reopening it is not
-- either. Mode On: what the lots do not hold is "sold without stock"
-- (Shortfalls), exactly as at checkout. Mode Off: the stock number goes
-- down by what it covers, the rest is "bought after the order".

CREATE OR REPLACE FUNCTION inventory_order_released()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_item order_items%ROWTYPE;
  v_prev text;
BEGIN
  IF NEW.stock_released AND NOT OLD.stock_released THEN
    FOR v_item IN SELECT * FROM order_items WHERE order_id = NEW.id ORDER BY id LOOP
      PERFORM inventory_give_back(v_item.id, NULL,
        CASE WHEN NEW.status = 'returned' THEN 'return' ELSE 'cancel' END,
        CASE WHEN NEW.status = 'returned' THEN 'Order returned' ELSE 'Order cancelled' END);
      IF v_item.pre_inventory_units > 0 THEN
        PERFORM inventory_give_back_pre(v_item.id, NULL,
          CASE WHEN NEW.status = 'returned' THEN 'Order returned' ELSE 'Order cancelled' END, true);
      END IF;
    END LOOP;
  ELSIF OLD.stock_released AND NOT NEW.stock_released THEN
    IF inventory_mode_on() THEN
      v_prev := COALESCE(current_setting('inventory.short_ok', true), '');
      FOR v_item IN SELECT * FROM order_items WHERE order_id = NEW.id ORDER BY id LOOP
        -- Batch 62: a "Keep selling" product may be short, like at checkout.
        PERFORM set_config('inventory.short_ok',
          CASE WHEN v_prev = 'on' OR COALESCE((SELECT p.keep_selling FROM products p WHERE p.id = v_item.product_id), false)
               THEN 'on' ELSE '' END, true);
        PERFORM inventory_take_units(v_item, v_item.quantity * inventory_item_factor(v_item), NEW.order_number);
        PERFORM inventory_refresh_item_cost(v_item.id);
      END LOOP;
      PERFORM set_config('inventory.short_ok', v_prev, true);
    ELSE
      -- Reopened while Off: the plain stock number was lowered again (by
      -- what it covered: a "bought after" part never was).
      UPDATE order_items oi
      SET pre_inventory_units = (oi.quantity - order_item_unstocked_qty(oi.id)) * inventory_pack_size(oi.product_id, oi.variant_id)
      WHERE oi.order_id = NEW.id AND oi.sold_unit IS NULL AND oi.product_id IS NOT NULL
        AND CASE WHEN oi.variant_id IS NULL
                 THEN (SELECT p.stock_quantity IS NOT NULL FROM products p WHERE p.id = oi.product_id)
                 ELSE (SELECT v.stock_quantity IS NOT NULL FROM product_variants v WHERE v.id = oi.variant_id) END;
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION admin_reopen_order(p_order_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_order  orders%ROWTYPE;
  v_line   record;
  v_back   text;
  v_need   integer;
  v_have   integer;
  v_short  integer;
  v_later  boolean := false;
BEGIN
  IF NOT staff_can('change_order_status') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;
  IF v_order.status <> 'cancelled' THEN
    RAISE EXCEPTION 'Only a cancelled order can be reopened.';
  END IF;

  -- The status it had just before the latest cancel.
  SELECT h.old_status INTO v_back
  FROM order_status_history h
  WHERE h.order_id = p_order_id AND h.new_status = 'cancelled'
  ORDER BY h.changed_at DESC
  LIMIT 1;
  IF v_back IS NULL OR v_back NOT IN ('pending', 'confirmed', 'shipped', 'delivered') THEN
    v_back := 'pending';
  END IF;

  -- Take the stock again, exactly like a new order does; any line that is
  -- short stops the whole reopen (nothing is changed), except a "Keep
  -- selling" product (Batch 62): what the stock does not cover is bought
  -- after the order.
  IF v_order.stock_released THEN
    PERFORM set_config('app.order_stock_change', 'on', true);
    -- Batch 39: lines sold in loose units never changed the stock number.
    FOR v_line IN
      SELECT oi.*, COALESCE(p.keep_selling, false) AS keep
      FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = p_order_id AND oi.sold_unit IS NULL
    LOOP
      v_need := v_line.quantity - order_item_unstocked_qty(v_line.id);
      IF v_line.keep AND NOT inventory_mode_on() AND v_need > 0 THEN
        IF v_line.variant_id IS NOT NULL THEN
          SELECT stock_quantity INTO v_have FROM product_variants WHERE id = v_line.variant_id FOR UPDATE;
        ELSE
          SELECT stock_quantity INTO v_have FROM products WHERE id = v_line.product_id FOR UPDATE;
        END IF;
        IF v_have IS NOT NULL AND v_have < v_need THEN
          v_short := v_need - GREATEST(v_have, 0);
          INSERT INTO order_item_unstocked (order_item_id, qty) VALUES (v_line.id, v_short)
          ON CONFLICT (order_item_id) DO UPDATE SET qty = order_item_unstocked.qty + EXCLUDED.qty;
          v_need := v_need - v_short;
          v_later := true;
        END IF;
      END IF;
      PERFORM order_edit_stock(
        v_line.product_id, v_line.variant_id, -v_need,
        v_line.product_name || COALESCE(' (' || v_line.variant_label || ')', '')
      );
    END LOOP;
    PERFORM set_config('app.order_stock_change', 'off', true);
  END IF;

  UPDATE orders SET status = v_back, stock_released = false, updated_at = now() WHERE id = p_order_id;
  -- Mode On: a short "Keep selling" line was recorded as a shortfall.
  IF v_later OR EXISTS (SELECT 1 FROM stock_shortfalls s WHERE s.order_id = p_order_id) THEN
    UPDATE orders SET buys_later = true WHERE id = p_order_id AND NOT buys_later;
  END IF;
  INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, note)
  VALUES (p_order_id, 'cancelled', v_back, auth.uid(), 'Reopened (stock taken again)');

  RETURN v_back;
END;
$function$;

-- ------------------------------------------------------------------
-- 5. Steadfast payouts with no parcel lines are asked again
-- ------------------------------------------------------------------
-- (The sync now marks a payout done only once its lines came back:
-- supabase/functions/_shared/steadfastPayouts.ts.)
UPDATE steadfast_payouts p SET items_synced = false
WHERE p.items_synced
  AND NOT EXISTS (SELECT 1 FROM steadfast_payout_items i WHERE i.payout_id = p.id);

COMMIT;
