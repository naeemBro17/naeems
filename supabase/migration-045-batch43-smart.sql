-- =============================================================================
-- Batch 43 — Smart helpers: offer suggestions, next-trip buying list,
-- low-price warning on manual orders, investor report PDF
-- =============================================================================
-- Additive only: 6 new read-only functions. No table, column, trigger or
-- existing function is changed, dropped or renamed. Nothing here writes.
--
-- These are plain rules on the shop's own numbers (no "AI"):
--   * sales speed = the same lot sales as the Stock report and the monthly
--     count (report_units_sold_since, Batch 42);
--   * stock, expiry and landed cost = report_stock_rows (Batch 42) and the
--     lot rows (Batch 38 / 39);
--   * every profit and money number of the investor report comes from
--     money_summary / money_profit_parts / report_investors (Batch 41 / 42).
--     Nothing works profit out a second, different way.
--
-- Safe to run again.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- The shop's selling price of one pack (the offer price when it is lower),
-- the same rule as inventory_stock_units() and the shop.
CREATE OR REPLACE FUNCTION smart_selling_price(p_product_id uuid, p_variant_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_variant_id IS NULL THEN (
      SELECT CASE WHEN p.offer_price IS NOT NULL AND p.offer_price < p.retail_price THEN p.offer_price ELSE p.retail_price END
      FROM products p WHERE p.id = p_product_id)
    ELSE (
      SELECT CASE WHEN v.offer_price IS NOT NULL AND v.offer_price < v.retail_price THEN v.offer_price ELSE v.retail_price END
      FROM product_variants v WHERE v.id = p_variant_id)
  END;
$$;

REVOKE ALL ON FUNCTION smart_selling_price(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- How many days of sales history a product (or option) has: since the
-- first lot it was in (the opening stock counts), at most 90.
CREATE OR REPLACE FUNCTION smart_history_days(p_product_id uuid, p_variant_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT LEAST(90, GREATEST(0, inventory_dhaka_today() - min(l.lot_date)))::integer
  FROM lot_items li JOIN lots l ON l.id = li.lot_id
  WHERE li.product_id = p_product_id AND li.variant_id IS NOT DISTINCT FROM p_variant_id
    AND l.lot_date <= inventory_dhaka_today();
$$;

REVOKE ALL ON FUNCTION smart_history_days(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- PART 1 — "Give an offer": every lot row with units left (the Stock
-- report's rows), plus what the rules need: units sold in the last 90 days,
-- days of history, the selling price of a pack. The website applies the
-- rule (src/lib/smart/offers.ts) and shows the reason with every row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION smart_offer_rows()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  RETURN jsonb_build_object(
    'today', inventory_dhaka_today(),
    'inventory_mode', inventory_mode_on(),
    'rows', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'lot_item_id', r.lot_item_id, 'product_id', r.product_id, 'variant_id', r.variant_id,
               'label', r.label, 'stock_unit', r.stock_unit, 'pack_size', r.pack_size,
               'lot_code', r.lot_code, 'lot_date', r.lot_date, 'expiry_date', r.expiry_date,
               'units', r.units, 'units_before', r.units_before, 'unit_cost', r.unit_cost,
               'units_90', COALESCE(s.units, 0), 'last_sold', s.last_sold,
               'history_days', COALESCE(smart_history_days(r.product_id, r.variant_id), 0),
               'price', COALESCE(smart_selling_price(r.product_id, r.variant_id), 0))
             ORDER BY r.expiry_date, r.label, r.lot_code)
      FROM report_stock_rows() r
      LEFT JOIN report_units_sold_since(90) s
        ON s.product_id = r.product_id AND s.variant_id IS NOT DISTINCT FROM r.variant_id
      WHERE r.expiry_date IS NOT NULL), '[]'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION smart_offer_rows() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION smart_offer_rows() TO authenticated;

-- ---------------------------------------------------------------------------
-- PART 2 — next-trip buying list: one row per product (or option) that was
-- ever bought in a purchase lot, with where it is usually bought (the
-- supplier / country of most of its purchase lots; a tie → the newest),
-- what is left, what is on the way (a lot marked "costs pending" dated
-- after today), sales, and the newest landed cost and buy price.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION smart_buying_rows()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_today date := inventory_dhaka_today();
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  RETURN jsonb_build_object(
    'today', v_today,
    'inventory_mode', inventory_mode_on(),
    'suppliers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'country', s.country) ORDER BY lower(s.name))
      FROM suppliers s), '[]'::jsonb),
    'countries', COALESCE((
      SELECT jsonb_agg(c ORDER BY c) FROM (
        SELECT DISTINCT btrim(country) AS c FROM lots WHERE kind = 'purchase' AND btrim(country) <> ''
        UNION
        SELECT DISTINCT btrim(country) FROM suppliers WHERE btrim(country) <> '') x), '[]'::jsonb),
    'rows', COALESCE((
      WITH units AS (
        SELECT DISTINCT li.product_id, li.variant_id FROM lot_items li JOIN lots l ON l.id = li.lot_id WHERE l.kind = 'purchase'
      ), sup AS (
        SELECT DISTINCT ON (li.product_id, li.variant_id) li.product_id, li.variant_id, l.supplier_id
        FROM lot_items li JOIN lots l ON l.id = li.lot_id
        WHERE l.kind = 'purchase' AND l.supplier_id IS NOT NULL
        GROUP BY li.product_id, li.variant_id, l.supplier_id
        ORDER BY li.product_id, li.variant_id, count(DISTINCT l.id) DESC, max(l.lot_date) DESC
      ), ctry AS (
        SELECT DISTINCT ON (li.product_id, li.variant_id) li.product_id, li.variant_id, btrim(l.country) AS country
        FROM lot_items li JOIN lots l ON l.id = li.lot_id
        WHERE l.kind = 'purchase' AND btrim(l.country) <> ''
        GROUP BY li.product_id, li.variant_id, btrim(l.country)
        ORDER BY li.product_id, li.variant_id, count(DISTINCT l.id) DESC, max(l.lot_date) DESC
      ), stock AS (
        SELECT li.product_id, li.variant_id,
               sum(li.qty_remaining) FILTER (WHERE NOT (l.costs_pending AND l.lot_date > v_today)) AS left_units,
               sum(li.qty_remaining) FILTER (WHERE l.costs_pending AND l.lot_date > v_today) AS on_way
        FROM lot_items li JOIN lots l ON l.id = li.lot_id
        GROUP BY li.product_id, li.variant_id
      ), newest AS (
        SELECT DISTINCT ON (li.product_id, li.variant_id) li.product_id, li.variant_id,
               CASE WHEN li.qty > 0 THEN li.buy_value_bdt / li.qty ELSE 0 END AS buy_unit, l.lot_date
        FROM lot_items li JOIN lots l ON l.id = li.lot_id
        WHERE l.kind = 'purchase'
        ORDER BY li.product_id, li.variant_id, l.lot_date DESC, l.created_at DESC, li.sort_order DESC
      )
      SELECT jsonb_agg(jsonb_build_object(
               'product_id', u.product_id, 'variant_id', u.variant_id,
               'label', report_unit_label(u.product_id, u.variant_id),
               'stock_unit', inventory_stock_unit(u.product_id, u.variant_id),
               'pack_size', inventory_pack_size(u.product_id, u.variant_id),
               'supplier_id', sup.supplier_id, 'country', ctry.country,
               'units_left', COALESCE(st.left_units, 0), 'units_on_way', COALESCE(st.on_way, 0),
               'units_90', COALESCE(s90.units, 0),
               'history_days', COALESCE(smart_history_days(u.product_id, u.variant_id), 0),
               'last_sold', s90.last_sold,
               'sold_120', COALESCE((SELECT s.units FROM report_units_sold_since(120) s
                                     WHERE s.product_id = u.product_id AND s.variant_id IS NOT DISTINCT FROM u.variant_id), 0),
               'last_unit_cost', round(inventory_latest_unit_cost(u.product_id, u.variant_id), 2),
               'last_buy_unit', round(COALESCE(n.buy_unit, 0), 2),
               'last_bought', n.lot_date)
             ORDER BY lower(report_unit_label(u.product_id, u.variant_id)))
      FROM units u
      LEFT JOIN sup ON sup.product_id = u.product_id AND sup.variant_id IS NOT DISTINCT FROM u.variant_id
      LEFT JOIN ctry ON ctry.product_id = u.product_id AND ctry.variant_id IS NOT DISTINCT FROM u.variant_id
      LEFT JOIN stock st ON st.product_id = u.product_id AND st.variant_id IS NOT DISTINCT FROM u.variant_id
      LEFT JOIN newest n ON n.product_id = u.product_id AND n.variant_id IS NOT DISTINCT FROM u.variant_id
      LEFT JOIN report_units_sold_since(90) s90
        ON s90.product_id = u.product_id AND s90.variant_id IS NOT DISTINCT FROM u.variant_id), '[]'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION smart_buying_rows() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION smart_buying_rows() TO authenticated;

-- ---------------------------------------------------------------------------
-- PART 3 — "Below cost" on New order / Edit order.
--   p_lines: [{ product_id, variant_id, sold_unit (null = packs), price, quantity }]
-- Cost of what one quantity stands for = landed cost per unit of the lot row
-- that sells next (earliest expiry first, the same order sales take stock
-- in) × pack size (1 when sold in loose units). No units left in any lot →
-- the newest landed cost; never bought → no warning.
-- Anyone who may create or edit orders gets below = true / false; only
-- "View profit & costs" also gets the cost and the loss in taka.
-- Answers in the same order as p_lines.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION smart_below_cost(p_lines jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_view  boolean := money_can_view();
  v_out   jsonb := '[]'::jsonb;
  v_line  jsonb;
  v_pid   uuid;
  v_vid   uuid;
  v_unit  numeric;
  v_cost  numeric;
  v_price numeric;
  v_qty   integer;
  v_below boolean;
BEGIN
  IF NOT (v_view OR staff_can('create_orders') OR staff_can('edit_orders')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN
    RETURN '[]'::jsonb;
  END IF;
  IF jsonb_array_length(p_lines) > 200 THEN
    RAISE EXCEPTION 'Too many lines.';
  END IF;
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_pid := NULLIF(v_line ->> 'product_id', '')::uuid;
    v_vid := NULLIF(v_line ->> 'variant_id', '')::uuid;
    v_price := COALESCE(NULLIF(v_line ->> 'price', '')::numeric, 0);
    v_qty := GREATEST(COALESCE(NULLIF(v_line ->> 'quantity', '')::integer, 1), 1);
    v_unit := NULL;
    IF v_pid IS NOT NULL THEN
      SELECT li.landed_unit_cost_bdt INTO v_unit
      FROM lot_items li JOIN lots l ON l.id = li.lot_id
      WHERE li.product_id = v_pid AND li.variant_id IS NOT DISTINCT FROM v_vid AND li.qty_remaining > 0
      ORDER BY li.expiry_date ASC NULLS LAST, l.lot_date, (l.kind = 'opening') DESC, length(l.code), l.code, li.sort_order
      LIMIT 1;
      IF v_unit IS NULL THEN
        v_unit := NULLIF(inventory_latest_unit_cost(v_pid, v_vid), 0);
      END IF;
    END IF;
    IF v_unit IS NULL THEN
      v_out := v_out || jsonb_build_object('below', false, 'cost', NULL, 'loss', NULL);
      CONTINUE;
    END IF;
    v_cost := round(v_unit * CASE WHEN NULLIF(v_line ->> 'sold_unit', '') IS NULL THEN inventory_pack_size(v_pid, v_vid) ELSE 1 END, 2);
    v_below := v_price < v_cost;
    v_out := v_out || jsonb_build_object(
      'below', v_below,
      'cost', CASE WHEN v_view THEN v_cost END,
      'loss', CASE WHEN v_view AND v_below THEN round((v_cost - v_price) * v_qty, 2) END);
  END LOOP;
  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION smart_below_cost(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION smart_below_cost(jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- PART 4 — the investor report (one A4 page). Every number is taken from
-- the functions the Money page and Reports use:
--   sales, net profit           money_summary(from, to) -> profit
--   return on money %           money_summary(from, to) -> roi -> percent
--   capital in / returned / owed, profit share paid in the period
--                               report_investors(from, to), this investor
--   the year's monthly table    money_profit_parts per month (as the
--                               Profit & loss report's month columns)
-- No product costs, no customer names.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION report_investor_statement(p_investor uuid, p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_summary jsonb;
  v_inv     jsonb;
  v_months  jsonb := '[]'::jsonb;
  v_m       record;
  v_p       jsonb;
  v_year_from date;
  v_year_to   date;
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  PERFORM report_check_range(p_from, p_to);
  SELECT x INTO v_inv FROM jsonb_array_elements(report_investors(p_from, p_to)) x WHERE (x ->> 'id')::uuid = p_investor;
  IF v_inv IS NULL THEN
    RAISE EXCEPTION 'Investor not found.';
  END IF;
  v_summary := money_summary(p_from, p_to);
  v_year_from := date_trunc('year', p_to)::date;
  v_year_to := LEAST((date_trunc('year', p_to) + interval '1 year - 1 day')::date, inventory_dhaka_today());
  IF v_year_to >= v_year_from THEN
    FOR v_m IN SELECT * FROM report_months(v_year_from, v_year_to) LOOP
      v_p := money_profit_parts(v_m.m_from, v_m.m_to);
      v_months := v_months || jsonb_build_object('month', v_m.month, 'sales', (v_p ->> 'sales')::numeric,
                                                 'net_profit', (v_p ->> 'net_profit')::numeric);
    END LOOP;
  END IF;
  RETURN jsonb_build_object(
    'from', p_from, 'to', p_to,
    'sales', (v_summary -> 'profit' ->> 'sales')::numeric,
    'net_profit', (v_summary -> 'profit' ->> 'net_profit')::numeric,
    'roi_percent', (v_summary -> 'roi' ->> 'percent')::numeric,
    'investor', v_inv,
    'year', extract(year FROM p_to)::integer,
    'months', v_months,
    'start_date', money_start_date());
END;
$$;

REVOKE ALL ON FUNCTION report_investor_statement(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION report_investor_statement(uuid, date, date) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
