-- ============================================================
-- Batch 38 — Inventory foundation (reports/batch-38.txt).
--
--   Weight      products.weight_grams / weight_source and the same two on
--               product_variants (stock lives at both levels: a product
--               with no options keeps its stock on the product, a product
--               with options keeps it on each option). Filled with an
--               estimate from the size in the size field or the name, once
--               now for everything and automatically for new rows. A
--               'manual' weight is never overwritten.
--   lots        one row per shipment / buying trip (L-001, L-002 …); the
--               single opening-stock lot is L-000.
--   lot_costs   the lot's bills: 'weight' (shared by grams) and 'other'
--               (shared by buy value). Late bills are more rows.
--   lot_items   what came in each lot, with the landed cost per piece.
--   stock_movements  the stock ledger. lot_items.qty_remaining is ALWAYS
--               the sum of its movements (kept by a trigger).
--   inventory_mode   app_settings row, 'false'. It cannot be switched on in
--               this batch (a trigger refuses it): until Batch 39 makes
--               sales take pieces out of lots, lots would drift from the
--               shop's real stock.
--
-- Nothing here changes a product's stock number, checkout, orders or any
-- existing function. Lots are a separate record.
--
-- Who can see / change it: only staff_can('view_profit_costs') — the
-- Super Admin always, staff only with "View profit & costs" switched on.
-- The tables are readable only with that permission (RLS); every write
-- goes through the SECURITY DEFINER functions below, which check it again.
--
-- Additive only: new tables, new nullable columns, new functions and
-- triggers, one new settings row. Nothing is dropped, renamed or changed.
-- Safe to run more than once.
-- ============================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- PART 1 — weight at the stock level
-- ---------------------------------------------------------------------------
ALTER TABLE products ADD COLUMN IF NOT EXISTS weight_grams numeric(10,2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS weight_source text;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS weight_grams numeric(10,2);
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS weight_source text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_weight_check') THEN
    ALTER TABLE products ADD CONSTRAINT products_weight_check
      CHECK ((weight_grams IS NULL OR weight_grams > 0)
         AND (weight_source IS NULL OR weight_source IN ('estimated', 'manual')));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_variants_weight_check') THEN
    ALTER TABLE product_variants ADD CONSTRAINT product_variants_weight_check
      CHECK ((weight_grams IS NULL OR weight_grams > 0)
         AND (weight_source IS NULL OR weight_source IN ('estimated', 'manual')));
  END IF;
END $$;

-- The new columns get no column grant, so the shop (anon / customers) can
-- never read them; the Inventory screens read them through
-- inventory_stock_units() below.

-- Estimated packed weight in whole grams from a size written in text
-- ("473 ml", "50g", "1.5 L", "8 fl oz"), or NULL when there is no size.
--   ml × 1.15 · l × 1000 × 1.15 · g × 1.10 · kg × 1000 × 1.10
--   fl oz × 29.57 × 1.15 · oz × 28.35 × 1.10
-- The same rule is in src/lib/inventory/weight.ts (the screens' preview);
-- e2e/batch-38.spec.ts checks both give the same answers.
CREATE OR REPLACE FUNCTION inventory_estimate_weight(p_text text)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_match  text[];
  v_amount numeric;
  v_unit   text;
  v_grams  numeric;
BEGIN
  IF p_text IS NULL OR btrim(p_text) = '' THEN
    RETURN NULL;
  END IF;
  v_match := regexp_match(
    lower(p_text),
    '(?:^|[^0-9a-z.])([0-9]+(?:\.[0-9]+)?)\s*(fl\.?\s*oz|millilitres?|milliliters?|ml|litres?|liters?|ltrs?|l|kgs?|grams?|gms?|g|oz)(?![a-z])'
  );
  IF v_match IS NULL THEN
    RETURN NULL;
  END IF;
  v_amount := v_match[1]::numeric;
  v_unit := regexp_replace(v_match[2], '[[:space:].]', '', 'g');
  v_grams := CASE
    WHEN v_unit = 'floz' THEN v_amount * 34.0055                         -- 29.57 × 1.15
    WHEN v_unit IN ('ml', 'millilitre', 'millilitres', 'milliliter', 'milliliters') THEN v_amount * 1.15
    WHEN v_unit IN ('l', 'litre', 'litres', 'liter', 'liters', 'ltr', 'ltrs') THEN v_amount * 1150
    WHEN v_unit IN ('g', 'gm', 'gms', 'gram', 'grams') THEN v_amount * 1.10
    WHEN v_unit IN ('kg', 'kgs') THEN v_amount * 1100
    WHEN v_unit = 'oz' THEN v_amount * 31.185                            -- 28.35 × 1.10
  END;
  v_grams := round(v_grams);
  IF v_grams IS NULL OR v_grams <= 0 OR v_grams > 100000 THEN
    RETURN NULL;
  END IF;
  RETURN v_grams;
EXCEPTION WHEN OTHERS THEN
  -- Never let an odd size stop a product from saving.
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION inventory_estimate_weight(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory_estimate_weight(text) TO authenticated;

-- New products (and a renamed / re-sized product whose weight is still an
-- estimate) get the estimate. A manual weight is left alone.
CREATE OR REPLACE FUNCTION inventory_fill_product_weight()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_grams numeric;
BEGIN
  IF NEW.weight_source IS NOT DISTINCT FROM 'manual' THEN
    RETURN NEW;
  END IF;
  v_grams := COALESCE(inventory_estimate_weight(NEW.size), inventory_estimate_weight(NEW.name));
  NEW.weight_grams := v_grams;
  NEW.weight_source := CASE WHEN v_grams IS NULL THEN NULL ELSE 'estimated' END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS products_inventory_weight ON products;
CREATE TRIGGER products_inventory_weight
  BEFORE INSERT OR UPDATE OF name, size ON products
  FOR EACH ROW EXECUTE FUNCTION inventory_fill_product_weight();

-- An option's size first; if it has none, its product's name.
CREATE OR REPLACE FUNCTION inventory_fill_variant_weight()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_grams numeric;
BEGIN
  IF NEW.weight_source IS NOT DISTINCT FROM 'manual' THEN
    RETURN NEW;
  END IF;
  v_grams := COALESCE(
    inventory_estimate_weight(NEW.size),
    inventory_estimate_weight((SELECT p.name FROM products p WHERE p.id = NEW.product_id))
  );
  NEW.weight_grams := v_grams;
  NEW.weight_source := CASE WHEN v_grams IS NULL THEN NULL ELSE 'estimated' END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS product_variants_inventory_weight ON product_variants;
CREATE TRIGGER product_variants_inventory_weight
  BEFORE INSERT OR UPDATE OF size ON product_variants
  FOR EACH ROW EXECUTE FUNCTION inventory_fill_variant_weight();

-- Once, for everything that exists. Only rows with no weight yet; nothing
-- here touches name or size, so the triggers above don't run, and run from
-- the SQL Editor it is not a staff action, so nothing is "last edited".
UPDATE products p
SET weight_grams = e.grams, weight_source = 'estimated'
FROM (
  SELECT id, COALESCE(inventory_estimate_weight(size), inventory_estimate_weight(name)) AS grams
  FROM products
) e
WHERE e.id = p.id AND p.weight_source IS NULL AND p.weight_grams IS NULL AND e.grams IS NOT NULL;

UPDATE product_variants v
SET weight_grams = e.grams, weight_source = 'estimated'
FROM (
  SELECT pv.id, COALESCE(inventory_estimate_weight(pv.size), inventory_estimate_weight(p.name)) AS grams
  FROM product_variants pv JOIN products p ON p.id = pv.product_id
) e
WHERE e.id = v.id AND v.weight_source IS NULL AND v.weight_grams IS NULL AND e.grams IS NOT NULL;

-- ---------------------------------------------------------------------------
-- PART 2 — the "Inventory mode" setting (Off, and stays Off this batch)
-- ---------------------------------------------------------------------------
INSERT INTO app_settings (key, value) VALUES ('inventory_mode', 'false')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION inventory_mode_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Batch 39 replaces this guard once sales take pieces out of lots.
  IF NEW.key = 'inventory_mode' AND NEW.value IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'Inventory mode is available after Batch 39 (sales use lots).';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS app_settings_inventory_mode_guard ON app_settings;
CREATE TRIGGER app_settings_inventory_mode_guard
  BEFORE INSERT OR UPDATE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION inventory_mode_guard();

CREATE OR REPLACE FUNCTION inventory_mode_on()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT value FROM app_settings WHERE key = 'inventory_mode'), 'false') = 'true';
$$;

GRANT EXECUTE ON FUNCTION inventory_mode_on() TO authenticated;

-- ---------------------------------------------------------------------------
-- PART 3 — tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE,
  kind            text NOT NULL CHECK (kind IN ('purchase', 'opening')),
  -- NULL only on the opening lot, whose rows each say import / wholesale.
  source_type     text CHECK (source_type IS NULL OR source_type IN ('import', 'wholesale', 'local')),
  country         text NOT NULL DEFAULT '',
  supplier        text NOT NULL DEFAULT '',
  lot_date        date NOT NULL,
  currency        text NOT NULL DEFAULT 'BDT'
                  CHECK (currency IN ('BDT', 'AUD', 'USD', 'CAD', 'JPY', 'KRW', 'INR', 'GBP')),
  -- Taka for one unit of the currency (1 for BDT).
  exchange_rate   numeric(16,6) NOT NULL DEFAULT 1 CHECK (exchange_rate > 0),
  costs_pending   boolean NOT NULL DEFAULT false,
  notes           text NOT NULL DEFAULT '',
  -- Opening lot only: the % added for weight on imported rows, and the
  -- taka it added in total. When the old 2025–26 expenses are ever brought
  -- in, opening_weight_added_bdt must be SUBTRACTED from those old weight
  -- expenses — it is already inside the opening stock's cost. Never count
  -- both (CLAUDE.md, section 6).
  opening_weight_percent    numeric(7,3),
  opening_weight_added_bdt  numeric(14,2),
  created_by          uuid,
  created_by_username text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Only one opening lot can ever exist.
CREATE UNIQUE INDEX IF NOT EXISTS lots_one_opening ON lots (kind) WHERE kind = 'opening';
CREATE INDEX IF NOT EXISTS idx_lots_date ON lots (lot_date DESC);

CREATE TABLE IF NOT EXISTS lot_costs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id      uuid NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  cost_type   text NOT NULL CHECK (cost_type IN ('weight', 'other')),
  amount_bdt  numeric(14,2) NOT NULL CHECK (amount_bdt >= 0),
  cost_date   date,
  note        text NOT NULL DEFAULT '',
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lot_costs_lot ON lot_costs (lot_id);

CREATE TABLE IF NOT EXISTS lot_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id               uuid NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  -- A product with no options: product_id only. With options: both.
  -- RESTRICT: a product or option that is in a lot can't be deleted (hide
  -- it instead) — its stock history must stay.
  product_id           uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  variant_id           uuid REFERENCES product_variants(id) ON DELETE RESTRICT,
  sort_order           integer NOT NULL DEFAULT 0,
  qty                  integer NOT NULL CHECK (qty > 0),
  unit_price_foreign   numeric(16,4) NOT NULL CHECK (unit_price_foreign >= 0),
  unit_price_bdt       numeric(16,4) NOT NULL DEFAULT 0,
  weight_grams_used    numeric(10,2) CHECK (weight_grams_used IS NULL OR weight_grams_used > 0),
  expiry_date          date,
  -- The row's exact share of the lot's bills, in paisa. Across a lot these
  -- add up to exactly the lot's weight total and other total.
  alloc_weight_paisa   bigint NOT NULL DEFAULT 0,
  alloc_other_paisa    bigint NOT NULL DEFAULT 0,
  -- The same per piece (row share ÷ qty), for showing and for costing.
  alloc_weight_bdt     numeric(16,6) NOT NULL DEFAULT 0,
  alloc_other_bdt      numeric(16,6) NOT NULL DEFAULT 0,
  landed_unit_cost_bdt numeric(16,6) NOT NULL DEFAULT 0,
  -- Always the sum of this row's stock_movements (trigger below).
  qty_remaining        integer NOT NULL DEFAULT 0,
  -- Opening lot rows only.
  opening_source       text CHECK (opening_source IS NULL OR opening_source IN ('import', 'wholesale')),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lot_items_lot ON lot_items (lot_id);
