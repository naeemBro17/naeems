-- =====================================================================
-- Batch 54 — "Merge old data" on each customer's page
--
-- Paste the whole file into the Supabase SQL Editor and press Run.
-- It is safe to run more than once.
--
-- Old Kaarbar bills stay HISTORY ONLY, exactly as Batch 50 designed:
-- nothing here touches stock, lots, orders, money accounts, money
-- movements, dues, previous balances or money_profit_parts.
--
--   kaarbar_bills            + paid_amount, due_amount, note (nullable —
--                              bills from the bulk Step 2 stay empty)
--   kaarbar_imports          + customer_key, and a new kind 'merge'
--   kaarbar_save_item_row    one Step 1 item row (shared by Step 1 and the
--                              merge); rows may now carry product_name
--   kaarbar_save_items       Step 1 save — same as before, via the helper
--   kaarbar_merge_customer   saves the items, then the bills, of ONE
--                              customer in one call (all or nothing)
--   kaarbar_undo_customer_merge  removes that customer's merged bills
--   kaarbar_customer_old_bills   + paid, due, note, merge date, matches
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------
ALTER TABLE kaarbar_bills ADD COLUMN IF NOT EXISTS paid_amount numeric;
ALTER TABLE kaarbar_bills ADD COLUMN IF NOT EXISTS due_amount numeric;
ALTER TABLE kaarbar_bills ADD COLUMN IF NOT EXISTS note text;

ALTER TABLE kaarbar_imports ADD COLUMN IF NOT EXISTS customer_key text;
ALTER TABLE kaarbar_imports DROP CONSTRAINT IF EXISTS kaarbar_imports_kind_check;
ALTER TABLE kaarbar_imports ADD CONSTRAINT kaarbar_imports_kind_check
  CHECK (kind IN ('customers', 'expenses', 'products', 'sales', 'merge'));
CREATE INDEX IF NOT EXISTS idx_kaarbar_imports_customer
  ON kaarbar_imports (customer_key) WHERE customer_key IS NOT NULL;

