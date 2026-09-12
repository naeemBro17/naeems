-- ============================================================
-- Naeem's Price Hub — Migration 011: reviews table privileges
-- Run this in the Supabase SQL Editor. Safe to re-run.
--
-- THE BUG
-- migration-006 created the reviews table with RLS policies but no explicit
-- GRANT, relying on Supabase's default privileges for new tables. In this
-- project those defaults did not apply, so the public API returns:
--
--     GET /rest/v1/reviews  →  42501 permission denied for table reviews
--
-- The /contact page therefore shows "No reviews yet" to every visitor and
-- the public "Share your experience" form cannot insert.
--
-- THE FIX
-- Grant the table privileges the RLS policies assume. Row visibility is
-- unchanged: anon and authenticated still see only approved+visible rows,
-- may only insert unapproved rows, and only is_admin() can manage the rest.
-- ============================================================

GRANT SELECT, INSERT ON reviews TO anon, authenticated;
GRANT UPDATE, DELETE ON reviews TO authenticated;

-- ---------- Verify ----------
-- This must now return the seeded reviews rather than a 42501:
--   GET /rest/v1/reviews?select=id,name&is_approved=eq.true
