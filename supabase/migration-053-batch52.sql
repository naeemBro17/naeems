-- =====================================================================
-- Batch 52 — "Share as a combo"
--
-- Paste the whole file into the Supabase SQL Editor and press Run.
-- It is safe to run more than once.
--
-- A  combos: one shareable list of products Naeem picked for a customer
--    (name, optional note, the link code, the preview picture).
-- B  combo_items: the products in it (product, option, quantity).
-- C  Only the admin (is_admin()) can create, list, change or delete them.
-- D  get_combo(code): anyone with the link (also logged-out visitors) reads
--    ONE combo by its code — only what the customer page needs. Nobody
--    else can list combos.
--
-- Combos never touch stock, orders, money or promo codes. There is no
-- combo price: the shop's normal prices apply.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------- A, B
CREATE TABLE IF NOT EXISTS public.combos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The link: /c/{code}. 8 letters / digits, never easy to guess.
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z2-9]{8}$'),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  note text CHECK (note IS NULL OR char_length(note) <= 300),
  -- The wide picture link previews show (drawn once when it is made).
  preview_url text,
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.combo_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  combo_id uuid NOT NULL REFERENCES public.combos (id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products (id) ON DELETE CASCADE,
  -- The chosen option; null = the product itself (or its own base option).
  variant_id uuid,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  sort_order integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS combo_items_combo_idx ON public.combo_items (combo_id, sort_order);
CREATE INDEX IF NOT EXISTS combos_created_idx ON public.combos (created_at DESC);

-- ------------------------------------------------------------------- C
ALTER TABLE public.combos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.combo_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS combos_admin_all ON public.combos;
CREATE POLICY combos_admin_all ON public.combos
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS combo_items_admin_all ON public.combo_items;
CREATE POLICY combo_items_admin_all ON public.combo_items
  FOR ALL TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

REVOKE ALL ON public.combos FROM anon;
REVOKE ALL ON public.combo_items FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.combos TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.combo_items TO authenticated;

-- Makes a combo and its lines in one step. Returns the new combo's id.
CREATE OR REPLACE FUNCTION public.admin_create_combo(
  p_code text,
  p_name text,
  p_note text,
  p_items jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_item jsonb;
  v_index integer := 0;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only the admin can make a combo.' USING ERRCODE = '42501';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'A combo needs at least one product.';
  END IF;
  IF jsonb_array_length(p_items) > 50 THEN
    RAISE EXCEPTION 'A combo can have up to 50 products.';
  END IF;

  INSERT INTO public.combos (code, name, note)
  VALUES (p_code, btrim(p_name), NULLIF(btrim(coalesce(p_note, '')), ''))
  RETURNING id INTO v_id;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    INSERT INTO public.combo_items (combo_id, product_id, variant_id, quantity, sort_order)
    VALUES (
      v_id,
      (v_item ->> 'product_id')::uuid,
      NULLIF(v_item ->> 'variant_id', '')::uuid,
      (v_item ->> 'quantity')::integer,
      v_index
    );
    v_index := v_index + 1;
  END LOOP;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_create_combo(text, text, text, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_combo(text, text, text, jsonb) TO authenticated;

-- ------------------------------------------------------------------- D
-- One combo by its code: name, note, picture and lines. Null when the
-- code is unknown or the combo was deleted. Prices and stock are NOT
-- here: the customer page reads today's from the shop, like every page.
CREATE OR REPLACE FUNCTION public.get_combo(p_code text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'code', c.code,
    'name', c.name,
    'note', c.note,
    'preview_url', c.preview_url,
    'items', coalesce((
      SELECT jsonb_agg(
        jsonb_build_object('product_id', i.product_id, 'variant_id', i.variant_id, 'quantity', i.quantity)
        ORDER BY i.sort_order
      )
      FROM public.combo_items i
      WHERE i.combo_id = c.id
    ), '[]'::jsonb)
  )
  FROM public.combos c
  WHERE p_code ~ '^[a-z2-9]{8}$' AND c.code = p_code;
$$;

REVOKE ALL ON FUNCTION public.get_combo(text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_combo(text) TO anon, authenticated;

COMMIT;
