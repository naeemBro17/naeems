-- Batch 34 — Security (reports/batch-34.txt).
--
--   Part 1: two-step login (Authenticator app). One shared check,
--           is_mfa_satisfied(), is added to is_admin(), is_staff() and
--           staff_can() — the gates every admin action already goes
--           through (RLS policies, admin RPCs, the steadfast and admin-team
--           Edge Functions). A user WITHOUT a confirmed Authenticator passes
--           it exactly as today. A user WITH one passes only when the
--           session gave the 6-digit code (JWT "aal" = aal2).
--           log_mfa_event() writes the Activity Log lines (no keys, no codes).
--   Part 3: the "order-telegram" trigger on orders called the
--           notify-telegram-order function with the service key written in
--           plain text inside the trigger. It is replaced by a trigger
--           function that sends a dedicated random shared secret kept in
--           Supabase Vault. Same alerts (INSERT and UPDATE of every order),
--           same payload, same timing.
--
-- Additive / behaviour-preserving only. Safe to run more than once.

BEGIN;

-- ---------------------------------------------------------------------------
-- Part 1: the shared two-step check
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_mfa_satisfied()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  -- No signed-in user: nothing to check here (every admin gate also needs
  -- auth.uid()). Otherwise: either this session gave the 6-digit code, or
  -- the account has no confirmed Authenticator at all.
  SELECT auth.uid() IS NULL
      OR COALESCE(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      OR NOT EXISTS (
           SELECT 1 FROM auth.mfa_factors f
           WHERE f.user_id = auth.uid() AND f.status = 'verified'
         );
$function$;

REVOKE ALL ON FUNCTION public.is_mfa_satisfied() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_mfa_satisfied() TO authenticated, service_role;

-- Same bodies as before, plus "AND is_mfa_satisfied()".
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
    AND status = 'approved'
    AND role = 'admin'
  ) AND is_mfa_satisfied();
$function$;

CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT is_admin() OR (EXISTS (
    SELECT 1
    FROM profiles p
    JOIN staff_members s ON s.id = p.id
    WHERE p.id = auth.uid()
      AND p.role = 'moderator'
      AND p.status = 'approved'
      AND NOT s.is_disabled
  ) AND is_mfa_satisfied());
$function$;

CREATE OR REPLACE FUNCTION public.staff_can(p_perm text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT is_admin() OR (EXISTS (
    SELECT 1
    FROM profiles p
    JOIN staff_members s ON s.id = p.id
    LEFT JOIN staff_roles r ON r.id = s.role_id
    WHERE p.id = auth.uid()
      AND p.role = 'moderator'
      AND p.status = 'approved'
      AND NOT s.is_disabled
      AND p_perm = ANY (CASE WHEN s.role_id IS NULL THEN s.permissions ELSE COALESCE(r.permissions, '{}'::text[]) END)
  ) AND is_mfa_satisfied());
$function$;

-- Activity Log: two-step login turned on / phone added / removed / off.
-- Only the phone's name ("Phone 2") is stored — never a key or a code.
CREATE OR REPLACE FUNCTION public.log_mfa_event(p_action text, p_device text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_action NOT IN ('staff.mfa_on', 'staff.mfa_device_added', 'staff.mfa_device_removed', 'staff.mfa_off') THEN
    RAISE EXCEPTION 'Invalid event.';
  END IF;
  IF NOT is_staff() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  PERFORM write_activity(
    p_action, 'staff', auth.uid()::text, current_actor_username(),
    CASE p_action
      WHEN 'staff.mfa_on' THEN 'Turned on two-step login'
      WHEN 'staff.mfa_device_added' THEN 'Added a backup phone for two-step login'
      WHEN 'staff.mfa_device_removed' THEN 'Removed a phone from two-step login'
      ELSE 'Turned off two-step login'
    END || ' (' || left(COALESCE(p_device, 'Phone'), 40) || ')'
  );
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.log_mfa_event(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_mfa_event(text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Part 3: no key inside the database
-- ---------------------------------------------------------------------------

-- A dedicated random shared secret, created here and kept only in Vault.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'notify_telegram_order_secret') THEN
    PERFORM vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'notify_telegram_order_secret',
      'Batch 34: shared secret the orders trigger sends to notify-telegram-order'
    );
  END IF;
END
$$;

-- The notify-telegram-order function reads the same secret to check the
-- header (service role only — never the website).
CREATE OR REPLACE FUNCTION public.notify_order_secret()
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'notify_telegram_order_secret';
$function$;

REVOKE ALL ON FUNCTION public.notify_order_secret() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_order_secret() TO service_role;

-- Sends the same payload the old Database Webhook sent
-- ({ type, table, schema, record, old_record }), same URL, same 5 s timeout.
-- A failure here never blocks the order itself.
CREATE OR REPLACE FUNCTION public.notify_telegram_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_secret text;
BEGIN
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE name = 'notify_telegram_order_secret';
  IF v_secret IS NULL THEN
    RAISE WARNING 'notify_telegram_order: Vault secret missing, alert not sent';
    RETURN NULL;
  END IF;
  PERFORM net.http_post(
    url := 'https://afkgkpuppmwmkyrbheew.supabase.co/functions/v1/notify-telegram-order',
    body := jsonb_build_object(
      'type', TG_OP,
      'table', TG_TABLE_NAME,
      'schema', TG_TABLE_SCHEMA,
      'record', to_jsonb(NEW),
      'old_record', CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END
    ),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-notify-secret', v_secret
    ),
    timeout_milliseconds := 5000
  );
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'notify_telegram_order failed: %', SQLERRM;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_telegram_order() FROM PUBLIC, anon, authenticated;

-- Swap the trigger: same name, same events (AFTER INSERT OR UPDATE, each row).
DROP TRIGGER IF EXISTS "order-telegram" ON public.orders;
CREATE TRIGGER "order-telegram"
  AFTER INSERT OR UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.notify_telegram_order();

COMMIT;

-- Proof (should return 0 rows): no JWT-looking key, sb_secret_ key or bot
-- token in any function, trigger argument or cron job.
--   SELECT 'function' AS kind, p.proname AS name FROM pg_proc p
--     JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
--      AND (p.prosrc ~ 'eyJ[A-Za-z0-9_-]{10,}' OR p.prosrc ~ 'sb_secret_'
--           OR p.prosrc ~ '[0-9]{8,10}:[A-Za-z0-9_-]{30,}')
--   UNION ALL
--   SELECT 'trigger', t.tgname FROM pg_trigger t
--    WHERE NOT t.tgisinternal
--      AND (encode(t.tgargs, 'escape') ~ 'eyJ[A-Za-z0-9_-]{10,}'
--           OR encode(t.tgargs, 'escape') ~ 'sb_secret_')
--   UNION ALL
--   SELECT 'cron', j.jobname FROM cron.job j
--    WHERE j.command ~ 'eyJ[A-Za-z0-9_-]{10,}' OR j.command ~ 'sb_secret_';
