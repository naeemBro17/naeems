-- ============================================================
-- Naeem's Price Hub — Migration 004: Wholesaler auth + real
-- wholesale-price security (Group 2)
--
-- Run this ONCE in the Supabase SQL Editor. Then:
--   2. Run the Part 6 bootstrap INSERT (bottom of this file) with your
--      real admin login email.
--   3. In Auth settings, turn OFF "Confirm email" if it is on.
--
-- Roles from here on:
--   customer   (anon)          → retail + offer prices only, never wholesale
--   wholesaler (signup+approve)→ also wholesale once approved
--   admin      (Naeem)         → everything + approves wholesalers
-- ============================================================

-- ---------- PART 1: profiles table ----------
CREATE TABLE IF NOT EXISTS profiles (
  id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role          text NOT NULL DEFAULT 'wholesaler'
                  CHECK (role IN ('wholesaler', 'admin')),
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected', 'revoked')),
  business_name text,
  phone         text,
  created_at    timestamptz DEFAULT now(),
  approved_at   timestamptz
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- ---------- PART 2: role-check functions ----------
-- SECURITY DEFINER so these bypass profiles' own RLS when called from
-- inside a policy on profiles (avoids infinite recursion / lock-out).
CREATE OR REPLACE FUNCTION is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
    AND status = 'approved'
    AND role = 'admin'
  );
$$;

CREATE OR REPLACE FUNCTION is_wholesaler_or_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
    AND status = 'approved'
    AND role IN ('wholesaler', 'admin')
  );
$$;

GRANT EXECUTE ON FUNCTION is_admin() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION is_wholesaler_or_admin() TO anon, authenticated;

-- ---------- PART 1 (cont): profiles policies ----------
-- (created after the functions so the admin policies can reference is_admin())
DROP POLICY IF EXISTS "profiles_read_own"      ON profiles;
DROP POLICY IF EXISTS "profiles_admin_read_all" ON profiles;
DROP POLICY IF EXISTS "profiles_self_insert"   ON profiles;
DROP POLICY IF EXISTS "profiles_admin_update"  ON profiles;

-- A user can read their own profile (to check their own status).
CREATE POLICY "profiles_read_own"
  ON profiles FOR SELECT TO authenticated
  USING (id = auth.uid());

-- Admins can read every profile (to see the approval queue).
CREATE POLICY "profiles_admin_read_all"
  ON profiles FOR SELECT TO authenticated
  USING (is_admin());

-- A new user may insert ONLY their own row, and ONLY as a pending
-- wholesaler — never self-assign admin or pre-approve. Runs right after signUp().
CREATE POLICY "profiles_self_insert"
  ON profiles FOR INSERT TO authenticated
  WITH CHECK (id = auth.uid() AND role = 'wholesaler' AND status = 'pending');

-- Only admins can change a profile afterwards (approve/reject/revoke/edit).
CREATE POLICY "profiles_admin_update"
  ON profiles FOR UPDATE TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

-- ---------- PART 3: column-level lock on wholesale_price ----------
-- Makes the security REAL: neither anon nor authenticated can read the
-- wholesale_price column off the base table directly (not even admin, not
-- even via a raw REST call). The ONLY sanctioned read path is products_view.
-- Writing (INSERT/UPDATE) the column is unaffected and still works for admins.
REVOKE SELECT (wholesale_price) ON products FROM anon, authenticated;

-- ---------- PART 4: products_view (sole sanctioned read path) ----------
-- A plain (owner-privilege) view: it runs as its owner, so it can compute
-- wholesale_price conditionally even though Part 3 blocks the base column for
-- the querying roles. auth.uid() still reflects the real caller inside the view.
--
-- Extends the spec's column list with two app-required, non-sensitive fields:
--   • image_urls   — the multi-image array added in migration-002 (needed by
--                    the gallery); omitting it would break multi-photo display.
--   • has_wholesale— a boolean (value hidden, existence not) so the client can
--                    tell "this product has a wholesale price but you're not
--                    approved" (Awaiting approval / Login to view) apart from
--                    "this product simply has no wholesale price" (no row).
CREATE OR REPLACE VIEW products_view AS
SELECT
  id, sku, name, category_id, retail_price, offer_price,
  stock_status, stock_quantity, note, description,
  image_url, image_urls, is_active, is_featured, created_at, updated_at,
  CASE
    WHEN is_wholesaler_or_admin() THEN wholesale_price
    ELSE NULL
  END AS wholesale_price,
  (wholesale_price IS NOT NULL) AS has_wholesale
FROM products;

GRANT SELECT ON products_view TO anon, authenticated;

-- ---------- PART 5: tighten existing admin write policies to is_admin() ----------
-- Previously gated by auth.role() = 'authenticated', which a freshly signed-up
-- wholesaler would also pass. Now that self-signup exists, gate on is_admin().
DROP POLICY IF EXISTS "products_admin_all" ON products;
CREATE POLICY "products_admin_all"
  ON products FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS "categories_admin_write" ON categories;
CREATE POLICY "categories_admin_write"
  ON categories FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

DROP POLICY IF EXISTS "app_settings_admin_write" ON app_settings;
CREATE POLICY "app_settings_admin_write"
  ON app_settings FOR ALL TO authenticated
  USING (is_admin())
  WITH CHECK (is_admin());

-- Storage write policies were "any authenticated user" — safe when only Naeem
-- could log in, but self-signup now means any visitor gets an authenticated
-- session. Without this, a signed-up wholesaler could upload or DELETE product
-- images via a raw call. Restrict writes to admins; public read is unchanged.
DROP POLICY IF EXISTS "product_images_admin_insert" ON storage.objects;
CREATE POLICY "product_images_admin_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'product-images' AND is_admin());

DROP POLICY IF EXISTS "product_images_admin_update" ON storage.objects;
CREATE POLICY "product_images_admin_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'product-images' AND is_admin())
  WITH CHECK (bucket_id = 'product-images' AND is_admin());

DROP POLICY IF EXISTS "product_images_admin_delete" ON storage.objects;
CREATE POLICY "product_images_admin_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'product-images' AND is_admin());

-- ---------- PART 10 support: admin-only wholesaler listing with email ----------
-- The admin "Wholesalers" tab needs each account's email, which lives in
-- auth.users (not exposed to the API). This SECURITY DEFINER function joins it
-- in and returns rows ONLY to an admin caller (empty set otherwise).
CREATE OR REPLACE FUNCTION admin_list_profiles()
RETURNS TABLE (
  id            uuid,
  role          text,
  status        text,
  business_name text,
  phone         text,
  email         text,
  created_at    timestamptz,
  approved_at   timestamptz
)
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT p.id, p.role, p.status, p.business_name, p.phone,
         u.email::text, p.created_at, p.approved_at
  FROM profiles p
  JOIN auth.users u ON u.id = p.id
  WHERE is_admin()
  ORDER BY p.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION admin_list_profiles() TO authenticated;

-- ============================================================
-- PART 6 — MANUAL BOOTSTRAP (run once, edit the email first):
--
--   INSERT INTO profiles (id, role, status)
--   SELECT id, 'admin', 'approved'
--   FROM auth.users
--   WHERE email = 'REPLACE_WITH_YOUR_ACTUAL_ADMIN_LOGIN_EMAIL'
--   ON CONFLICT (id) DO UPDATE SET role = 'admin', status = 'approved';
--
-- Then turn OFF "Confirm email" in Auth settings if it is currently on.
-- ============================================================
