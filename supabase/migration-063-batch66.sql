-- Batch 66: Campaigns (timed sales).
--
-- A campaign is a sale with a name, a start and an end (Dhaka time), a
-- style (plain / glitter), and either the same % off every item or a price
-- Naeem types for each item. While a campaign is switched on and now is
-- between its start and end it is "live": its items cost the sale price
-- (or the normal offer, when that is lower). Promo codes and the
-- advance-payment discount skip those items.
--
-- Safe to run more than once. Needs no admin session (it only creates
-- tables and functions).

BEGIN;

CREATE TABLE IF NOT EXISTS campaigns (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 40),
  slug           text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  style          text NOT NULL DEFAULT 'plain' CHECK (style IN ('plain', 'glitter')),
  discount_mode  text NOT NULL CHECK (discount_mode IN ('percent', 'own_price')),
  percent        numeric(5,2) CHECK (percent IS NULL OR (percent > 0 AND percent < 100)),
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz NOT NULL,
  is_enabled     boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaigns_dates_ok CHECK (ends_at > starts_at),
  CONSTRAINT campaigns_percent_ok CHECK (discount_mode <> 'percent' OR percent IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS campaign_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  product_id      uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id      uuid REFERENCES product_variants(id) ON DELETE CASCADE,
  campaign_price  numeric(10,2) CHECK (campaign_price IS NULL OR campaign_price > 0),
  sort_order      integer NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS campaign_items_one
  ON campaign_items (campaign_id, product_id, COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS campaign_items_product ON campaign_items (product_id);

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS campaign_id           uuid REFERENCES campaigns(id) ON DELETE SET NULL;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS campaign_normal_price numeric(10,2);
CREATE INDEX IF NOT EXISTS order_items_campaign ON order_items (campaign_id) WHERE campaign_id IS NOT NULL;

ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON campaigns, campaign_items FROM anon, authenticated;
GRANT ALL ON campaigns, campaign_items TO service_role;
-- Nobody reads or writes them directly: only the functions below.

-- ------------------------------------------------------------------
-- 1. The sale price of one product / size (internal)
-- ------------------------------------------------------------------
-- Same rule as saleFor() in src/lib/campaigns.ts:
--   percent  : one row with variant_id NULL covers every size;
--              sale = round(retail × (100 − percent) / 100), whole taka.
--   own_price: the row of exactly this size (variant_id NULL = the
--              product's own size / a product without sizes).
-- normal = the offer when it is below retail, else retail.
-- price  = the lower of sale and normal.
CREATE OR REPLACE FUNCTION campaign_sale_price(p_product_id uuid, p_variant_id uuid, p_retail numeric, p_offer numeric)
RETURNS TABLE (campaign_id uuid, price numeric, normal numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id,
         LEAST(CASE WHEN c.discount_mode = 'percent'
                    THEN round(p_retail * (100 - c.percent) / 100)
                    ELSE ci.campaign_price END,
               CASE WHEN p_offer IS NOT NULL AND p_offer < p_retail THEN p_offer ELSE p_retail END),
         CASE WHEN p_offer IS NOT NULL AND p_offer < p_retail THEN p_offer ELSE p_retail END
  FROM campaigns c
  JOIN campaign_items ci ON ci.campaign_id = c.id
  WHERE c.is_enabled
    AND c.starts_at <= now() AND now() < c.ends_at
    AND ci.product_id = p_product_id
    AND CASE WHEN c.discount_mode = 'percent'
             THEN ci.variant_id IS NULL
             ELSE ci.variant_id IS NOT DISTINCT FROM p_variant_id AND ci.campaign_price IS NOT NULL END
  ORDER BY c.ends_at, c.id
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION campaign_sale_price(uuid, uuid, numeric, numeric) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------------
-- 2. Live campaigns for the shop (anyone)
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION live_campaigns()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(x.j ORDER BY x.ends_at, x.id), '[]'::jsonb)
  FROM (
    SELECT c.id, c.ends_at,
           jsonb_build_object(
             'id', c.id, 'name', c.name, 'slug', c.slug, 'style', c.style,
             'discount_mode', c.discount_mode, 'percent', c.percent,
             'starts_at', c.starts_at, 'ends_at', c.ends_at,
             'items', COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                        'product_id', ci.product_id, 'variant_id', ci.variant_id,
                        'campaign_price', ci.campaign_price, 'sort_order', ci.sort_order)
                      ORDER BY ci.sort_order, ci.id)
               FROM campaign_items ci WHERE ci.campaign_id = c.id), '[]'::jsonb)) AS j
    FROM campaigns c
    WHERE c.is_enabled AND c.starts_at <= now() AND now() < c.ends_at
  ) x;