-- ---------------------------------------------------------------------
-- 2. One Step 1 item row (the body of Batch 50's kaarbar_save_items, now
--    shared). New: an optional product_name for the hidden product made
--    by "Add as new" (else it is named after the Kaarbar item, as before).
--    Returns {added, updated, created} for this row.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kaarbar_save_item_row(p_row jsonb, p_import uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key      text;
  v_name     text;
  v_pname    text;
  v_how      text;
  v_cost     numeric;
  v_units    jsonb;
  v_unit     text;
  v_pid      uuid;
  v_vid      uuid;
  v_made     uuid;
  v_item     kaarbar_items%ROWTYPE;
  v_created  integer := 0;
  v_sku      text;
  v_try      integer;
BEGIN
  v_key := btrim(COALESCE(p_row ->> 'name_key', ''));
  v_name := regexp_replace(btrim(COALESCE(p_row ->> 'kaarbar_name', '')), '\s+', ' ', 'g');
  v_pname := NULLIF(regexp_replace(btrim(COALESCE(p_row ->> 'product_name', '')), '\s+', ' ', 'g'), '');
  v_how := p_row ->> 'choice';
  v_cost := round(NULLIF(p_row ->> 'cost_per_pack', '')::numeric, 2);
  v_units := COALESCE(p_row -> 'unit_costs', '{}'::jsonb);
  IF v_key = '' OR v_name = '' THEN
    RAISE EXCEPTION 'An item has no name. Read the file again.';
  END IF;
  IF v_how IS NULL OR v_how NOT IN ('auto', 'hand', 'hidden') THEN
    RAISE EXCEPTION 'Pick a site product for "%".', v_name;
  END IF;
  IF v_cost IS NULL OR v_cost <= 0 OR v_cost >= 100000000 THEN
    RAISE EXCEPTION 'Type the buying price of "%".', v_name;
  END IF;
  IF jsonb_typeof(v_units) <> 'object' THEN
    RAISE EXCEPTION 'The prices per piece of "%" are not readable.', v_name;
  END IF;
  FOR v_unit IN SELECT jsonb_object_keys(v_units) LOOP
    IF v_unit !~ '^[a-z]{1,12}$' OR jsonb_typeof(v_units -> v_unit) <> 'number' OR (v_units ->> v_unit)::numeric <= 0 THEN
      RAISE EXCEPTION 'The price per % of "%" must be above 0.', v_unit, v_name;
    END IF;
  END LOOP;

  SELECT * INTO v_item FROM kaarbar_items WHERE name_key = v_key FOR UPDATE;

  IF v_how = 'hidden' THEN
    v_made := CASE WHEN v_item.id IS NOT NULL AND EXISTS (SELECT 1 FROM products WHERE id = v_item.made_product_id)
                   THEN v_item.made_product_id END;
    IF v_made IS NULL THEN
      -- Made like the product editor makes one: generated SKU (no
      -- category → XX-), slug from the name. Hidden, no picture, no stock.
      FOR v_try IN 1..5 LOOP
        v_sku := kaarbar_next_sku();
        BEGIN
          INSERT INTO products (sku, name, slug, retail_price, stock_status, stock_quantity, is_active, note)
          VALUES (v_sku, left(COALESCE(v_pname, v_name), 300), kaarbar_unique_slug(COALESCE(v_pname, v_name)), 0,
                  'out_of_stock', 0, false, 'Made by the Kaarbar import for old sales. Hidden.')
          RETURNING id INTO v_made;
          EXIT;
        EXCEPTION WHEN unique_violation THEN
          IF v_try = 5 THEN RAISE; END IF;
        END;
      END LOOP;
      v_created := 1;
    END IF;
    -- Its buying price (one pack = one unit: pack size 1).
    INSERT INTO product_buying_prices (product_id, variant_id, unit_cost_bdt, updated_by)
    VALUES (v_made, NULL, v_cost, auth.uid())
    ON CONFLICT (product_id, COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))
    DO UPDATE SET unit_cost_bdt = EXCLUDED.unit_cost_bdt, updated_at = now(), updated_by = auth.uid();
    v_pid := v_made;
    v_vid := NULL;
  ELSE
    v_pid := NULLIF(p_row ->> 'product_id', '')::uuid;
    v_vid := NULLIF(p_row ->> 'variant_id', '')::uuid;
    IF NOT EXISTS (SELECT 1 FROM products WHERE id = v_pid) THEN
      RAISE EXCEPTION 'The site product picked for "%" is not on the site any more. Pick again.', v_name;
    END IF;
    IF v_vid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM product_variants WHERE id = v_vid AND product_id = v_pid) THEN
      RAISE EXCEPTION 'The option picked for "%" is not on the site any more. Pick again.', v_name;
    END IF;
    v_made := v_item.made_product_id;
  END IF;

  IF v_item.id IS NULL THEN
    INSERT INTO kaarbar_items (name_key, kaarbar_name, kaarbar_price, product_id, variant_id, made_product_id,
                               match_how, cost_per_pack, unit_costs, import_id, updated_by_username)
    VALUES (v_key, v_name, COALESCE(NULLIF(p_row ->> 'kaarbar_price', '')::numeric, 0), v_pid, v_vid, v_made,
            v_how, v_cost, v_units, p_import, current_actor_username());
    RETURN jsonb_build_object('added', 1, 'updated', 0, 'created', v_created);
  END IF;
  UPDATE kaarbar_items
  SET kaarbar_name = v_name,
      kaarbar_price = COALESCE(NULLIF(p_row ->> 'kaarbar_price', '')::numeric, kaarbar_price),
      product_id = v_pid, variant_id = v_vid, made_product_id = v_made, match_how = v_how,
      cost_per_pack = v_cost,
      -- Prices per piece / per ml typed before are kept.
      unit_costs = kaarbar_items.unit_costs || v_units,
      import_id = p_import, updated_at = now(), updated_by_username = current_actor_username()
  WHERE id = v_item.id;
  RETURN jsonb_build_object('added', 0, 'updated', 1, 'created', v_created);
END;
$$;

REVOKE ALL ON FUNCTION kaarbar_save_item_row(jsonb, uuid) FROM PUBLIC, anon, authenticated;

