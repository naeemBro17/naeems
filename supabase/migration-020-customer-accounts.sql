-- ============================================================
-- Naeem's Price Hub — Migration 020: customer accounts (Batch 16)
-- Run this in the Supabase SQL Editor after migration-019. Safe to re-run.
--
-- Adds a third role, 'customer', to the existing profiles table (chosen over
-- a separate customers table — see reports/batch-16.txt for why: every
-- role-check function, and every RLS policy across the whole schema, already
-- keys off "is there a profiles row for auth.uid() with role X" — a second
-- table would be a second source of truth for the exact same question,
-- which CLAUDE.md rules out). Google sign-in means ANY visitor with a
-- Google account can now become an "authenticated" Supabase user — this
-- migration makes sure that only ever grants plain customer powers, never
-- admin or wholesaler, no matter what the client sends.
-- ============================================================

-- ---------- PART 1: allow the 'customer' role ----------
DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT con.conname INTO constraint_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'profiles'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) ILIKE '%role%IN%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE profiles DROP CONSTRAINT %I', constraint_name);
  END IF;

  ALTER TABLE profiles ADD CONSTRAINT profiles_role_check
    CHECK (role IN ('customer', 'wholesaler', 'admin'));
END $$;

-- ---------- PART 2: customer profile columns ----------
-- full_name/photo_url are seeded from the Google profile on first login and
-- editable afterwards. division/district/thana/address_line are the one
-- saved delivery address (Part 4). Email is deliberately NOT duplicated here
-- — it's already on auth.users and the app reads it straight from the
-- logged-in session, so there's nothing to keep in sync.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS full_name    text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS photo_url    text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS division     text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS district     text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS thana        text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS address_line text;

-- ---------- PART 3: let a customer self-provision their own row ----------
-- Replaces migration-004's version, which only allowed
-- role='wholesaler' AND status='pending'. A customer needs the same kind of
-- one-time self-insert, but pre-approved (customers don't go through an
-- approval queue) — still never admin, never a pre-approved wholesaler.
DROP POLICY IF EXISTS "profiles_self_insert" ON profiles;
CREATE POLICY "profiles_self_insert"
  ON profiles FOR INSERT TO authenticated
  WITH CHECK (
    id = auth.uid()
    AND (
      (role = 'wholesaler' AND status = 'pending')
      OR (role = 'customer' AND status = 'approved')
    )
  );

-- ---------- PART 4: let any signed-in user edit their OWN contact details ----------
-- No self-update policy existed before this migration (profiles could only
-- ever be changed by an admin). This adds one, scoped to "your own row" —
-- role/status/business_name/approved_at are then frozen against self-edits
-- by the trigger in Part 5, regardless of what this policy allows, so this
-- stays safe even if the WITH CHECK below is ever loosened by mistake later.
DROP POLICY IF EXISTS "profiles_self_update" ON profiles;
CREATE POLICY "profiles_self_update"
  ON profiles FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- ---------- PART 5: hard block on self-role-escalation ----------
-- Belt-and-suspenders on top of Part 4's RLS policy: even if a future change
-- loosens profiles_self_update's WITH CHECK, this trigger still refuses any
-- UPDATE that changes role, status, or approved_at unless the caller is
-- already an admin. This is the one thing in this migration that, if wrong,
-- would let a random Google sign-in make themselves admin — so it uses
-- explicit OLD/NEW comparison (no snapshot-timing subtlety) and is checked
-- live in Part 6 below with a real customer session, not just read from SQL.
CREATE OR REPLACE FUNCTION prevent_profile_self_escalation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF is_admin() THEN
    RETURN NEW;
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
     OR NEW.business_name IS DISTINCT FROM OLD.business_name THEN
    RAISE EXCEPTION 'Only an admin can change role, status, approval, or business name.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_prevent_self_escalation ON profiles;
CREATE TRIGGER profiles_prevent_self_escalation
  BEFORE UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION prevent_profile_self_escalation();

-- ---------- PART 6: keep the admin "Wholesalers" tab customer-free ----------
-- admin_list_profiles() (migration-004) had no role filter because, before
-- this migration, every profiles row WAS a wholesaler or an admin. Now that
-- customers get a row too, scope it back to wholesalers so the existing
-- admin panel isn't flooded with every customer signup. (The admin panel's
-- own client code already filters to role==='wholesaler' as a second layer,
-- so this is belt-and-suspenders, not a behaviour change.)
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
SET search_path = public
AS $$
  SELECT p.id, p.role, p.status, p.business_name, p.phone,
         u.email::text, p.created_at, p.approved_at
  FROM profiles p
  JOIN auth.users u ON u.id = p.id
  WHERE is_admin() AND p.role = 'wholesaler'
  ORDER BY p.created_at DESC;
$$;

-- ---------- PART 7: pin down search_path on the SECURITY DEFINER helpers ----------
-- Optional hardening flagged in the Batch 15 audit (reports/batch-15.txt) —
-- bundled in here since this migration already touches these functions.
-- Purely defensive; does not change any behaviour.
ALTER FUNCTION is_admin() SET search_path = public;
ALTER FUNCTION is_wholesaler_or_admin() SET search_path = public;

-- ============================================================
-- ---------- Verify (run as the anon key, then as a real Google-logged-in
-- customer session, not just read — see reports/batch-16.txt Part 1) ----------
--
-- As a real logged-in customer (never the SQL editor, which runs as
-- postgres and bypasses RLS):
--   1. INSERT INTO profiles (id, role, status, full_name)
--        VALUES (auth.uid(), 'customer', 'approved', 'Test Customer');
--      → must succeed.
--   2. UPDATE profiles SET role = 'admin' WHERE id = auth.uid();
--      → must fail ("Only an admin can change role...").
--   3. UPDATE profiles SET phone = '01712345678' WHERE id = auth.uid();
--      → must succeed.
--   4. SELECT * FROM profiles WHERE id <> auth.uid();
--      → must return zero rows.
--   5. SELECT wholesale_price FROM products_view LIMIT 1;
--      → must return null (customer role never satisfies
--        is_wholesaler_or_admin()).
-- ============================================================