$$;
REVOKE ALL ON FUNCTION live_campaigns() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION live_campaigns() TO anon, authenticated;

-- ------------------------------------------------------------------
-- 3. Admin: every campaign with its items and numbers
-- ------------------------------------------------------------------
-- Same permission as Promo Codes (promo_codes_admin_all: is_admin()).
CREATE OR REPLACE FUNCTION admin_campaigns()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Only the Super Admin can manage campaigns.';
  END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(x.j ORDER BY x.starts_at DESC, x.id), '[]'::jsonb)
    FROM (
      SELECT c.id, c.starts_at,
             jsonb_build_object(
               'id', c.id, 'name', c.name, 'slug', c.slug, 'style', c.style,
               'discount_mode', c.discount_mode, 'percent', c.percent,
               'starts_at', c.starts_at, 'ends_at', c.ends_at, 'is_enabled', c.is_enabled,
               'created_at', c.created_at, 'updated_at', c.updated_at,
               'items', COALESCE((
                 SELECT jsonb_agg(jsonb_build_object(
                          'product_id', ci.product_id, 'variant_id', ci.variant_id,
                          'campaign_price', ci.campaign_price, 'sort_order', ci.sort_order)
                        ORDER BY ci.sort_order, ci.id)
                 FROM campaign_items ci WHERE ci.campaign_id = c.id), '[]'::jsonb),
               'orders', COALESCE(s.orders, 0),
               'sold', COALESCE(s.sold, 0),
               'given_off', COALESCE(s.given_off, 0)) AS j
      FROM campaigns c
      LEFT JOIN LATERAL (
        SELECT count(DISTINCT oi.order_id) AS orders,
               sum(oi.line_total) AS sold,
               sum(GREATEST(COALESCE(oi.campaign_normal_price, oi.unit_price) - oi.unit_price, 0) * oi.quantity) AS given_off
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE oi.campaign_id = c.id AND o.status <> 'cancelled'
      ) s ON true
    ) x
  );
END;
$$;
REVOKE ALL ON FUNCTION admin_campaigns() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_campaigns() TO authenticated;