-- Step 1 save: the same as Batch 50 (each row through the helper above).
CREATE OR REPLACE FUNCTION kaarbar_save_items(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_import   uuid;
  v_row      jsonb;
  v_r        jsonb;
  v_added    integer := 0;
  v_updated  integer := 0;
  v_created  integer := 0;
BEGIN
  PERFORM kaarbar_require(true);
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'There is nothing to save.';
  END IF;

  INSERT INTO kaarbar_imports (kind, created_by, created_by_username)
  VALUES ('products', auth.uid(), current_actor_username())
  RETURNING id INTO v_import;

  -- One summary line in the Activity Log, not one per hidden product.
  PERFORM set_config('app.activity_quiet', 'on', true);
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_r := kaarbar_save_item_row(v_row, v_import);
    v_added := v_added + (v_r ->> 'added')::integer;
    v_updated := v_updated + (v_r ->> 'updated')::integer;
    v_created := v_created + (v_r ->> 'created')::integer;
  END LOOP;
  PERFORM set_config('app.activity_quiet', 'off', true);

  UPDATE kaarbar_imports SET row_count = v_added + v_updated WHERE id = v_import;
  PERFORM write_activity('kaarbar.products_saved', 'kaarbar_import', v_import::text, 'Kaarbar products',
    format('Saved the Kaarbar product list: %s new, %s updated, %s hidden products made', v_added, v_updated, v_created),
    jsonb_build_object('added', v_added, 'updated', v_updated, 'hidden_made', v_created));
  RETURN jsonb_build_object('added', v_added, 'updated', v_updated, 'hidden_made', v_created);
END;
$$;

REVOKE ALL ON FUNCTION kaarbar_save_items(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION kaarbar_save_items(jsonb) TO authenticated;

-- ---------------------------------------------------------------------
-- 3. Merge one customer's old bills
--
-- p_items: Step 1 rows (as kaarbar_save_items) for the items made or
--          changed on the review page.
-- p_bills: [{kind, bill_no, date, party_name, party_phone, items_total,
--            bill_discount, delivery, bill_total, paid_amount, due_amount,
--            note, lines: [{name_key | item_id, kaarbar_name, quantity,
--            unit, rate, line_discount, line_total}]}]
-- The same rules as kaarbar_import_sales. Every bill is linked to THIS
-- customer (key and phone). A bill already added is skipped. One call:
-- if anything is wrong nothing at all is saved.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kaarbar_merge_customer(p_customer_key text, p_items jsonb, p_bills jsonb, p_phone text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ckey    text := NULLIF(btrim(COALESCE(p_customer_key, '')), '');
  v_pk      text;
  v_import  uuid;
  v_row     jsonb;
  v_r       jsonb;
  v_b       jsonb;
  v_l       jsonb;
  v_kind    text;
  v_no      text;
  v_date    date;
  v_bill    uuid;
  v_item    kaarbar_items%ROWTYPE;
  v_unit    text;
  v_qty     numeric;
  v_items   numeric;
  v_disc    numeric;
  v_del     numeric;
  v_total   numeric;
  v_sum     numeric;
  v_n       integer;
  v_i_added   integer := 0;
  v_i_updated integer := 0;
  v_i_made    integer := 0;
  v_added   integer := 0;
  v_skipped integer := 0;
  v_amount  numeric := 0;
BEGIN
  PERFORM kaarbar_require(true);
  IF v_ckey IS NULL THEN
    RAISE EXCEPTION 'Open the customer again.';
  END IF;
  IF jsonb_typeof(p_bills) IS DISTINCT FROM 'array' OR jsonb_array_length(p_bills) = 0 THEN
    RAISE EXCEPTION 'There is nothing to merge.';
  END IF;
  IF p_items IS NOT NULL AND jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'The items are not readable. Upload the PDF again.';
  END IF;
  v_pk := COALESCE(bd_phone_key(p_phone), CASE WHEN v_ckey LIKE 'ph:%' THEN NULLIF(substr(v_ckey, 4), '') END);

  INSERT INTO kaarbar_imports (kind, customer_key, created_by, created_by_username)
  VALUES ('merge', v_ckey, auth.uid(), current_actor_username())
  RETURNING id INTO v_import;

  -- 1) The items made or changed on the page.
  PERFORM set_config('app.activity_quiet', 'on', true);
  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) LOOP
    v_r := kaarbar_save_item_row(v_row, v_import);
    v_i_added := v_i_added + (v_r ->> 'added')::integer;
    v_i_updated := v_i_updated + (v_r ->> 'updated')::integer;
    v_i_made := v_i_made + (v_r ->> 'created')::integer;
  END LOOP;
  PERFORM set_config('app.activity_quiet', 'off', true);

  -- 2) The bills.
  FOR v_b IN SELECT * FROM jsonb_array_elements(p_bills) LOOP
    v_kind := COALESCE(v_b ->> 'kind', 'sale');
    v_no := btrim(COALESCE(v_b ->> 'bill_no', ''));
    v_date := NULLIF(v_b ->> 'date', '')::date;
    v_items := round(NULLIF(v_b ->> 'items_total', '')::numeric, 2);
    v_disc := round(COALESCE(NULLIF(v_b ->> 'bill_discount', '')::numeric, 0), 2);
    v_del := round(COALESCE(NULLIF(v_b ->> 'delivery', '')::numeric, 0), 2);
    v_total := round(NULLIF(v_b ->> 'bill_total', '')::numeric, 2);
    IF v_kind NOT IN ('sale', 'return') OR v_no = '' THEN
      RAISE EXCEPTION 'A bill has no bill number. Upload the PDF again.';
    END IF;
    IF v_date IS NULL OR v_date > kaarbar_old_sales_cutoff() THEN
      RAISE EXCEPTION 'Bill % is after %: those sales are already on the site.', v_no, to_char(kaarbar_old_sales_cutoff(), 'DD Mon YYYY');
    END IF;
    IF money_month_locked(v_date) THEN
      RAISE EXCEPTION '% is locked: bill % can''t be added.', to_char(v_date, 'FMMonth YYYY'), v_no;
    END IF;
    IF v_items IS NULL OR v_total IS NULL OR v_total < 0 OR v_del < 0 THEN
      RAISE EXCEPTION 'Bill % has no total.', v_no;
    END IF;
    IF v_disc < -1 OR abs(v_items + v_del - v_disc - v_total) > 1 THEN
      RAISE EXCEPTION 'Bill %: the lines, delivery and discount do not add up to the bill total.', v_no;
    END IF;
    IF jsonb_typeof(v_b -> 'lines') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Bill % has no items.', v_no;
    END IF;
    IF EXISTS (SELECT 1 FROM kaarbar_bills WHERE kind = v_kind AND bill_no = v_no) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    INSERT INTO kaarbar_bills (kind, bill_no, bill_date, customer_key, phone_key, party_name, party_phone,
                               items_total, bill_discount, delivery, bill_total, paid_amount, due_amount, note, import_id)
    VALUES (v_kind, v_no, v_date, v_ckey, v_pk,
            COALESCE(NULLIF(btrim(COALESCE(v_b ->> 'party_name', '')), ''), 'Kaarbar party'),
            NULLIF(btrim(COALESCE(v_b ->> 'party_phone', '')), ''),
            v_items, v_disc, v_del, v_total,
            round(NULLIF(v_b ->> 'paid_amount', '')::numeric, 2),
            round(NULLIF(v_b ->> 'due_amount', '')::numeric, 2),
            NULLIF(left(btrim(COALESCE(v_b ->> 'note', '')), 200), ''),
            v_import)
    RETURNING id INTO v_bill;

    v_n := 0;
    v_sum := 0;
    FOR v_l IN SELECT * FROM jsonb_array_elements(v_b -> 'lines') LOOP
      v_n := v_n + 1;
      v_item := NULL;
      IF NULLIF(v_l ->> 'item_id', '') IS NOT NULL THEN
        SELECT * INTO v_item FROM kaarbar_items WHERE id = (v_l ->> 'item_id')::uuid;
      ELSE
        SELECT * INTO v_item FROM kaarbar_items WHERE name_key = btrim(COALESCE(v_l ->> 'name_key', ''));
      END IF;
      IF v_item.id IS NULL THEN
        RAISE EXCEPTION 'Bill %: "%" is not on the site. Pick a product or add it as new.', v_no, v_l ->> 'kaarbar_name';
      END IF;
      IF v_item.product_id IS NULL THEN
        RAISE EXCEPTION '"%" has no site product any more. Match it again.', v_item.kaarbar_name;
      END IF;
      v_unit := NULLIF(lower(btrim(COALESCE(v_l ->> 'unit', ''))), '');
      v_qty := NULLIF(v_l ->> 'quantity', '')::numeric;
      IF v_qty IS NULL OR v_qty <= 0 THEN
        RAISE EXCEPTION 'Bill %: "%" has no quantity.', v_no, v_item.kaarbar_name;
      END IF;
      IF kaarbar_line_unit_cost(v_item, v_unit) IS NULL THEN
        RAISE EXCEPTION 'Type the buying price of 1 % of "%" first.', v_unit, v_item.kaarbar_name;
      END IF;
      INSERT INTO kaarbar_bill_lines (bill_id, line_no, item_id, kaarbar_name, quantity, unit, rate, line_discount, line_total)
      VALUES (v_bill, v_n, v_item.id, COALESCE(NULLIF(btrim(COALESCE(v_l ->> 'kaarbar_name', '')), ''), v_item.kaarbar_name),
              v_qty, v_unit,
              round(COALESCE(NULLIF(v_l ->> 'rate', '')::numeric, 0), 4),
              round(COALESCE(NULLIF(v_l ->> 'line_discount', '')::numeric, 0), 2),
              round(COALESCE(NULLIF(v_l ->> 'line_total', '')::numeric, 0), 2));
      v_sum := v_sum + round(COALESCE(NULLIF(v_l ->> 'line_total', '')::numeric, 0), 2);
    END LOOP;
    IF v_n = 0 THEN
      RAISE EXCEPTION 'Bill % has no items.', v_no;
    END IF;
    IF abs(v_sum - v_items) > 1 THEN
      RAISE EXCEPTION 'Bill %: the item lines do not add up.', v_no;
    END IF;
    v_added := v_added + 1;
    v_amount := v_amount + CASE WHEN v_kind = 'return' THEN -v_total ELSE v_total END;
  END LOOP;

  -- A hidden product the import made with no shop price yet gets the
  -- latest price it was sold for in Kaarbar (by the pack) — as Step 2.
  PERFORM set_config('app.activity_quiet', 'on', true);
  UPDATE products p
  SET retail_price = x.rate, updated_at = now()
  FROM (
    SELECT DISTINCT ON (i.made_product_id) i.made_product_id AS pid, l.rate
    FROM kaarbar_items i
    JOIN kaarbar_bill_lines l ON l.item_id = i.id AND l.unit IS NULL AND l.rate > 0
    JOIN kaarbar_bills b ON b.id = l.bill_id AND b.kind = 'sale'
    WHERE i.made_product_id IS NOT NULL AND i.product_id = i.made_product_id
    ORDER BY i.made_product_id, b.bill_date DESC, b.created_at DESC
  ) x
  WHERE p.id = x.pid AND p.retail_price = 0 AND NOT p.is_active;
  PERFORM set_config('app.activity_quiet', 'off', true);

  UPDATE kaarbar_imports SET row_count = v_added, total_amount = v_amount WHERE id = v_import;
  PERFORM write_activity('kaarbar.customer_merged', 'kaarbar_import', v_import::text, 'Kaarbar old sales',
    format('Merged %s old Kaarbar bills (%s) into customer %s%s', v_added, money_short(v_amount), v_ckey,
           CASE WHEN v_skipped > 0 THEN format(', %s already added skipped', v_skipped) ELSE '' END),
    jsonb_build_object('customer_key', v_ckey, 'added', v_added, 'skipped', v_skipped, 'total', v_amount,
                       'items_added', v_i_added, 'items_updated', v_i_updated, 'hidden_made', v_i_made));
  RETURN jsonb_build_object('import_id', v_import, 'added', v_added, 'skipped', v_skipped, 'total', v_amount,
                            'items_added', v_i_added, 'items_updated', v_i_updated, 'hidden_made', v_i_made);