CREATE INDEX IF NOT EXISTS idx_lot_items_product ON lot_items (product_id, variant_id);

CREATE TABLE IF NOT EXISTS stock_movements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_item_id    uuid NOT NULL REFERENCES lot_items(id) ON DELETE CASCADE,
  movement_type  text NOT NULL
                 CHECK (movement_type IN ('opening', 'purchase', 'sale', 'cancel', 'return', 'adjustment')),
  qty            integer NOT NULL CHECK (qty <> 0),
  reference      text,
  reason         text,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_item ON stock_movements (lot_item_id);

-- qty_remaining = sum of the row's movements, always.
CREATE OR REPLACE FUNCTION inventory_sync_qty_remaining()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE lot_items li
  SET qty_remaining = COALESCE((SELECT sum(m.qty) FROM stock_movements m WHERE m.lot_item_id = li.id), 0)
  WHERE li.id IN (
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.lot_item_id END,
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.lot_item_id END
  );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION inventory_sync_qty_remaining() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS stock_movements_qty_remaining ON stock_movements;
CREATE TRIGGER stock_movements_qty_remaining
  AFTER INSERT OR UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION inventory_sync_qty_remaining();

-- ---------------------------------------------------------------------------
-- Who can read (RLS). No INSERT / UPDATE / DELETE policy or grant: every
-- change goes through the functions below.
-- ---------------------------------------------------------------------------
ALTER TABLE lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE lot_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE lot_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON lots, lot_costs, lot_items, stock_movements FROM anon, authenticated;
GRANT SELECT ON lots, lot_costs, lot_items, stock_movements TO authenticated;
GRANT ALL ON lots, lot_costs, lot_items, stock_movements TO service_role;

