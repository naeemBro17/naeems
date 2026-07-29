-- ============================================================
-- Naeem's Price Hub — Row Level Security (V1)
-- Run this after schema.sql in the Supabase SQL Editor.
--
-- Model:
--   anon (viewers, no login)     → read-only, active products only
--   authenticated (the admin)    → full read/write on everything
-- ============================================================

-- ---------- categories ----------
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;

-- Anyone (logged in or not) can read categories — needed for the
-- category chips on the public viewer.
CREATE POLICY "categories_public_read"
  ON categories FOR SELECT TO anon, authenticated
  USING (true);

-- Only the authenticated admin can insert/update/delete categories.
CREATE POLICY "categories_admin_write"
  ON categories FOR ALL TO authenticated
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');

-- ---------- products ----------
ALTER TABLE products ENABLE ROW LEVEL SECURITY;

-- Anonymous viewers can only see active products. Inactive products
-- are invisible to the public app by design.
CREATE POLICY "products_public_read"
  ON products FOR SELECT TO anon
  USING (is_active = true);

-- The authenticated admin can read (including inactive) and write everything.
CREATE POLICY "products_admin_all"
  ON products FOR ALL TO authenticated
  USING (auth.role() = 'authenticated')
  WITH CHECK (auth.role() = 'authenticated');