END;
$$;

REVOKE ALL ON FUNCTION kaarbar_merge_customer(text, jsonb, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION kaarbar_merge_customer(text, jsonb, jsonb, text) TO authenticated;

-- ---------------------------------------------------------------------
-- 4. Undo a customer's merge: removes the bills of this customer's merges
--    (bills in a locked month are kept and listed — the same rule as
--    kaarbar_undo_sales). Items and products are never deleted.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kaarbar_undo_customer_merge(p_customer_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ckey    text := NULLIF(btrim(COALESCE(p_customer_key, '')), '');
  v_imports uuid[];
  v_kept    jsonb;
  v_removed integer;
  v_total   numeric;
BEGIN
  PERFORM kaarbar_require(true);
  SELECT array_agg(id) INTO v_imports FROM (
    SELECT id FROM kaarbar_imports
    WHERE kind = 'merge' AND customer_key = v_ckey AND undone_at IS NULL
    FOR UPDATE
  ) x;
  IF v_ckey IS NULL OR v_imports IS NULL THEN
    RAISE EXCEPTION 'There is no merge to undo.';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('bill_no', b.bill_no, 'date', b.bill_date, 'amount', b.bill_total,
                                               'reason', 'month is locked') ORDER BY b.bill_date), '[]'::jsonb)
  INTO v_kept
  FROM kaarbar_bills b WHERE b.import_id = ANY (v_imports) AND money_month_locked(b.bill_date);

  SELECT count(*), COALESCE(sum(CASE WHEN kind = 'return' THEN -bill_total ELSE bill_total END), 0)
  INTO v_removed, v_total
  FROM kaarbar_bills WHERE import_id = ANY (v_imports) AND NOT money_month_locked(bill_date);
  DELETE FROM kaarbar_bills WHERE import_id = ANY (v_imports) AND NOT money_month_locked(bill_date);

  UPDATE kaarbar_imports SET undone_at = now(), undone_by_username = current_actor_username(), undo_kept = v_kept
  WHERE id = ANY (v_imports);
  PERFORM write_activity('kaarbar.customer_merge_undone', 'kaarbar_import', v_ckey, 'Kaarbar old sales',
    format('Undid the merge of customer %s: removed %s old bills (%s)%s', v_ckey, v_removed, money_short(v_total),
           CASE WHEN jsonb_array_length(v_kept) > 0 THEN format(', kept %s in locked months', jsonb_array_length(v_kept)) ELSE '' END),
    jsonb_build_object('customer_key', v_ckey, 'removed', v_removed, 'total', v_total, 'kept', v_kept));
  RETURN jsonb_build_object('removed', v_removed, 'total', v_total, 'kept', v_kept);