-- Shared check: no product of this (switched-on) campaign is in another
-- switched-on campaign whose dates overlap. Raises the shop's message.
CREATE OR REPLACE FUNCTION campaign_check_overlap(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row record;
BEGIN
  SELECT p.name AS product, o.name AS other
    INTO v_row
  FROM campaigns c
  JOIN campaign_items ci ON ci.campaign_id = c.id
  JOIN campaign_items oi ON oi.product_id = ci.product_id AND oi.campaign_id <> c.id
  JOIN campaigns o ON o.id = oi.campaign_id
  JOIN products p ON p.id = ci.product_id
  WHERE c.id = p_id AND c.is_enabled AND o.is_enabled
    AND o.starts_at < c.ends_at AND c.starts_at < o.ends_at
  ORDER BY ci.sort_order
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION '% is already in % at the same time.', v_row.product, v_row.other;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION campaign_check_overlap(uuid) FROM PUBLIC, anon, authenticated;

-- "1,250" / "1,250.50" for messages.
CREATE OR REPLACE FUNCTION campaign_taka(p numeric)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT '৳' || rtrim(rtrim(to_char(p, 'FM999,999,999,990.00'), '0'), '.');
$$;
REVOKE ALL ON FUNCTION campaign_taka(numeric) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------------
-- 4. Admin: create or update one campaign (items replaced)
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION admin_save_campaign(p jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id       uuid := NULLIF(p ->> 'id', '')::uuid;
  v_name     text := btrim(COALESCE(p ->> 'name', ''));
  v_style    text := COALESCE(NULLIF(p ->> 'style', ''), 'plain');
  v_mode     text := p ->> 'discount_mode';
  v_percent  numeric(5,2) := NULLIF(p ->> 'percent', '')::numeric;
  v_starts   timestamptz := NULLIF(p ->> 'starts_at', '')::timestamptz;
  v_ends     timestamptz := NULLIF(p ->> 'ends_at', '')::timestamptz;
  v_enabled  boolean := COALESCE((p ->> 'is_enabled')::boolean, true);
  v_items    jsonb := COALESCE(p -> 'items', '[]'::jsonb);
  v_item     jsonb;
  v_product  uuid;
  v_variant  uuid;
  v_price    numeric(10,2);
  v_retail   numeric;
  v_pname    text;
  v_base     text;
  v_slug     text;
  v_n        integer := 1;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Only the Super Admin can manage campaigns.';
  END IF;
  IF char_length(v_name) < 1 THEN
    RAISE EXCEPTION 'Give the campaign a name.';
  END IF;
  IF char_length(v_name) > 40 THEN
    RAISE EXCEPTION 'The name can be at most 40 characters.';
  END IF;
  IF v_style NOT IN ('plain', 'glitter') THEN
    RAISE EXCEPTION 'Choose Plain or Glitter.';
  END IF;
  IF v_mode IS NULL OR v_mode NOT IN ('percent', 'own_price') THEN
    RAISE EXCEPTION 'Choose how to discount.';
  END IF;
  IF v_mode = 'percent' AND (v_percent IS NULL OR v_percent <= 0 OR v_percent >= 100) THEN
    RAISE EXCEPTION 'Enter a %% above 0 and below 100.';
  END IF;
  IF v_mode = 'own_price' THEN
    v_percent := NULL;
  END IF;
  IF v_starts IS NULL OR v_ends IS NULL THEN
    RAISE EXCEPTION 'Choose when the campaign starts and ends.';
  END IF;
  IF v_ends <= v_starts THEN
    RAISE EXCEPTION 'The end must be after the start.';
  END IF;
  IF jsonb_typeof(v_items) <> 'array' OR jsonb_array_length(v_items) = 0 THEN
    RAISE EXCEPTION 'Add at least 1 product.';
  END IF;

  IF v_id IS NULL OR NOT EXISTS (SELECT 1 FROM campaigns WHERE id = v_id) THEN
    v_base := trim(both '-' from regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'));
    IF v_base = '' THEN
      v_base := 'sale';
    END IF;
    v_slug := v_base;
    WHILE EXISTS (SELECT 1 FROM campaigns WHERE slug = v_slug) LOOP
      v_n := v_n + 1;
      v_slug := v_base || '-' || v_n;
    END LOOP;
    INSERT INTO campaigns (id, name, slug, style, discount_mode, percent, starts_at, ends_at, is_enabled)
    VALUES (COALESCE(v_id, gen_random_uuid()), v_name, v_slug, v_style, v_mode, v_percent, v_starts, v_ends, v_enabled)
    RETURNING id INTO v_id;
  ELSE
    UPDATE campaigns
    SET name = v_name, style = v_style, discount_mode = v_mode, percent = v_percent,
        starts_at = v_starts, ends_at = v_ends, is_enabled = v_enabled, updated_at = now()
    WHERE id = v_id;
  END IF;

  DELETE FROM campaign_items WHERE campaign_id = v_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_product := NULLIF(v_item ->> 'product_id', '')::uuid;
    v_variant := NULLIF(v_item ->> 'variant_id', '')::uuid;
    IF v_variant = v_product THEN
      v_variant := NULL;
    END IF;
    v_price := NULLIF(v_item ->> 'campaign_price', '')::numeric;

    SELECT name, retail_price INTO v_pname, v_retail FROM products WHERE id = v_product;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'A product in the list no longer exists.';
    END IF;
    IF v_variant IS NOT NULL THEN
      SELECT retail_price INTO v_retail FROM product_variants WHERE id = v_variant AND product_id = v_product;
      IF NOT FOUND THEN
        RAISE EXCEPTION '%: this size no longer exists.', v_pname;
      END IF;
    END IF;

    IF v_mode = 'percent' THEN
      IF v_variant IS NOT NULL THEN
        RAISE EXCEPTION '%: the same %% covers every size, so add the product, not one size.', v_pname;
      END IF;
      v_price := NULL;
    ELSE
      IF v_price IS NULL OR v_price <= 0 OR v_price >= v_retail THEN
        RAISE EXCEPTION '%: the sale price must be below %.', v_pname, campaign_taka(v_retail);
      END IF;
    END IF;

    IF EXISTS (SELECT 1 FROM campaign_items
               WHERE campaign_id = v_id AND product_id = v_product AND variant_id IS NOT DISTINCT FROM v_variant) THEN
      RAISE EXCEPTION '% is in the list twice.', v_pname;
    END IF;

    INSERT INTO campaign_items (campaign_id, product_id, variant_id, campaign_price, sort_order)
    VALUES (v_id, v_product, v_variant, v_price, COALESCE((v_item ->> 'sort_order')::integer, 0));
  END LOOP;

  PERFORM campaign_check_overlap(v_id);
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION admin_save_campaign(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_save_campaign(jsonb) TO authenticated;

-- ------------------------------------------------------------------
-- 5. Admin: switch on / off, delete
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION admin_set_campaign_enabled(p_id uuid, p_on boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Only the Super Admin can manage campaigns.';
  END IF;
  UPDATE campaigns SET is_enabled = COALESCE(p_on, false), updated_at = now() WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This campaign no longer exists.';
  END IF;
  PERFORM campaign_check_overlap(p_id);
END;
$$;
REVOKE ALL ON FUNCTION admin_set_campaign_enabled(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_set_campaign_enabled(uuid, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION admin_delete_campaign(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Only the Super Admin can manage campaigns.';
  END IF;
  IF EXISTS (SELECT 1 FROM order_items WHERE campaign_id = p_id) THEN
    RAISE EXCEPTION 'This campaign has orders. Switch it off instead.';
  END IF;
  DELETE FROM campaigns WHERE id = p_id;
END;
$$;
REVOKE ALL ON FUNCTION admin_delete_campaign(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_delete_campaign(uuid) TO authenticated;

-- ------------------------------------------------------------------
-- 6. place_order_core: sale prices, and promo / advance skip sale items
-- ------------------------------------------------------------------
-- Today's definition (migration-061) with only these changes: each line
-- asks campaign_sale_price(); a sale line keeps its campaign and normal
-- price; the promo code and the advance discount are worked out on the
-- lines without a campaign (v_promo_base). When every line is a sale line
-- the promo code is ignored (no discount, not counted, not saved).
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
  -- Batch 66
  v_retail           numeric(10,2);
  v_offer            numeric(10,2);
  v_campaign_id      uuid;
  v_campaign_normal  numeric(10,2);
  v_sale_price       numeric(10,2);
  v_promo_base       numeric(10,2) := 0;
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
    tracked       boolean,
    campaign_id   uuid,
    campaign_normal numeric(10,2)
  ) ON COMMIT DROP;
  -- Batch 66: a temp table left from an earlier order in this session
  -- (same transaction) lacks the two new columns.
  ALTER TABLE _place_lines ADD COLUMN IF NOT EXISTS campaign_id uuid;
  ALTER TABLE _place_lines ADD COLUMN IF NOT EXISTS campaign_normal numeric(10,2);
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
      -- Batch 66: a live campaign's sale price.
      SELECT pv.retail_price, pv.offer_price INTO v_retail, v_offer FROM product_variants pv WHERE pv.id = v_variant_id;
      SELECT s.campaign_id, s.price, s.normal INTO v_campaign_id, v_sale_price, v_campaign_normal
      FROM campaign_sale_price(v_product_id, v_variant_id, v_retail, v_offer) s;
      IF v_campaign_id IS NOT NULL THEN
        v_unit_price := v_sale_price;
      ELSE
        v_campaign_normal := NULL;
      END IF;
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
      -- Batch 66: a live campaign's sale price.
      SELECT p.retail_price, p.offer_price INTO v_retail, v_offer FROM products p WHERE p.id = v_product_id;
      SELECT s.campaign_id, s.price, s.normal INTO v_campaign_id, v_sale_price, v_campaign_normal
      FROM campaign_sale_price(v_product_id, NULL, v_retail, v_offer) s;
      IF v_campaign_id IS NOT NULL THEN
        v_unit_price := v_sale_price;
      ELSE
        v_campaign_normal := NULL;
      END IF;
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
                              quantity, line_total, keep_selling, short_qty, tracked, campaign_id, campaign_normal)
    VALUES (v_product_id, v_variant_id, v_product_name, v_variant_label, v_image_url, v_unit_price,
            v_quantity, v_unit_price * v_quantity, v_keep, v_short, v_stock_quantity IS NOT NULL,
            v_campaign_id, v_campaign_normal);

    v_subtotal := v_subtotal + (v_unit_price * v_quantity);
    IF v_campaign_id IS NULL THEN
      v_promo_base := v_promo_base + (v_unit_price * v_quantity);
    END IF;

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

  -- Batch 66: the code works only on items not in a campaign; with none
  -- left it is ignored (no discount, not counted, saved as no code).
  IF p_promo_code IS NOT NULL AND trim(p_promo_code) <> '' AND v_promo_base > 0 THEN
    SELECT * INTO v_promo_row FROM promo_codes WHERE lower(code) = lower(trim(p_promo_code));
    IF NOT FOUND OR NOT v_promo_row.active
       OR (v_promo_row.max_uses IS NOT NULL AND v_promo_row.times_used >= v_promo_row.max_uses)
       OR (v_promo_row.expires_at IS NOT NULL AND v_promo_row.expires_at <= now()) THEN
      RAISE EXCEPTION 'This promo code is no longer valid.';
    END IF;

    v_discount := CASE WHEN v_promo_row.discount_type = 'percent'
                        THEN v_promo_base * v_promo_row.discount_amount / 100
                        ELSE v_promo_row.discount_amount END;
    v_discount := LEAST(GREATEST(v_discount, 0), v_promo_base);

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
      FROM advance_discount_amount(v_method, LEAST(v_promo_base - v_discount, v_left)) a;
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
    CASE WHEN v_promo_base > 0 THEN NULLIF(trim(COALESCE(p_promo_code, '')), '') END, v_total, v_method,
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
    INSERT INTO order_items (order_id, product_id, variant_id, product_name, variant_label, image_url, unit_price, quantity, line_total, list_price,
                             campaign_id, campaign_normal_price)
    VALUES (v_order_id, v_line.product_id, v_line.variant_id, v_line.product_name, v_line.variant_label,
            v_line.image_url, v_line.unit_price, v_line.quantity, v_line.line_total, v_line.unit_price,
            v_line.campaign_id, v_line.campaign_normal)
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

REVOKE ALL ON FUNCTION place_order_core(jsonb, text, text, text, text, text, text, text, text, text, text, text, text, numeric) FROM PUBLIC, anon, authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
