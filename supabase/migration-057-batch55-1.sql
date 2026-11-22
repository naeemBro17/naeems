-- ============================================================
-- Migration 057 — Batch 55.1: a guard on "Pack size"
-- ============================================================
-- Stock and cost in lots are counted per UNIT (Batch 39). Changing a
-- product's pack size with inventory_set_pack() only changes the two
-- words in the product editor; it does not restate the stock, the costs or
-- the units already taken by orders. On a product that already has any of
-- them, a new pack size would turn 2 bottles into 2 ml and a ৳2,800
-- bottle into ৳2,800 per ml.
--
-- 1. inventory_pack_locked(product, option): true when the product /
--    option already has numbers counted per unit — lot rows, units taken
--    by orders, "sold without stock" rows, units taken before Inventory
--    mode (order_items.pre_inventory_units), or a buying price.
-- 2. inventory_set_pack() refuses to CHANGE the pack size of such a
--    product / option. Changing only the stock unit word (pack size stays
--    the same, e.g. pcs 1 → ml 1) is still allowed. A product with none of
--    these: unchanged behaviour.
-- 3. product_buying_prices.unit_cost_bdt keeps 6 decimals (was 4), like
--    every other cost per unit (lot_items.landed_unit_cost_bdt,
--    order_item_lots.unit_cost_bdt): a cost per ml of a 473 ml bottle needs
--    them so 473 × (cost ÷ 473) gives back the bottle's cost to the paisa.
--    Existing values are unchanged (4 decimals fit in 6).
--
-- Additive; nothing is dropped. Safe to run more than once.
-- ============================================================

BEGIN;

-- 3. Buying price per unit: 6 decimals.
DO $$
BEGIN
  IF (SELECT numeric_scale FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'product_buying_prices' AND column_name = 'unit_cost_bdt') < 6 THEN
    ALTER TABLE product_buying_prices ALTER COLUMN unit_cost_bdt TYPE numeric(16, 6);
  END IF;
END $$;

-- 1. Does this product / option already have numbers counted per unit?
CREATE OR REPLACE FUNCTION inventory_pack_locked(p_product_id uuid, p_variant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM lot_items li
                 WHERE li.product_id = p_product_id AND li.variant_id IS NOT DISTINCT FROM p_variant_id)
      OR EXISTS (SELECT 1 FROM order_item_lots o JOIN lot_items li ON li.id = o.lot_item_id
                 WHERE li.product_id = p_product_id AND li.variant_id IS NOT DISTINCT FROM p_variant_id)
      OR EXISTS (SELECT 1 FROM stock_shortfalls s
                 WHERE s.product_id = p_product_id AND s.variant_id IS NOT DISTINCT FROM p_variant_id)
      OR EXISTS (SELECT 1 FROM order_items oi
                 WHERE oi.product_id = p_product_id AND oi.variant_id IS NOT DISTINCT FROM p_variant_id
                   AND oi.pre_inventory_units > 0)
      OR EXISTS (SELECT 1 FROM product_buying_prices b
                 WHERE b.product_id = p_product_id AND b.variant_id IS NOT DISTINCT FROM p_variant_id);
$$;

REVOKE ALL ON FUNCTION inventory_pack_locked(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- 2. The product editor's "Save pack size" (same as Batch 39, plus the
-- guard).
CREATE OR REPLACE FUNCTION inventory_set_pack(p_product_id uuid, p_variant_id uuid, p_unit text, p_pack_size integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_unit text := lower(btrim(COALESCE(p_unit, '')));
  v_now  integer;
BEGIN
  IF NOT (staff_can('edit_products') OR staff_can('view_profit_costs')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF v_unit NOT IN ('pcs', 'ml', 'g') THEN
    RAISE EXCEPTION 'Stock unit must be pcs, ml or g.';
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
$$;

REVOKE ALL ON FUNCTION inventory_set_pack(uuid, uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION inventory_set_pack(uuid, uuid, text, integer) TO authenticated;

COMMIT;