END;
$$;

REVOKE ALL ON FUNCTION kaarbar_undo_customer_merge(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION kaarbar_undo_customer_merge(text) TO authenticated;

-- ---------------------------------------------------------------------
-- 5. The customer page: old bills + paid, due, note, when merged, and per
--    line the item and the site product it counts as.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kaarbar_customer_old_bills(p_customer_key text, p_phone text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pk text := bd_phone_key(p_phone);
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'id', b.id, 'kind', b.kind, 'bill_no', b.bill_no, 'date', b.bill_date,
             'items_total', b.items_total, 'bill_discount', b.bill_discount, 'delivery', b.delivery,
             'bill_total', b.bill_total,
             'paid_amount', b.paid_amount, 'due_amount', b.due_amount, 'note', b.note,
             'merged_at', imp.created_at, 'from_merge', imp.kind = 'merge',
             'lines', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                                'name', l.kaarbar_name, 'quantity', l.quantity, 'unit', l.unit, 'rate', l.rate,
                                'line_discount', l.line_discount, 'line_total', l.line_total,
                                'item_id', l.item_id, 'name_key', i.name_key, 'match_how', i.match_how,
                                'product_id', i.product_id, 'variant_id', i.variant_id,
                                'product_name', p.name,
                                'option', NULLIF(concat_ws(' · ', NULLIF(btrim(v.region), ''), NULLIF(btrim(v.size), '')), ''))
                              ORDER BY l.line_no), '[]'::jsonb)
                       FROM kaarbar_bill_lines l
                       JOIN kaarbar_items i ON i.id = l.item_id
                       LEFT JOIN products p ON p.id = i.product_id
                       LEFT JOIN product_variants v ON v.id = i.variant_id
                       WHERE l.bill_id = b.id))
           ORDER BY b.bill_date DESC, b.bill_no DESC)
    FROM kaarbar_bills b
    LEFT JOIN kaarbar_imports imp ON imp.id = b.import_id
    WHERE (v_pk IS NOT NULL AND b.phone_key = v_pk)
       OR (p_customer_key IS NOT NULL AND b.customer_key = p_customer_key)), '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION kaarbar_customer_old_bills(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION kaarbar_customer_old_bills(text, text) TO authenticated;

COMMIT;
