-- ============================================================
-- Batch 37 — new invoice and bulk print (reports/batch-37.txt).
--
--   app_settings rows       the invoice settings (Admin → Settings →
--                           Invoice). Blank = the default the website
--                           uses: shop phone = the Checkout WhatsApp
--                           number, "Dhaka, Bangladesh", the Facebook
--                           group link and texts, community box On.
--   order_invoice_prints    one row each time an order's invoice is
--                           printed (re-printing is allowed).
--   record_invoice_prints() remembers a print and adds "Invoice printed"
--                           to each order's History.
--
-- Who: anyone allowed to see orders (staff_can('view_orders'); the Super
-- Admin always) can print and read the print marks. Nobody can write
-- order_invoice_prints directly — only through record_invoice_prints().
--
-- Additive only: new rows (existing settings are never overwritten), one
-- new table, one new function. Nothing is changed or dropped. Safe to run
-- more than once.
-- ============================================================

BEGIN;

INSERT INTO app_settings (key, value) VALUES
  ('invoice_shop_phone', ''),
  ('invoice_shop_city', ''),
  ('invoice_community_link', ''),
  ('invoice_community_title', ''),
  ('invoice_community_line1', ''),
  ('invoice_community_line2', ''),
  ('invoice_show_community', 'true')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS order_invoice_prints (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  printed_at  timestamptz NOT NULL DEFAULT now(),
  printed_by  uuid DEFAULT auth.uid()
);

CREATE INDEX IF NOT EXISTS order_invoice_prints_order_idx ON order_invoice_prints (order_id, printed_at DESC);

ALTER TABLE order_invoice_prints ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "order_invoice_prints_staff_read" ON order_invoice_prints;
CREATE POLICY "order_invoice_prints_staff_read"
  ON order_invoice_prints FOR SELECT TO authenticated
  USING (staff_can('view_orders'));

REVOKE ALL ON order_invoice_prints FROM anon;
REVOKE INSERT, UPDATE, DELETE ON order_invoice_prints FROM authenticated;
GRANT SELECT ON order_invoice_prints TO authenticated;

CREATE OR REPLACE FUNCTION record_invoice_prints(p_order_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order record;
  v_count integer := 0;
BEGIN
  IF NOT staff_can('view_orders') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_order_ids IS NULL OR array_length(p_order_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;
  IF array_length(p_order_ids, 1) > 500 THEN
    RAISE EXCEPTION 'Too many orders at once.';
  END IF;

  FOR v_order IN SELECT id, status FROM orders WHERE id = ANY (p_order_ids) LOOP
    INSERT INTO order_invoice_prints (order_id, printed_by) VALUES (v_order.id, auth.uid());
    PERFORM order_history_line(v_order.id, v_order.status, 'Invoice printed');
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION record_invoice_prints(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION record_invoice_prints(uuid[]) TO authenticated;

COMMIT;

-- Checks (read only):
-- 1. SELECT key, value FROM app_settings WHERE key LIKE 'invoice_%' ORDER BY key;  → 7 rows
-- 2. SELECT count(*) FROM order_invoice_prints;                                      → 0 at first
-- 3. SELECT proname FROM pg_proc WHERE proname = 'record_invoice_prints';            → 1 row
