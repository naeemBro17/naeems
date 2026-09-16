-- ============================================================
-- Naeem's Price Hub — Migration 014: promo codes (Cart & Checkout flow)
-- Run this in the Supabase SQL Editor after migration-013. Safe to re-run.
--
-- Admin creates codes in Admin → Promo Codes; customers redeem them on the
-- Order Summary screen. times_used only ever changes through
-- increment_promo_usage() below — never a direct client UPDATE — so a
-- leaked/shared code can't be spent past its max_uses by calling the REST
-- API directly.
-- ============================================================

CREATE TABLE IF NOT EXISTS promo_codes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE,
  discount_amount numeric(10,2) NOT NULL CHECK (discount_amount >= 0),
  discount_type   text NOT NULL DEFAULT 'fixed' CHECK (discount_type IN ('fixed', 'percent')),
  max_uses        integer CHECK (max_uses IS NULL OR max_uses > 0),
  times_used      integer NOT NULL DEFAULT 0 CHECK (times_used >= 0),
  expires_at      timestamptz,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz DEFAULT now(),
  -- A percent discount above 100 makes no sense; fixed amounts have no such cap.
  CONSTRAINT promo_codes_percent_range CHECK (discount_type <> 'percent' OR discount_amount <= 100)
);

-- ---------- RLS ----------
ALTER TABLE promo_codes ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Public validation read: only rows that are CURRENTLY usable are visible
  -- at all, so a raw REST call can't enumerate inactive/expired/exhausted
  -- codes or learn why a given code failed — it just doesn't come back.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'promo_codes' AND policyname = 'promo_codes_public_read'
  ) THEN
    CREATE POLICY "promo_codes_public_read"
      ON promo_codes FOR SELECT TO anon, authenticated
      USING (
        active = true
        AND (max_uses IS NULL OR times_used < max_uses)
        AND (expires_at IS NULL OR expires_at > now())
      );
  END IF;

  -- Admin sees and manages every row regardless of validity.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'promo_codes' AND policyname = 'promo_codes_admin_all'
  ) THEN
    CREATE POLICY "promo_codes_admin_all"
      ON promo_codes FOR ALL TO authenticated
      USING (is_admin())
      WITH CHECK (is_admin());
  END IF;
END $$;

-- ---------- Column lock ----------
-- anon (and a logged-in-but-not-admin authenticated user) gets exactly the
-- columns needed to validate a code and compute its discount. id/created_at
-- stay off-limits so a column added later defaults to hidden, not exposed.
REVOKE SELECT ON promo_codes FROM anon, authenticated;
GRANT SELECT (code, discount_amount, discount_type, active, max_uses, times_used, expires_at)
  ON promo_codes TO anon, authenticated;
-- The admin list view additionally needs id (for edit/delete) and created_at
-- (for sorting); combined with the grant above this gives authenticated
-- (i.e. the admin, gated by the RLS policy above) the full row.
GRANT SELECT (id, created_at) ON promo_codes TO authenticated;
GRANT INSERT, UPDATE, DELETE ON promo_codes TO authenticated;

-- ---------- increment_promo_usage: the only way times_used ever changes ----------
-- Re-checks active/max_uses/expires_at at the moment of the call — not
-- trusting whatever the client validated when the code was applied — so a
-- code that ran out between "Apply" and reaching the confirmation screen
-- can't be spent past its limit. Returns false when it no longer qualifies;
-- the caller does NOT retroactively change the customer's already-shown
-- total either way (see OrderSuccessPage.tsx).
CREATE OR REPLACE FUNCTION increment_promo_usage(promo_code text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE promo_codes
  SET times_used = times_used + 1
  WHERE lower(code) = lower(promo_code)
    AND active = true
    AND (max_uses IS NULL OR times_used < max_uses)
    AND (expires_at IS NULL OR expires_at > now());
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION increment_promo_usage(text) TO anon, authenticated;

-- ---------- shop_whatsapp_number setting ----------
-- Admin-editable in Settings; OrderSuccessPage reads it to build the wa.me
-- link customers send their order to. Seeded blank so the app still renders
-- before an admin sets a real number.
INSERT INTO app_settings (key, value)
VALUES ('shop_whatsapp_number', '')
ON CONFLICT (key) DO NOTHING;

-- ---------- Verify ----------
-- As the anon key, this must return a 42501 permission error, not a row:
--   GET /rest/v1/promo_codes?select=id&limit=1
-- and this must return only currently-valid codes, validation columns only:
--   GET /rest/v1/promo_codes?select=code,discount_amount,active&limit=5