DROP POLICY IF EXISTS lots_read ON lots;
CREATE POLICY lots_read ON lots
  FOR SELECT TO authenticated USING (staff_can('view_profit_costs'));

DROP POLICY IF EXISTS lot_costs_read ON lot_costs;
CREATE POLICY lot_costs_read ON lot_costs
  FOR SELECT TO authenticated USING (staff_can('view_profit_costs'));

DROP POLICY IF EXISTS lot_items_read ON lot_items;
CREATE POLICY lot_items_read ON lot_items
  FOR SELECT TO authenticated USING (staff_can('view_profit_costs'));

DROP POLICY IF EXISTS stock_movements_read ON stock_movements;
CREATE POLICY stock_movements_read ON stock_movements
  FOR SELECT TO authenticated USING (staff_can('view_profit_costs'));

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- "CeraVe Cream" or "CeraVe Cream — AU · 50 ml".
CREATE OR REPLACE FUNCTION inventory_unit_label(p_product_id uuid, p_variant_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(p.name, 'Unknown product')
         || COALESCE(' — ' || NULLIF(concat_ws(' · ', NULLIF(btrim(v.region), ''), NULLIF(btrim(v.size), '')), ''), '')
  FROM (SELECT 1) one
  LEFT JOIN products p ON p.id = p_product_id
  LEFT JOIN product_variants v ON v.id = p_variant_id;
$$;

REVOKE ALL ON FUNCTION inventory_unit_label(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Last day of the expiry month (month / year is all that is asked for).
CREATE OR REPLACE FUNCTION inventory_month_end(p_date date)
RETURNS date
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN p_date IS NULL THEN NULL
              ELSE (date_trunc('month', p_date) + interval '1 month - 1 day')::date END;
$$;

-- Checks a product / option pair is a real sellable unit.
CREATE OR REPLACE FUNCTION inventory_check_unit(p_product_id uuid, p_variant_id uuid, p_row text)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_product_id IS NULL OR NOT EXISTS (SELECT 1 FROM products WHERE id = p_product_id) THEN
    RAISE EXCEPTION '%: product not found.', p_row;
  END IF;
  IF p_variant_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM product_variants WHERE product_id = p_product_id) THEN
      RAISE EXCEPTION '%: "%" has options — pick the option (size).', p_row, inventory_unit_label(p_product_id, NULL);
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM product_variants WHERE id = p_variant_id AND product_id = p_product_id) THEN
    RAISE EXCEPTION '%: option not found.', p_row;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION inventory_check_unit(uuid, uuid, text) FROM PUBLIC, anon, authenticated;

-- Saves a weight on the product (no options) or the option, as 'manual'.
-- NULL puts the estimate back. The product / option activity triggers log
-- the change (who and when) like any other product edit.
CREATE OR REPLACE FUNCTION inventory_write_weight(p_product_id uuid, p_variant_id uuid, p_grams numeric)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_grams numeric;
BEGIN
  IF p_grams IS NOT NULL AND (p_grams <= 0 OR p_grams > 100000) THEN
    RAISE EXCEPTION 'Weight must be between 1 and 100000 grams.';
  END IF;
  v_grams := round(p_grams, 2);
  IF p_variant_id IS NULL THEN
    IF v_grams IS NULL THEN
      SELECT COALESCE(inventory_estimate_weight(size), inventory_estimate_weight(name)) INTO v_grams
      FROM products WHERE id = p_product_id;
      UPDATE products
      SET weight_grams = v_grams, weight_source = CASE WHEN v_grams IS NULL THEN NULL ELSE 'estimated' END
      WHERE id = p_product_id;
    ELSE
      UPDATE products SET weight_grams = v_grams, weight_source = 'manual'
      WHERE id = p_product_id AND (weight_grams IS DISTINCT FROM v_grams OR weight_source IS DISTINCT FROM 'manual');
    END IF;
  ELSE
    IF v_grams IS NULL THEN
      SELECT COALESCE(inventory_estimate_weight(v.size), inventory_estimate_weight(p.name)) INTO v_grams
      FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = p_variant_id;
      UPDATE product_variants
      SET weight_grams = v_grams, weight_source = CASE WHEN v_grams IS NULL THEN NULL ELSE 'estimated' END
      WHERE id = p_variant_id;
    ELSE
      UPDATE product_variants SET weight_grams = v_grams, weight_source = 'manual'
      WHERE id = p_variant_id AND (weight_grams IS DISTINCT FROM v_grams OR weight_source IS DISTINCT FROM 'manual');
    END IF;
  END IF;
  RETURN v_grams;
END;
$$;

REVOKE ALL ON FUNCTION inventory_write_weight(uuid, uuid, numeric) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- PART 4 — landed cost allocation (exact to the paisa)
-- ---------------------------------------------------------------------------
-- (Re)calculates one purchase lot:
--   unit_price_bdt = unit_price_foreign × exchange_rate (to 4 decimals)
--   weight bills shared by grams:  row basis = qty × weight_grams_used
--   other bills shared by buy value: row basis = qty × unit_price_bdt
--     (every buy price 0 → shared by pieces instead)
--   Largest-remainder method in whole paisa: each row gets the whole-paisa
--   part of its exact share, then the paisa left over go one each to the
--   rows with the biggest remainders (ties: the row higher in the list).
--   So the rows add up to EXACTLY the lot's totals.
--   landed_unit_cost_bdt = unit_price_bdt + row shares ÷ qty.
-- The same rule is in src/lib/inventory/allocation.ts (the preview).
--
-- Called after every change to a lot's items, rate or bills (including a
-- late bill while "costs pending"). Nothing is sold from lots in Batch 38.
-- Batch 39 must handle a late bill for a lot whose pieces were already
-- partly sold: the cost of the pieces already sold must not silently
-- change; the extra cost of sold pieces goes to cost of sales of the
-- period the bill arrived in.
CREATE OR REPLACE FUNCTION inventory_allocate_lot(p_lot_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lot          lots%ROWTYPE;
  v_weight_paisa numeric;
  v_other_paisa  numeric;
  v_missing      text;
BEGIN
  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id FOR UPDATE;
  IF NOT FOUND OR v_lot.kind <> 'purchase' THEN
    RETURN;
  END IF;

  SELECT COALESCE(sum(round(amount_bdt * 100)) FILTER (WHERE cost_type = 'weight'), 0),
         COALESCE(sum(round(amount_bdt * 100)) FILTER (WHERE cost_type = 'other'), 0)
  INTO v_weight_paisa, v_other_paisa
  FROM lot_costs WHERE lot_id = p_lot_id;

  UPDATE lot_items SET unit_price_bdt = round(unit_price_foreign * v_lot.exchange_rate, 4)
  WHERE lot_id = p_lot_id;

  IF v_weight_paisa > 0 THEN
    SELECT string_agg(inventory_unit_label(li.product_id, li.variant_id), ', ' ORDER BY li.sort_order)
    INTO v_missing
    FROM lot_items li
    WHERE li.lot_id = p_lot_id AND li.weight_grams_used IS NULL;
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'Enter weight for: %', v_missing;
    END IF;
  END IF;

  WITH base AS (
    SELECT li.id, li.qty, li.sort_order,
           CASE WHEN v_weight_paisa > 0 THEN li.qty * round(li.weight_grams_used * 100) ELSE 0 END AS wb,
           li.qty * round(li.unit_price_bdt * 10000) AS vb
    FROM lot_items li
    WHERE li.lot_id = p_lot_id
  ), totals AS (
    SELECT sum(wb) AS wt, sum(vb) AS vt, sum(qty) AS qt FROM base
  ), basis AS (
    SELECT b.id, b.qty, b.sort_order, b.wb, t.wt,
           CASE WHEN t.vt > 0 THEN b.vb ELSE b.qty END AS ob,
           CASE WHEN t.vt > 0 THEN t.vt ELSE t.qt END AS ot
    FROM base b CROSS JOIN totals t
  ), shares AS (
    SELECT id, qty, sort_order,
           CASE WHEN wt > 0 THEN div(v_weight_paisa * wb, wt) ELSE 0 END AS w_floor,
           CASE WHEN wt > 0 THEN mod(v_weight_paisa * wb, wt) ELSE 0 END AS w_rem,
           CASE WHEN ot > 0 THEN div(v_other_paisa * ob, ot) ELSE 0 END AS o_floor,
           CASE WHEN ot > 0 THEN mod(v_other_paisa * ob, ot) ELSE 0 END AS o_rem
    FROM basis
  ), ranked AS (
    SELECT s.*,
           row_number() OVER (ORDER BY w_rem DESC, sort_order, id) AS w_rank,
           row_number() OVER (ORDER BY o_rem DESC, sort_order, id) AS o_rank,
           v_weight_paisa - sum(w_floor) OVER () AS w_left,
           v_other_paisa - sum(o_floor) OVER () AS o_left
    FROM shares s
  ), final AS (
    SELECT id, qty,
           (w_floor + CASE WHEN w_rank <= w_left THEN 1 ELSE 0 END)::bigint AS w_paisa,
           (o_floor + CASE WHEN o_rank <= o_left THEN 1 ELSE 0 END)::bigint AS o_paisa
    FROM ranked
  )
  UPDATE lot_items li
  SET alloc_weight_paisa = f.w_paisa,
      alloc_other_paisa = f.o_paisa,
      alloc_weight_bdt = round(f.w_paisa::numeric / f.qty / 100, 6),
      alloc_other_bdt = round(f.o_paisa::numeric / f.qty / 100, 6),
      landed_unit_cost_bdt = round(li.unit_price_bdt + f.w_paisa::numeric / f.qty / 100 + f.o_paisa::numeric / f.qty / 100, 6)
  FROM final f
  WHERE li.id = f.id;
END;
$$;

REVOKE ALL ON FUNCTION inventory_allocate_lot(uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- PART 5 — the functions the Inventory screens call
-- ---------------------------------------------------------------------------

-- Every sellable unit (a product with no options, or each option) with its
-- weight, the shop's current stock and the pieces left in lots. Empty for
-- anyone without "View profit & costs".
CREATE OR REPLACE FUNCTION inventory_stock_units()
RETURNS TABLE (
  product_id      uuid,
  variant_id      uuid,
  sku             text,
  product_name    text,
  option_label    text,
  is_active       boolean,
  weight_grams    numeric,
  weight_source   text,
  site_stock      integer,
  in_stock        boolean,
  selling_price   numeric,
  lot_pieces_left bigint,
  lot_rows        bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT staff_can('view_profit_costs') THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT u.* FROM (
    SELECT p.id, NULL::uuid, p.sku, p.name, NULL::text, p.is_active,
           p.weight_grams, p.weight_source, p.stock_quantity,
           (p.stock_status <> 'out_of_stock'),
           CASE WHEN p.offer_price IS NOT NULL AND p.offer_price < p.retail_price THEN p.offer_price ELSE p.retail_price END,
           COALESCE(l.left_qty, 0)::bigint, COALESCE(l.n, 0)::bigint
    FROM products p
    LEFT JOIN LATERAL (
      SELECT sum(li.qty_remaining) AS left_qty, count(*) AS n
      FROM lot_items li WHERE li.product_id = p.id AND li.variant_id IS NULL
    ) l ON true
    WHERE NOT EXISTS (SELECT 1 FROM product_variants pv WHERE pv.product_id = p.id)
    UNION ALL
    SELECT p.id, v.id, p.sku, p.name,
           NULLIF(concat_ws(' · ', NULLIF(btrim(v.region), ''), NULLIF(btrim(v.size), '')), ''),
           p.is_active, v.weight_grams, v.weight_source, v.stock_quantity, v.in_stock,
           CASE WHEN v.offer_price IS NOT NULL AND v.offer_price < v.retail_price THEN v.offer_price ELSE v.retail_price END,
           COALESCE(l.left_qty, 0)::bigint, COALESCE(l.n, 0)::bigint
    FROM product_variants v
    JOIN products p ON p.id = v.product_id
    LEFT JOIN LATERAL (
      SELECT sum(li.qty_remaining) AS left_qty, count(*) AS n
      FROM lot_items li WHERE li.variant_id = v.id
    ) l ON true
  ) u (product_id, variant_id, sku, product_name, option_label, is_active, weight_grams, weight_source,
       site_stock, in_stock, selling_price, lot_pieces_left, lot_rows)
  ORDER BY u.is_active DESC, lower(u.product_name), u.option_label NULLS FIRST;
END;
$$;

REVOKE ALL ON FUNCTION inventory_stock_units() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory_stock_units() TO authenticated;

-- Weight edit from the "Needs weight" list. Also allowed to anyone who may
-- edit products (a weight is not a cost).
CREATE OR REPLACE FUNCTION inventory_set_weight(p_product_id uuid, p_variant_id uuid, p_grams numeric)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (staff_can('view_profit_costs') OR staff_can('edit_products')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  PERFORM inventory_check_unit(p_product_id, p_variant_id, 'Weight');
  RETURN inventory_write_weight(p_product_id, p_variant_id, p_grams);
END;
$$;

REVOKE ALL ON FUNCTION inventory_set_weight(uuid, uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory_set_weight(uuid, uuid, numeric) TO authenticated;

-- Creates or edits a purchase lot in one go: details, items, bills. Then
-- recalculates the landed cost. Any problem cancels the whole save.
--   p_lot: { id?, source_type, country, supplier, lot_date, currency,
--            exchange_rate, costs_pending, notes,
--            items: [{ id?, product_id, variant_id?, qty, unit_price_foreign,
--                      weight_grams?, expiry_date?, save_weight_to_product? }],
--            costs: [{ id?, cost_type, amount_bdt, cost_date?, note? }] }
CREATE OR REPLACE FUNCTION inventory_save_lot(p_lot jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id        uuid := NULLIF(p_lot ->> 'id', '')::uuid;
  v_is_new    boolean := v_id IS NULL;
  v_lot       lots%ROWTYPE;
  v_source    text := p_lot ->> 'source_type';
  v_currency  text := upper(COALESCE(p_lot ->> 'currency', 'BDT'));
  v_rate      numeric;
  v_date      date := NULLIF(p_lot ->> 'lot_date', '')::date;
  v_items     jsonb := COALESCE(p_lot -> 'items', '[]'::jsonb);
  v_costs     jsonb := COALESCE(p_lot -> 'costs', '[]'::jsonb);
  v_n         integer;
  v_code      text;
  v_item      jsonb;
  v_cost      jsonb;
  v_idx       integer := 0;
  v_row       text;
  v_item_id   uuid;
  v_pid       uuid;
  v_vid       uuid;
  v_qty       numeric;
  v_price     numeric;
  v_grams     numeric;
  v_expiry    date;
  v_old_item  lot_items%ROWTYPE;
  v_old_cost  lot_costs%ROWTYPE;
  v_amount    numeric;
  v_type      text;
  v_changes   jsonb := '[]'::jsonb;
  v_pieces    bigint;
  v_weight    numeric;
  v_other     numeric;
BEGIN
  IF NOT staff_can('view_profit_costs') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  IF v_source IS NULL OR v_source NOT IN ('import', 'wholesale', 'local') THEN
    RAISE EXCEPTION 'Pick where the lot came from (import, wholesale or local).';
  END IF;
  IF v_currency NOT IN ('BDT', 'AUD', 'USD', 'CAD', 'JPY', 'KRW', 'INR', 'GBP') THEN
    RAISE EXCEPTION 'Unknown currency %.', v_currency;
  END IF;
  v_rate := CASE WHEN v_currency = 'BDT' THEN 1 ELSE NULLIF(p_lot ->> 'exchange_rate', '')::numeric END;
  IF v_rate IS NULL OR v_rate <= 0 THEN
    RAISE EXCEPTION 'Enter the exchange rate (taka for 1 %).', v_currency;
  END IF;
  IF v_date IS NULL THEN
    RAISE EXCEPTION 'Enter the lot date.';
  END IF;
  IF jsonb_typeof(v_items) <> 'array' OR jsonb_array_length(v_items) = 0 THEN
    RAISE EXCEPTION 'Add at least one product to the lot.';
  END IF;
  IF jsonb_typeof(v_costs) <> 'array' THEN
    RAISE EXCEPTION 'Costs must be a list.';
  END IF;

  IF v_is_new THEN
    -- L-001, L-002 … : one more than the highest purchase lot. Two saves at
    -- the same moment wait for each other here.
    PERFORM pg_advisory_xact_lock(hashtext('inventory_lot_code'));
    SELECT COALESCE(max(substring(code FROM 3)::integer), 0) + 1 INTO v_n
    FROM lots WHERE kind = 'purchase' AND code ~ '^L-[0-9]+$';
    v_code := 'L-' || CASE WHEN v_n < 1000 THEN lpad(v_n::text, 3, '0') ELSE v_n::text END;
    INSERT INTO lots (code, kind, source_type, country, supplier, lot_date, currency, exchange_rate,
                      costs_pending, notes, created_by, created_by_username)
    VALUES (v_code, 'purchase', v_source, btrim(COALESCE(p_lot ->> 'country', '')),
            btrim(COALESCE(p_lot ->> 'supplier', '')), v_date, v_currency, v_rate,
            COALESCE((p_lot ->> 'costs_pending')::boolean, false), COALESCE(p_lot ->> 'notes', ''),
            auth.uid(), current_actor_username())
    RETURNING id INTO v_id;
  ELSE
    SELECT * INTO v_lot FROM lots WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Lot not found.';
    END IF;
    IF v_lot.kind = 'opening' THEN
      RAISE EXCEPTION 'The opening lot can''t be edited here. Undo the opening stock and upload it again.';
    END IF;
    v_code := v_lot.code;
    IF v_lot.exchange_rate <> v_rate OR v_lot.currency <> v_currency THEN
      v_changes := v_changes || jsonb_build_object('field', 'exchange_rate',
        'from', v_lot.currency || ' ' || v_lot.exchange_rate, 'to', v_currency || ' ' || v_rate);
    END IF;
    UPDATE lots
    SET source_type = v_source,
        country = btrim(COALESCE(p_lot ->> 'country', '')),
        supplier = btrim(COALESCE(p_lot ->> 'supplier', '')),
        lot_date = v_date,
        currency = v_currency,
        exchange_rate = v_rate,
        costs_pending = COALESCE((p_lot ->> 'costs_pending')::boolean, false),
        notes = COALESCE(p_lot ->> 'notes', ''),
        updated_at = now()
    WHERE id = v_id;
  END IF;

  -- Bills: remove the ones no longer listed, update or add the rest.
  FOR v_old_cost IN
    SELECT c.* FROM lot_costs c
    WHERE c.lot_id = v_id
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_costs) x WHERE x ->> 'id' = c.id::text)
  LOOP
    DELETE FROM lot_costs WHERE id = v_old_cost.id;
    v_changes := v_changes || jsonb_build_object('cost', v_old_cost.cost_type, 'removed', v_old_cost.amount_bdt);
  END LOOP;

  FOR v_cost IN SELECT value FROM jsonb_array_elements(v_costs) LOOP
    v_type := v_cost ->> 'cost_type';
    v_amount := round(NULLIF(v_cost ->> 'amount_bdt', '')::numeric, 2);
    IF v_type IS NULL OR v_type NOT IN ('weight', 'other') THEN
      RAISE EXCEPTION 'Each cost must be a weight cost or an other cost.';
    END IF;
    IF v_amount IS NULL OR v_amount < 0 THEN
      RAISE EXCEPTION 'Cost amounts must be 0 or more.';
    END IF;
    SELECT * INTO v_old_cost FROM lot_costs
    WHERE id = NULLIF(v_cost ->> 'id', '')::uuid AND lot_id = v_id;
    IF FOUND THEN
      IF v_old_cost.amount_bdt <> v_amount OR v_old_cost.cost_type <> v_type THEN
        v_changes := v_changes || jsonb_build_object('cost', v_type, 'from', v_old_cost.amount_bdt, 'to', v_amount);
      END IF;
      UPDATE lot_costs
      SET cost_type = v_type, amount_bdt = v_amount,
          cost_date = NULLIF(v_cost ->> 'cost_date', '')::date,
          note = COALESCE(v_cost ->> 'note', '')
      WHERE id = v_old_cost.id;
    ELSE
      INSERT INTO lot_costs (lot_id, cost_type, amount_bdt, cost_date, note, created_by)
      VALUES (v_id, v_type, v_amount, NULLIF(v_cost ->> 'cost_date', '')::date,
              COALESCE(v_cost ->> 'note', ''), auth.uid());
      IF NOT v_is_new THEN
        v_changes := v_changes || jsonb_build_object('cost', v_type, 'added', v_amount);
      END IF;
    END IF;
  END LOOP;

  -- Items no longer listed. Only while nothing was sold from them.
  FOR v_old_item IN
    SELECT li.* FROM lot_items li
    WHERE li.lot_id = v_id
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_items) x WHERE x ->> 'id' = li.id::text)
  LOOP
    IF EXISTS (SELECT 1 FROM stock_movements m
               WHERE m.lot_item_id = v_old_item.id AND m.movement_type NOT IN ('opening', 'purchase')) THEN
      RAISE EXCEPTION 'Can''t remove "%": pieces from it were already sold or adjusted.',
        inventory_unit_label(v_old_item.product_id, v_old_item.variant_id);
    END IF;
    DELETE FROM lot_items WHERE id = v_old_item.id;
    v_changes := v_changes || jsonb_build_object('item_removed',
      inventory_unit_label(v_old_item.product_id, v_old_item.variant_id), 'qty', v_old_item.qty);
  END LOOP;

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_items) LOOP
    v_idx := v_idx + 1;
    v_row := format('Row %s', v_idx);
    v_pid := NULLIF(v_item ->> 'product_id', '')::uuid;
    v_vid := NULLIF(v_item ->> 'variant_id', '')::uuid;
    PERFORM inventory_check_unit(v_pid, v_vid, v_row);
    v_qty := NULLIF(v_item ->> 'qty', '')::numeric;
    IF v_qty IS NULL OR v_qty <= 0 OR v_qty <> trunc(v_qty) OR v_qty > 1000000 THEN
      RAISE EXCEPTION '%: pieces must be a whole number above 0.', v_row;
    END IF;
    v_price := NULLIF(v_item ->> 'unit_price_foreign', '')::numeric;
    IF v_price IS NULL OR v_price < 0 THEN
      RAISE EXCEPTION '%: enter the buy price per piece.', v_row;
    END IF;
    v_grams := NULLIF(v_item ->> 'weight_grams', '')::numeric;
    IF v_grams IS NOT NULL AND (v_grams <= 0 OR v_grams > 100000) THEN
      RAISE EXCEPTION '%: weight must be between 1 and 100000 grams.', v_row;
    END IF;
    v_expiry := inventory_month_end(NULLIF(v_item ->> 'expiry_date', '')::date);

    SELECT * INTO v_old_item FROM lot_items
    WHERE id = NULLIF(v_item ->> 'id', '')::uuid AND lot_id = v_id;
    IF FOUND THEN
      IF (v_old_item.product_id <> v_pid OR v_old_item.variant_id IS DISTINCT FROM v_vid)
         AND EXISTS (SELECT 1 FROM stock_movements m
                     WHERE m.lot_item_id = v_old_item.id AND m.movement_type NOT IN ('opening', 'purchase')) THEN
        RAISE EXCEPTION '%: can''t change the product — pieces were already sold or adjusted.', v_row;
      END IF;
      UPDATE lot_items
      SET product_id = v_pid, variant_id = v_vid, sort_order = v_idx, qty = v_qty::integer,
          unit_price_foreign = round(v_price, 4), weight_grams_used = round(v_grams, 2), expiry_date = v_expiry
      WHERE id = v_old_item.id;
      IF v_old_item.qty <> v_qty THEN
        -- The ledger is never rewritten: the difference is one more row.
        INSERT INTO stock_movements (lot_item_id, movement_type, qty, reference, reason, created_by)
        VALUES (v_old_item.id, 'purchase', v_qty::integer - v_old_item.qty, v_code,
                format('Lot edited: pieces %s → %s', v_old_item.qty, v_qty::integer), auth.uid());
        v_changes := v_changes || jsonb_build_object('item', inventory_unit_label(v_pid, v_vid),
          'qty_from', v_old_item.qty, 'qty_to', v_qty::integer);
      END IF;
      IF v_old_item.unit_price_foreign <> round(v_price, 4) THEN
        v_changes := v_changes || jsonb_build_object('item', inventory_unit_label(v_pid, v_vid),
          'price_from', v_old_item.unit_price_foreign, 'price_to', round(v_price, 4));
      END IF;
    ELSE
      INSERT INTO lot_items (lot_id, product_id, variant_id, sort_order, qty, unit_price_foreign,
                             weight_grams_used, expiry_date)
      VALUES (v_id, v_pid, v_vid, v_idx, v_qty::integer, round(v_price, 4), round(v_grams, 2), v_expiry)
      RETURNING id INTO v_item_id;
      INSERT INTO stock_movements (lot_item_id, movement_type, qty, reference, reason, created_by)
      VALUES (v_item_id, 'purchase', v_qty::integer, v_code, NULL, auth.uid());
      IF NOT v_is_new THEN
        v_changes := v_changes || jsonb_build_object('item_added', inventory_unit_label(v_pid, v_vid), 'qty', v_qty::integer);
      END IF;
    END IF;

    IF COALESCE((v_item ->> 'save_weight_to_product')::boolean, false) AND v_grams IS NOT NULL THEN
      PERFORM inventory_write_weight(v_pid, v_vid, v_grams);
    END IF;
  END LOOP;

  PERFORM inventory_allocate_lot(v_id);

  SELECT COALESCE(sum(qty), 0) INTO v_pieces FROM lot_items WHERE lot_id = v_id;
  SELECT COALESCE(sum(amount_bdt) FILTER (WHERE cost_type = 'weight'), 0),
         COALESCE(sum(amount_bdt) FILTER (WHERE cost_type = 'other'), 0)
  INTO v_weight, v_other FROM lot_costs WHERE lot_id = v_id;

  IF v_is_new THEN
    PERFORM write_activity('inventory.lot_created', 'lot', v_id::text, v_code,
      format('Created lot %s: %s products, %s pieces, weight cost ৳%s, other costs ৳%s',
             v_code, jsonb_array_length(v_items), v_pieces, v_weight, v_other),
      jsonb_build_object('pieces', v_pieces, 'weight_cost', v_weight, 'other_cost', v_other,
                         'currency', v_currency, 'exchange_rate', v_rate));
  ELSIF jsonb_array_length(v_changes) > 0 OR v_lot.costs_pending IS DISTINCT FROM COALESCE((p_lot ->> 'costs_pending')::boolean, false) THEN
    PERFORM write_activity(
      CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(v_changes) c WHERE c ? 'cost' OR c ->> 'field' = 'exchange_rate')
           THEN 'inventory.lot_cost_changed' ELSE 'inventory.lot_edited' END,
      'lot', v_id::text, v_code,
      format('Edited lot %s: weight cost ৳%s, other costs ৳%s, %s pieces', v_code, v_weight, v_other, v_pieces),
      jsonb_build_object('changes', v_changes, 'weight_cost', v_weight, 'other_cost', v_other));
  ELSE
    PERFORM write_activity('inventory.lot_edited', 'lot', v_id::text, v_code,
      format('Edited lot %s details', v_code), '{}'::jsonb);
  END IF;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION inventory_save_lot(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory_save_lot(jsonb) TO authenticated;

-- Deletes a purchase lot. Behind the Safety Lock (Super Admin, password
-- re-typed, 15 minutes), only while Inventory mode is Off and nothing was
-- sold from it.
CREATE OR REPLACE FUNCTION inventory_delete_lot(p_lot_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lot    lots%ROWTYPE;
  v_pieces bigint;
BEGIN
  IF NOT staff_can('view_profit_costs') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF admin_delete_lock_until() IS NULL THEN
    RAISE EXCEPTION 'Locked: turn off the Safety Lock first (Settings → Safety Locks).';
  END IF;
  IF inventory_mode_on() THEN
    RAISE EXCEPTION 'Inventory mode is On: lots can''t be deleted.';
  END IF;
  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lot not found.';
  END IF;
  IF v_lot.kind = 'opening' THEN
    RAISE EXCEPTION 'Use "Undo opening stock" for the opening lot.';
  END IF;
  IF EXISTS (SELECT 1 FROM stock_movements m JOIN lot_items li ON li.id = m.lot_item_id
             WHERE li.lot_id = p_lot_id AND m.movement_type NOT IN ('opening', 'purchase')) THEN
    RAISE EXCEPTION 'Pieces from this lot were already sold or adjusted; it can''t be deleted.';
  END IF;
  SELECT COALESCE(sum(qty), 0) INTO v_pieces FROM lot_items WHERE lot_id = p_lot_id;
  DELETE FROM lots WHERE id = p_lot_id;
  PERFORM write_activity('inventory.lot_deleted', 'lot', p_lot_id::text, v_lot.code,
    format('Deleted lot %s (%s pieces)', v_lot.code, v_pieces),
    jsonb_build_object('pieces', v_pieces, 'supplier', v_lot.supplier, 'lot_date', v_lot.lot_date));
END;
$$;

REVOKE ALL ON FUNCTION inventory_delete_lot(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory_delete_lot(uuid) TO authenticated;

-- Writes "uploaded a file" to the Activity Log (the file itself is only
-- read in the browser; nothing is saved until Confirm).
CREATE OR REPLACE FUNCTION inventory_log_opening_upload(p_file_name text, p_rows integer, p_ready integer, p_to_fix integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT staff_can('view_profit_costs') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  PERFORM write_activity('inventory.opening_uploaded', 'lot', 'opening', 'Opening stock',
    format('Uploaded opening stock file "%s": %s rows, %s ready, %s to fix',
           left(COALESCE(p_file_name, ''), 120), p_rows, p_ready, p_to_fix),
    jsonb_build_object('file', left(COALESCE(p_file_name, ''), 120), 'rows', p_rows, 'ready', p_ready, 'to_fix', p_to_fix));
END;
$$;

REVOKE ALL ON FUNCTION inventory_log_opening_upload(text, integer, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory_log_opening_upload(text, integer, integer, integer) TO authenticated;

-- Confirms the opening stock: creates L-000 and one 'opening' movement per
-- row. Checks every row again (the browser's preview is only a preview).
--   p_rows: [{ product_id, variant_id?, source ('import'|'wholesale'),
--              buy_price_bdt, pieces, expiry? (any day of the month),
--              weight_g? }]
--   Landed cost per piece: import → buy × (1 + p_weight_percent / 100)
--                          wholesale → buy (+0%).
--   Rows with the same product + expiry + source are merged (pieces
--   added, buy price = average weighted by pieces).
-- opening_weight_added_bdt = the taka the % added on imported rows.
-- NOTE: that amount is weight cost moved from the old (2025–26) expenses
-- into the opening stock. If those old expenses are ever imported, it must
-- be subtracted from them — never count it twice (CLAUDE.md, section 6).
CREATE OR REPLACE FUNCTION inventory_confirm_opening(
  p_lot_date       date,
  p_weight_percent numeric,
  p_rows           jsonb,
  p_file_name      text DEFAULT ''
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id       uuid;
  v_row      jsonb;
  v_idx      integer;
  v_label    text;
  v_pid      uuid;
  v_vid      uuid;
  v_src      text;
  v_price    numeric;
  v_pieces   numeric;
  v_grams    numeric;
  v_merged   record;
  v_item_id  uuid;
  v_sort     integer := 0;
  v_alloc    bigint;
  v_added    bigint := 0;
  v_total    numeric := 0;
  v_count    bigint := 0;
  v_current  numeric;
BEGIN
  IF NOT staff_can('view_profit_costs') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_lot_date IS NULL THEN
    RAISE EXCEPTION 'Pick the start date for the opening stock.';
  END IF;
  IF p_weight_percent IS NULL OR p_weight_percent < 0 OR p_weight_percent > 500 THEN
    RAISE EXCEPTION 'Enter the average weight %% (0 to 500).';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'The file has no rows to save.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('inventory_opening'));
  IF EXISTS (SELECT 1 FROM lots WHERE kind = 'opening') THEN
    RAISE EXCEPTION 'Opening stock was already saved (L-000). Undo it first to upload again.';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS inventory_opening_rows (
    ord integer, product_id uuid, variant_id uuid, source text, price numeric, pieces integer, expiry date, grams numeric
  ) ON COMMIT DROP;
  TRUNCATE inventory_opening_rows;

  FOR v_row, v_idx IN SELECT value, ordinality FROM jsonb_array_elements(p_rows) WITH ORDINALITY LOOP
    v_label := format('Row %s', v_idx);
    v_pid := NULLIF(v_row ->> 'product_id', '')::uuid;
    v_vid := NULLIF(v_row ->> 'variant_id', '')::uuid;
    PERFORM inventory_check_unit(v_pid, v_vid, v_label);
    v_src := lower(btrim(COALESCE(v_row ->> 'source', '')));
    IF v_src NOT IN ('import', 'wholesale') THEN
      RAISE EXCEPTION '%: source must be import or wholesale.', v_label;
    END IF;
    v_price := NULLIF(v_row ->> 'buy_price_bdt', '')::numeric;
    IF v_price IS NULL OR v_price <= 0 THEN
      RAISE EXCEPTION '%: buy price must be above 0.', v_label;
    END IF;
    v_pieces := NULLIF(v_row ->> 'pieces', '')::numeric;
    IF v_pieces IS NULL OR v_pieces <= 0 OR v_pieces <> trunc(v_pieces) OR v_pieces > 1000000 THEN
      RAISE EXCEPTION '%: pieces must be a whole number above 0.', v_label;
    END IF;
    v_grams := NULLIF(v_row ->> 'weight_g', '')::numeric;
    IF v_grams IS NOT NULL AND (v_grams <= 0 OR v_grams > 100000) THEN
      RAISE EXCEPTION '%: weight must be between 1 and 100000 grams.', v_label;
    END IF;
    INSERT INTO inventory_opening_rows
    VALUES (v_idx, v_pid, v_vid, v_src, round(v_price, 4), v_pieces::integer,
            inventory_month_end(NULLIF(v_row ->> 'expiry', '')::date), round(v_grams, 2));
  END LOOP;

  INSERT INTO lots (code, kind, source_type, lot_date, currency, exchange_rate, notes,
                    opening_weight_percent, created_by, created_by_username)
  VALUES ('L-000', 'opening', NULL, p_lot_date, 'BDT', 1,
          'Opening stock' || CASE WHEN COALESCE(p_file_name, '') <> '' THEN ' from ' || left(p_file_name, 120) ELSE '' END,
          p_weight_percent, auth.uid(), current_actor_username())
  RETURNING id INTO v_id;

  FOR v_merged IN
    SELECT r.product_id, r.variant_id, r.source, r.expiry,
           sum(r.pieces)::integer AS pieces,
           round(sum(r.pieces * r.price) / sum(r.pieces), 4) AS price,
           max(r.grams) AS grams
    FROM inventory_opening_rows r
    GROUP BY r.product_id, r.variant_id, r.source, r.expiry
    ORDER BY min(r.ord)
  LOOP
    v_sort := v_sort + 1;
    -- The % on an imported row, in whole paisa for the whole row.
    v_alloc := CASE WHEN v_merged.source = 'import'
                    THEN round(v_merged.pieces * v_merged.price * p_weight_percent)::bigint   -- × 100 paisa ÷ 100 %
                    ELSE 0 END;
    v_added := v_added + v_alloc;

    IF v_merged.variant_id IS NULL THEN
      SELECT weight_grams INTO v_current FROM products WHERE id = v_merged.product_id;
    ELSE
      SELECT weight_grams INTO v_current FROM product_variants WHERE id = v_merged.variant_id;
    END IF;
    IF v_merged.grams IS NOT NULL AND v_merged.grams IS DISTINCT FROM v_current THEN
      PERFORM inventory_write_weight(v_merged.product_id, v_merged.variant_id, v_merged.grams);
    END IF;

    INSERT INTO lot_items (lot_id, product_id, variant_id, sort_order, qty, unit_price_foreign, unit_price_bdt,
                           weight_grams_used, expiry_date, alloc_weight_paisa, alloc_other_paisa,
                           alloc_weight_bdt, alloc_other_bdt, landed_unit_cost_bdt, opening_source)
    VALUES (v_id, v_merged.product_id, v_merged.variant_id, v_sort, v_merged.pieces, v_merged.price, v_merged.price,
            COALESCE(v_merged.grams, v_current), v_merged.expiry, v_alloc, 0,
            round(v_alloc::numeric / v_merged.pieces / 100, 6), 0,
            round(v_merged.price + v_alloc::numeric / v_merged.pieces / 100, 6), v_merged.source)
    RETURNING id INTO v_item_id;

    INSERT INTO stock_movements (lot_item_id, movement_type, qty, reference, reason, created_by)
    VALUES (v_item_id, 'opening', v_merged.pieces, 'L-000', 'Opening stock', auth.uid());

    v_count := v_count + v_merged.pieces;
    v_total := v_total + v_merged.pieces * v_merged.price;
  END LOOP;

  UPDATE lots SET opening_weight_added_bdt = v_added::numeric / 100 WHERE id = v_id;

  PERFORM write_activity('inventory.opening_confirmed', 'lot', v_id::text, 'L-000',
    format('Saved opening stock L-000: %s rows, %s pieces, value ৳%s (weight added ৳%s at %s%%)',
           v_sort, v_count, round(v_total + v_added::numeric / 100, 2), v_added::numeric / 100, p_weight_percent),
    jsonb_build_object('rows', v_sort, 'pieces', v_count, 'buy_value', round(v_total, 2),
                       'weight_added', v_added::numeric / 100, 'weight_percent', p_weight_percent,
                       'lot_date', p_lot_date, 'file', left(COALESCE(p_file_name, ''), 120)));
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION inventory_confirm_opening(date, numeric, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory_confirm_opening(date, numeric, jsonb, text) TO authenticated;

-- Removes the opening lot and its movements. Only while Inventory mode is
-- Off, behind the Safety Lock. Product weights saved from the file stay.
CREATE OR REPLACE FUNCTION inventory_undo_opening()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lot    lots%ROWTYPE;
  v_pieces bigint;
BEGIN
  IF NOT staff_can('view_profit_costs') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF inventory_mode_on() THEN
    RAISE EXCEPTION 'Inventory mode is On: the opening stock can''t be undone.';
  END IF;
  IF admin_delete_lock_until() IS NULL THEN
    RAISE EXCEPTION 'Locked: turn off the Safety Lock first (Settings → Safety Locks).';
  END IF;
  SELECT * INTO v_lot FROM lots WHERE kind = 'opening' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'There is no opening stock to undo.';
  END IF;
  IF EXISTS (SELECT 1 FROM stock_movements m JOIN lot_items li ON li.id = m.lot_item_id
             WHERE li.lot_id = v_lot.id AND m.movement_type <> 'opening') THEN
    RAISE EXCEPTION 'Pieces from the opening stock were already sold or adjusted; it can''t be undone.';
  END IF;
  SELECT COALESCE(sum(qty), 0) INTO v_pieces FROM lot_items WHERE lot_id = v_lot.id;
  DELETE FROM lots WHERE id = v_lot.id;
  PERFORM write_activity('inventory.opening_undone', 'lot', v_lot.id::text, 'L-000',
    format('Undid opening stock L-000 (%s pieces)', v_pieces),
    jsonb_build_object('pieces', v_pieces, 'weight_added', v_lot.opening_weight_added_bdt));
END;
$$;

REVOKE ALL ON FUNCTION inventory_undo_opening() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory_undo_opening() TO authenticated;

-- The staff switch's description changes in the app only; the permission
-- name 'view_profit_costs' is the one Batch 36 added.

COMMIT;
