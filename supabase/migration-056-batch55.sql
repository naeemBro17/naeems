-- =====================================================================
-- Batch 55 — One customer, many numbers
--
-- Paste the whole file into the Supabase SQL Editor and press Run.
-- It is safe to run more than once.
--
--   customer_phones            NEW: a customer's extra (old / second)
--                              numbers. A number belongs to ONE customer.
--   customer_merges            NEW: what every "Merge two customers" (and
--                              the one-time Nabila Nur fix) moved, row by
--                              row, with the old values.
--   order_customer_keys        an order on an extra number belongs to the
--                              number's customer (rule order: customer_id →
--                              admin_customer_id → extra number → profile
--                              with that phone → ph: → n:)
--   money_customer_key_for_phone  the same rule for previous balances
--   money_customer_dues        one row per customer even with two numbers
--   admin_customers_v2         a merged customer keeps its own name / number
--   admin_add_customer         an extra number is "already a customer"
--   admin_delete_customer      also removes that customer's extra numbers
--   kaarbar_import_customers   skips a number that is someone's extra number
--   kaarbar_customer_old_bills old bills on any of the customer's numbers
--   money_lock_opening / money_lock_due_payments
--                              a locked month still refuses every change of
--                              amount or date; only moving a row to the
--                              kept customer's number (a merge) is allowed
--   admin_customer_numbers / admin_add_customer_number /
--   admin_remove_customer_number / admin_merge_preview /
--   admin_merge_customers      NEW (Super Admin only)
--
-- Money: nothing is added, deleted or re-calculated. A merge only changes
-- WHO rows belong to, and checks that every total is the same after it.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_phones (
  phone_key           text PRIMARY KEY,
  customer_key        text NOT NULL,
  phone               text NOT NULL,
  source              text NOT NULL CHECK (source IN ('added', 'kaarbar', 'merge')),
  created_by          uuid,
  created_by_username text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customer_phones_customer ON customer_phones (customer_key);

ALTER TABLE customer_phones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "customer_phones_staff_read" ON customer_phones;
CREATE POLICY "customer_phones_staff_read"
  ON customer_phones FOR SELECT TO authenticated
  USING (staff_can('view_customers'));
-- Reads only. Every write goes through the functions below.
REVOKE ALL ON customer_phones FROM anon, authenticated;
GRANT SELECT ON customer_phones TO authenticated;
GRANT ALL ON customer_phones TO service_role;

CREATE TABLE IF NOT EXISTS customer_merges (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                text NOT NULL CHECK (kind IN ('merge', 'one_time_fix')),
  kept_key            text NOT NULL,
  removed_key         text NOT NULL,
  -- Every moved row: {"table", "id", "old": {column: old value}} ("old"
  -- is null for a row that was added).
  moved               jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by          uuid,
  created_by_username text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customer_merges_kept ON customer_merges (kept_key, created_at DESC);

ALTER TABLE customer_merges ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "customer_merges_admin_read" ON customer_merges;
CREATE POLICY "customer_merges_admin_read"
  ON customer_merges FOR SELECT TO authenticated
  USING (is_admin());
REVOKE ALL ON customer_merges FROM anon, authenticated;
GRANT SELECT ON customer_merges TO authenticated;
GRANT ALL ON customer_merges TO service_role;

-- ---------------------------------------------------------------------
-- 2. Small helpers (never called from the browser)
-- ---------------------------------------------------------------------

-- The main number of a customer key: a login's profile phone, or the
-- number in "ph:<number>". Null for "n:<name>" or a login with no phone.
CREATE OR REPLACE FUNCTION customer_main_phone_key(p_key text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_key LIKE 'ph:%' THEN NULLIF(substr(p_key, 4), '')
    WHEN p_key LIKE 'p:%' THEN (SELECT bd_phone_key(p.phone) FROM profiles p WHERE p.id::text = substr(p_key, 3))
  END;
$$;

-- Who a number belongs to (null = nobody): someone's extra number, a
-- login's phone, a customers row, orders grouped under "ph:<number>",
-- a previous balance on it, or an old Kaarbar bill on it.
CREATE OR REPLACE FUNCTION customer_phone_owner(p_phone_key text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT cp.customer_key FROM customer_phones cp WHERE cp.phone_key = p_phone_key),
    (SELECT 'p:' || p.id FROM profiles p WHERE p.role = 'customer' AND bd_phone_key(p.phone) = p_phone_key
     ORDER BY p.created_at, p.id LIMIT 1),
    (SELECT c.customer_key FROM customers c WHERE c.phone_key = p_phone_key
     ORDER BY (c.customer_key = 'ph:' || p_phone_key) DESC, c.created_at LIMIT 1),
    (SELECT 'ph:' || p_phone_key WHERE EXISTS (
       SELECT 1 FROM orders o WHERE bd_phone_key(o.customer_phone) = p_phone_key
         AND o.customer_id IS NULL AND o.admin_customer_id IS NULL)),
    (SELECT 'ph:' || p_phone_key WHERE EXISTS (SELECT 1 FROM customer_opening_dues d WHERE d.phone_key = p_phone_key)
       OR EXISTS (SELECT 1 FROM customer_due_payments d WHERE d.phone_key = p_phone_key)
       OR EXISTS (SELECT 1 FROM customer_previous_corrections d WHERE d.phone_key = p_phone_key)),
    (SELECT b.customer_key FROM kaarbar_bills b WHERE b.phone_key = p_phone_key AND b.customer_key IS NOT NULL
     ORDER BY b.created_at LIMIT 1));
$$;

-- True when the key is a customer the Customers page knows.
CREATE OR REPLACE FUNCTION customer_key_known(p_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_key IS NOT NULL AND (
       (p_key LIKE 'p:%' AND EXISTS (SELECT 1 FROM profiles p WHERE p.role = 'customer' AND p.id::text = substr(p_key, 3)))
    OR EXISTS (SELECT 1 FROM customers c WHERE c.customer_key = p_key)
    OR EXISTS (SELECT 1 FROM order_customer_keys() k WHERE k.customer_key = p_key)
    OR (p_key LIKE 'ph:%' AND customer_phone_owner(substr(p_key, 4)) = p_key));
$$;

-- The name the Customers page shows for a key.
CREATE OR REPLACE FUNCTION customer_name_for_key(p_key text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH k AS (
    SELECT o.customer_name, o.customer_phone, o.created_at
    FROM order_customer_keys() x JOIN orders o ON o.id = x.order_id
    WHERE x.customer_key = p_key
  )
  SELECT COALESCE(
    CASE WHEN p_key LIKE 'p:%' THEN (SELECT NULLIF(btrim(p.full_name), '') FROM profiles p WHERE p.id::text = substr(p_key, 3)) END,
    (SELECT NULLIF(btrim(k.customer_name), '') FROM k
     WHERE p_key NOT LIKE 'ph:%' OR bd_phone_key(k.customer_phone) = substr(p_key, 4)
     ORDER BY k.created_at DESC LIMIT 1),
    (SELECT NULLIF(btrim(c.full_name), '') FROM customers c WHERE c.customer_key = p_key),
    (SELECT NULLIF(btrim(k.customer_name), '') FROM k ORDER BY k.created_at DESC LIMIT 1),
    customer_main_phone_key(p_key),
    p_key);
$$;

-- What uses a number: orders, old Kaarbar bills and money rows (opening
-- dues, payments, corrections, reminders).
CREATE OR REPLACE FUNCTION customer_number_use(p_phone_key text)
RETURNS TABLE (orders integer, bills integer, money_rows integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    (SELECT count(*) FROM orders o WHERE bd_phone_key(o.customer_phone) = p_phone_key)::integer,
    (SELECT count(*) FROM kaarbar_bills b WHERE b.phone_key = p_phone_key)::integer,
    ((SELECT count(*) FROM customer_opening_dues d WHERE d.phone_key = p_phone_key)
     + (SELECT count(*) FROM customer_due_payments d WHERE d.phone_key = p_phone_key)
     + (SELECT count(*) FROM customer_previous_corrections d WHERE d.phone_key = p_phone_key)
     + (SELECT count(*) FROM customer_due_reminders d WHERE d.phone_key = p_phone_key))::integer;
$$;

-- The money totals a merge must never change. Read straight from the
-- tables and through the customer grouping, so a lost or doubled row
-- shows up as a difference.
CREATE OR REPLACE FUNCTION customer_money_totals()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH mp AS (SELECT money_position() AS j)
  SELECT jsonb_build_object(
    'order_due', (SELECT COALESCE(sum(due), 0) FROM order_customer_keys()),
    'order_due_by_customer', (SELECT COALESCE(sum(d), 0) FROM (SELECT customer_key, sum(due) AS d FROM order_customer_keys() GROUP BY customer_key) g),
    'previous', COALESCE((SELECT sum(amount) FROM customer_opening_dues), 0)
                - COALESCE((SELECT sum(amount) FROM customer_due_payments), 0)
                + COALESCE((SELECT sum(amount_change) FROM customer_previous_corrections), 0),
    'previous_by_customer', (SELECT COALESCE(sum(money_previous_left(x.phone_key)), 0) FROM (
        SELECT phone_key FROM customer_opening_dues UNION SELECT phone_key FROM customer_due_payments
        UNION SELECT phone_key FROM customer_previous_corrections) x),
    'net_worth', (mp.j ->> 'net_worth')::numeric,
    'to_receive', (mp.j ->> 'to_receive')::numeric,
    'previous_balances', (mp.j ->> 'previous_balances')::numeric)
  FROM mp;
$$;

-- What one side of a merge has (the "WHAT HAPPENS" card).
CREATE OR REPLACE FUNCTION customer_merge_side(p_key text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH nums AS (
    SELECT customer_main_phone_key(p_key) AS phone_key WHERE customer_main_phone_key(p_key) IS NOT NULL
    UNION
    SELECT cp.phone_key FROM customer_phones cp WHERE cp.customer_key = p_key
  ), k AS (
    SELECT x.due, o.status FROM order_customer_keys() x JOIN orders o ON o.id = x.order_id WHERE x.customer_key = p_key
  )
  SELECT jsonb_build_object(
    'orders', (SELECT count(*) FROM k WHERE k.status <> 'cancelled'),
    'due', (SELECT COALESCE(sum(k.due), 0) FROM k),
    'previous', (SELECT COALESCE(sum(money_previous_left(n.phone_key)), 0) FROM nums n),
    'bills', (SELECT count(*) FROM kaarbar_bills b WHERE b.customer_key = p_key OR b.phone_key IN (SELECT phone_key FROM nums)));
$$;

-- Why two customers can't be merged (null = they can).
CREATE OR REPLACE FUNCTION customer_merge_refusal(p_keep_key text, p_remove_key text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rem_pk text;
BEGIN
  IF NOT customer_key_known(p_keep_key) THEN
    RETURN 'Open the customer again.';
  END IF;
  IF NOT customer_key_known(p_remove_key) THEN
    RETURN 'That customer was not found. Search again.';
  END IF;
  IF p_keep_key = p_remove_key THEN
    RETURN 'Pick another customer.';
  END IF;
  IF p_remove_key LIKE 'p:%' THEN
    RETURN 'Has a login. Open it and merge this customer into it.';
  END IF;
  v_rem_pk := customer_main_phone_key(p_remove_key);
  IF v_rem_pk IS NULL THEN
    RETURN 'No phone number, so it can''t be merged.';
  END IF;
  IF customer_main_phone_key(p_keep_key) IS NULL THEN
    RETURN 'This customer has no phone number, so another customer can''t be merged into it.';
  END IF;
  IF customer_phone_owner(v_rem_pk) IS DISTINCT FROM p_remove_key THEN
    RETURN 'That customer''s number belongs to another customer. Search again.';
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION customer_main_phone_key(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION customer_phone_owner(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION customer_key_known(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION customer_name_for_key(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION customer_number_use(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION customer_money_totals() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION customer_merge_side(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION customer_merge_refusal(text, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Grouping: an order / a previous balance on an extra number belongs
--    to that number's customer. Everything else exactly as before.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION order_customer_keys()
 RETURNS TABLE(order_id uuid, customer_key text, profile_id uuid, due numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH prof AS (
    SELECT p.id, bd_phone_key(p.phone) AS pkey, p.created_at
    FROM profiles p WHERE p.role = 'customer'
  ),
  prof_by_key AS (
    SELECT DISTINCT ON (pkey) pkey, id FROM prof WHERE pkey IS NOT NULL ORDER BY pkey, created_at, id
  ),
  -- Batch 55: a customer's extra numbers.
  extra AS (
    SELECT cp.phone_key, cp.customer_key, pr.id AS pid
    FROM customer_phones cp LEFT JOIN prof pr ON 'p:' || pr.id = cp.customer_key
  ),
  paid AS (
    SELECT order_id, sum(CASE WHEN kind = 'refund' THEN -amount ELSE amount END) AS net
    FROM order_payments GROUP BY order_id
  )
  SELECT o.id,
         CASE
           WHEN own.id IS NOT NULL THEN 'p:' || own.id
           WHEN picked.id IS NOT NULL THEN 'p:' || picked.id
           WHEN ex.customer_key IS NOT NULL THEN ex.customer_key
           WHEN pk.id IS NOT NULL THEN 'p:' || pk.id
           WHEN bd_phone_key(o.customer_phone) IS NOT NULL THEN 'ph:' || bd_phone_key(o.customer_phone)
           ELSE 'n:' || lower(trim(o.customer_name))
         END,
         COALESCE(own.id, picked.id, CASE WHEN ex.customer_key IS NOT NULL THEN ex.pid ELSE pk.id END),
         CASE WHEN o.status IN ('cancelled', 'returned') THEN 0 ELSE GREATEST(o.total - COALESCE(pd.net, 0), 0) END
  FROM orders o
  LEFT JOIN prof own ON own.id = o.customer_id
  LEFT JOIN prof picked ON picked.id = o.admin_customer_id
  LEFT JOIN extra ex ON ex.phone_key = bd_phone_key(o.customer_phone)
  LEFT JOIN prof_by_key pk ON pk.pkey = bd_phone_key(o.customer_phone)
  LEFT JOIN paid pd ON pd.order_id = o.id;
$function$;

CREATE OR REPLACE FUNCTION money_customer_key_for_phone(p_phone_key text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    -- Batch 55: an extra number belongs to its customer.
    (SELECT cp.customer_key FROM customer_phones cp WHERE cp.phone_key = p_phone_key),
    (SELECT 'p:' || p.id FROM profiles p WHERE p.role = 'customer' AND bd_phone_key(p.phone) = p_phone_key
     ORDER BY p.created_at, p.id LIMIT 1),
    'ph:' || p_phone_key);
$$;

CREATE OR REPLACE FUNCTION money_customer_dues()
 RETURNS TABLE(customer_key text, phone_key text, order_due numeric, previous_left numeric, latest_unpaid_order_id uuid, latest_unpaid_order_number text, last_reminder_at timestamp with time zone, last_reminder_amount numeric, reminders bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  RETURN QUERY
  WITH k AS (
    SELECT k.customer_key, k.order_id, k.due, o.created_at, o.order_number, bd_phone_key(o.customer_phone) AS pk
    FROM order_customer_keys() k JOIN orders o ON o.id = k.order_id
  ), by_order AS (
    SELECT k.customer_key,
           sum(k.due) AS due,
           (array_agg(k.pk ORDER BY k.created_at DESC) FILTER (WHERE k.pk IS NOT NULL))[1] AS pk,
           (array_agg(k.order_id ORDER BY k.created_at DESC) FILTER (WHERE k.due > 0))[1] AS last_id,
           (array_agg(k.order_number ORDER BY k.created_at DESC) FILTER (WHERE k.due > 0))[1] AS last_no
    FROM k GROUP BY k.customer_key
  ), prev_rows AS (
    SELECT d.phone_key, money_customer_key_for_phone(d.phone_key) AS customer_key, money_previous_left(d.phone_key) AS left_amount
    FROM (SELECT phone_key FROM customer_opening_dues
          UNION SELECT phone_key FROM customer_previous_corrections) d
  ), prev AS (
    -- Batch 55: one row per customer (a customer can now have more than one number).
    SELECT x.customer_key, sum(x.left_amount) AS left_amount,
           (array_agg(x.phone_key ORDER BY EXISTS (SELECT 1 FROM customer_phones cp WHERE cp.phone_key = x.phone_key), x.phone_key))[1] AS phone_key
    FROM prev_rows x GROUP BY x.customer_key
  ), keys AS (
    SELECT b.customer_key FROM by_order b
    UNION
    SELECT p.customer_key FROM prev p
  )
  SELECT ks.customer_key,
         COALESCE(CASE WHEN EXISTS (SELECT 1 FROM customer_phones cp WHERE cp.customer_key = ks.customer_key)
                       THEN customer_main_phone_key(ks.customer_key) END,
                  b.pk, p.phone_key, CASE WHEN ks.customer_key LIKE 'ph:%' THEN substr(ks.customer_key, 4) END),
         COALESCE(b.due, 0)::numeric,
         COALESCE(p.left_amount, 0)::numeric,
         b.last_id, b.last_no,
         r.at, r.amount, COALESCE(r.n, 0)
  FROM keys ks
  LEFT JOIN by_order b ON b.customer_key = ks.customer_key
  LEFT JOIN prev p ON p.customer_key = ks.customer_key
  LEFT JOIN LATERAL (
    SELECT max(x.created_at) AS at,
           (array_agg(x.amount ORDER BY x.created_at DESC))[1] AS amount,
           count(*) AS n
    FROM customer_due_reminders x WHERE x.customer_key = ks.customer_key
  ) r ON true
  WHERE COALESCE(b.due, 0) <> 0 OR COALESCE(p.left_amount, 0) <> 0 OR r.n > 0;
END;
$function$;

CREATE OR REPLACE FUNCTION admin_customers_v2()
 RETURNS TABLE(customer_key text, profile_id uuid, full_name text, email text, phone text, order_count bigint, total_spent numeric, total_due numeric, last_order_at timestamp with time zone, joined_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH k AS (SELECT * FROM order_customer_keys()),
  agg AS (
    SELECT k.customer_key,
           count(*) FILTER (WHERE o.status <> 'cancelled') AS order_count,
           COALESCE(sum(o.total) FILTER (WHERE o.status <> 'cancelled'), 0) AS spent,
           COALESCE(sum(k.due), 0) AS due,
           max(o.created_at) AS last_at,
           (array_agg(o.customer_name ORDER BY o.created_at DESC))[1] AS last_name,
           (array_agg(o.customer_phone ORDER BY o.created_at DESC))[1] AS last_phone,
           -- Batch 55: name and number from orders on the customer's own number
           -- (not from an extra number it got in a merge).
           count(*) FILTER (WHERE k.customer_key NOT LIKE 'ph:%' OR bd_phone_key(o.customer_phone) = substr(k.customer_key, 4)) AS own_n,
           (array_agg(o.customer_name ORDER BY o.created_at DESC) FILTER (WHERE k.customer_key NOT LIKE 'ph:%' OR bd_phone_key(o.customer_phone) = substr(k.customer_key, 4)))[1] AS own_name,
           (array_agg(o.customer_phone ORDER BY o.created_at DESC) FILTER (WHERE k.customer_key NOT LIKE 'ph:%' OR bd_phone_key(o.customer_phone) = substr(k.customer_key, 4)))[1] AS own_phone
    FROM k JOIN orders o ON o.id = k.order_id
    GROUP BY k.customer_key
  ),
  allrows AS (
    SELECT 'p:' || p.id AS customer_key, p.id AS profile_id, COALESCE(p.full_name, '') AS full_name,
           u.email::text AS email, COALESCE(p.phone, '') AS phone,
           COALESCE(a.order_count, 0) AS order_count, COALESCE(a.spent, 0) AS spent,
           COALESCE(a.due, 0) AS due, a.last_at, p.created_at AS joined_at
    FROM profiles p
    JOIN auth.users u ON u.id = p.id
    LEFT JOIN agg a ON a.customer_key = 'p:' || p.id
    WHERE p.role = 'customer'
    UNION ALL
    SELECT a.customer_key, NULL::uuid,
           CASE WHEN a.own_n > 0 THEN COALESCE(a.own_name, '') ELSE COALESCE(NULLIF(c.full_name, ''), a.last_name, '') END, '',
           CASE WHEN a.own_n > 0 THEN COALESCE(a.own_phone, '') ELSE COALESCE(NULLIF(c.phone, ''), substr(a.customer_key, 4)) END,
           a.order_count, a.spent, a.due, a.last_at, NULL::timestamptz
    FROM agg a
    LEFT JOIN customers c ON c.customer_key = a.customer_key
    WHERE a.customer_key NOT LIKE 'p:%'
  )
  SELECT r.customer_key, r.profile_id, r.full_name, r.email, r.phone, r.order_count,
         CASE WHEN staff_can('see_sales') THEN r.spent END,
         CASE WHEN staff_can('see_sales') OR staff_can('view_orders') THEN r.due END,
         r.last_at, r.joined_at
  FROM allrows r
  WHERE staff_can('view_customers')
  ORDER BY r.last_at DESC NULLS LAST, r.joined_at DESC NULLS LAST;
$function$;

CREATE OR REPLACE FUNCTION admin_add_customer(p_full_name text, p_phone text, p_alt_phone text DEFAULT NULL::text, p_division text DEFAULT NULL::text, p_district text DEFAULT NULL::text, p_thana text DEFAULT NULL::text, p_address_line text DEFAULT NULL::text, p_note text DEFAULT NULL::text)
 RETURNS TABLE(customer_key text, existed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_key   text := bd_phone_key(p_phone);
  v_found text;
  v_new   text;
BEGIN
  IF NOT (is_admin() OR staff_can('create_orders') OR staff_can('manage_customers')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF trim(COALESCE(p_full_name, '')) = '' THEN
    RAISE EXCEPTION 'Enter the name of the customer.';
  END IF;
  IF v_key IS NULL OR v_key !~ '^01[3-9][0-9]{8}$' THEN
    RAISE EXCEPTION 'Enter a valid Bangladeshi mobile number (01XXXXXXXXX).';
  END IF;

  -- Batch 55: an extra number belongs to its customer.
  SELECT cp.customer_key INTO v_found FROM customer_phones cp WHERE cp.phone_key = v_key;
  IF v_found IS NULL THEN
    SELECT 'p:' || p.id INTO v_found
    FROM profiles p WHERE p.role = 'customer' AND bd_phone_key(p.phone) = v_key
    ORDER BY p.created_at, p.id LIMIT 1;
  END IF;
  IF v_found IS NULL THEN
    SELECT k.customer_key INTO v_found
    FROM order_customer_keys() k JOIN orders o ON o.id = k.order_id
    WHERE bd_phone_key(o.customer_phone) = v_key
    ORDER BY o.created_at DESC LIMIT 1;
  END IF;
  IF v_found IS NULL THEN
    SELECT c.customer_key INTO v_found FROM customers c WHERE c.phone_key = v_key AND c.added_by_hand LIMIT 1;
  END IF;
  IF v_found IS NOT NULL THEN
    RETURN QUERY SELECT v_found, true;
    RETURN;
  END IF;

  v_new := 'ph:' || v_key;
  INSERT INTO customers AS c (customer_key, phone_key, full_name, phone, alt_phone, division, district, thana, address_line,
                         note, added_by_hand, created_by, created_by_username, updated_by_username)
  VALUES (v_new, v_key, trim(p_full_name), v_key, NULLIF(trim(COALESCE(p_alt_phone, '')), ''),
          COALESCE(p_division, ''), COALESCE(p_district, ''), COALESCE(p_thana, ''), trim(COALESCE(p_address_line, '')),
          NULLIF(trim(COALESCE(p_note, '')), ''), true, auth.uid(), current_actor_username(), current_actor_username())
  ON CONFLICT ON CONSTRAINT customers_pkey DO UPDATE
    SET full_name = EXCLUDED.full_name, phone = EXCLUDED.phone, alt_phone = EXCLUDED.alt_phone,
        division = EXCLUDED.division, district = EXCLUDED.district, thana = EXCLUDED.thana,
        address_line = EXCLUDED.address_line, note = COALESCE(EXCLUDED.note, c.note),
        added_by_hand = true, updated_by_username = EXCLUDED.updated_by_username, updated_at = now();

  PERFORM write_activity('customer.added', 'customer', v_new, trim(p_full_name),
    format('Added customer %s (%s)', trim(p_full_name), v_key), '{}'::jsonb);
  RETURN QUERY SELECT v_new, false;
END;
$function$;

CREATE OR REPLACE FUNCTION admin_delete_customer(p_customer_key text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row customers%ROWTYPE;
BEGIN
  IF NOT (is_admin() OR staff_can('manage_customers')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  SELECT * INTO v_row FROM customers WHERE customers.customer_key = p_customer_key FOR UPDATE;
  IF NOT FOUND OR NOT v_row.added_by_hand THEN
    RAISE EXCEPTION 'Only a customer added by hand can be deleted. Hide this customer instead.';
  END IF;
  IF EXISTS (SELECT 1 FROM order_customer_keys() k WHERE k.customer_key = p_customer_key)
     OR (v_row.phone_key IS NOT NULL AND EXISTS (SELECT 1 FROM orders o WHERE bd_phone_key(o.customer_phone) = v_row.phone_key))
     OR (v_row.phone_key IS NOT NULL AND EXISTS (
           SELECT 1 FROM profiles p WHERE p.role = 'customer' AND bd_phone_key(p.phone) = v_row.phone_key)) THEN
    RAISE EXCEPTION 'This customer has orders or an account. Hide them instead.';
  END IF;
  DELETE FROM customers WHERE customers.customer_key = p_customer_key;
  DELETE FROM customer_phones WHERE customer_phones.customer_key = p_customer_key;
  PERFORM write_activity('customer.deleted', 'customer', p_customer_key, v_row.full_name,
    format('Deleted customer %s (%s)', v_row.full_name, v_row.phone), '{}'::jsonb);
  RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION kaarbar_import_customers(p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_import  uuid;
  v_row     jsonb;
  v_name    text;
  v_pk      text;
  v_key     text;
  v_contact text;
  v_added   integer := 0;
  v_skipped integer := 0;
  v_n       integer;
BEGIN
  PERFORM kaarbar_require(true);
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'Tick at least one customer.';
  END IF;

  INSERT INTO kaarbar_imports (kind, created_by, created_by_username)
  VALUES ('customers', auth.uid(), current_actor_username())
  RETURNING id INTO v_import;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_name := btrim(COALESCE(v_row ->> 'name', ''));
    v_pk := NULLIF(btrim(COALESCE(v_row ->> 'phone_key', '')), '');
    v_contact := NULLIF(btrim(COALESCE(v_row ->> 'contact', '')), '');
    IF v_name = '' THEN
      RAISE EXCEPTION 'A customer has no name. Preview the file again.';
    END IF;
    IF v_pk IS NOT NULL AND v_pk !~ '^01[3-9][0-9]{8}$' THEN
      RAISE EXCEPTION 'The phone "%" is not a Bangladeshi mobile number. Preview the file again.', v_pk;
    END IF;
    v_key := CASE WHEN v_pk IS NOT NULL THEN 'ph:' || v_pk ELSE 'n:' || lower(v_name) END;

    IF (v_pk IS NOT NULL AND (
          EXISTS (SELECT 1 FROM profiles p WHERE p.role = 'customer' AND bd_phone_key(p.phone) = v_pk)
          OR EXISTS (SELECT 1 FROM orders o WHERE bd_phone_key(o.customer_phone) = v_pk)
          OR EXISTS (SELECT 1 FROM customers c WHERE c.phone_key = v_pk)
          OR EXISTS (SELECT 1 FROM customer_phones cp WHERE cp.phone_key = v_pk)))
       OR EXISTS (SELECT 1 FROM customers c WHERE c.customer_key = v_key)
       OR (v_pk IS NULL AND EXISTS (SELECT 1 FROM order_customer_keys() k WHERE k.customer_key = v_key)) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    INSERT INTO customers (customer_key, phone_key, full_name, phone, note, added_by_hand,
                           kaarbar_import_id, created_by, created_by_username, updated_by_username)
    VALUES (v_key, v_pk, v_name, COALESCE(v_pk, ''),
            CASE WHEN v_pk IS NOT NULL THEN 'From Kaarbar'
                 WHEN v_contact IS NOT NULL THEN 'From Kaarbar - no phone (Kaarbar contact: ' || v_contact || ')'
                 ELSE 'From Kaarbar - no phone' END,
            true, v_import, auth.uid(), current_actor_username(), current_actor_username())
    ON CONFLICT (customer_key) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
      v_added := v_added + 1;
    ELSE
      v_skipped := v_skipped + 1;
    END IF;
  END LOOP;

  UPDATE kaarbar_imports SET row_count = v_added WHERE id = v_import;
  PERFORM write_activity('kaarbar.customers_imported', 'kaarbar_import', v_import::text, 'Kaarbar customers',
    format('Imported %s customers from Kaarbar%s', v_added,
           CASE WHEN v_skipped > 0 THEN format(' (%s already on the site, skipped)', v_skipped) ELSE '' END),
    jsonb_build_object('added', v_added, 'skipped', v_skipped));
  RETURN jsonb_build_object('import_id', v_import, 'added', v_added, 'skipped', v_skipped);
END;
$function$;

CREATE OR REPLACE FUNCTION kaarbar_customer_old_bills(p_customer_key text, p_phone text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pk text := bd_phone_key(p_phone);
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'id', b.id, 'kind', b.kind, 'bill_no', b.bill_no, 'date', b.bill_date,
             'items_total', b.items_total, 'bill_discount', b.bill_discount, 'delivery', b.delivery,
             'bill_total', b.bill_total,
             'paid_amount', b.paid_amount, 'due_amount', b.due_amount, 'note', b.note,
             'merged_at', imp.created_at, 'from_merge', imp.kind = 'merge',
             'lines', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                                'name', l.kaarbar_name, 'quantity', l.quantity, 'unit', l.unit, 'rate', l.rate,
                                'line_discount', l.line_discount, 'line_total', l.line_total,
                                'item_id', l.item_id, 'name_key', i.name_key, 'match_how', i.match_how,
                                'product_id', i.product_id, 'variant_id', i.variant_id,
                                'product_name', p.name,
                                'option', NULLIF(concat_ws(' · ', NULLIF(btrim(v.region), ''), NULLIF(btrim(v.size), '')), ''))
                              ORDER BY l.line_no), '[]'::jsonb)
                       FROM kaarbar_bill_lines l
                       JOIN kaarbar_items i ON i.id = l.item_id
                       LEFT JOIN products p ON p.id = i.product_id
                       LEFT JOIN product_variants v ON v.id = i.variant_id
                       WHERE l.bill_id = b.id))
           ORDER BY b.bill_date DESC, b.bill_no DESC)
    FROM kaarbar_bills b
    LEFT JOIN kaarbar_imports imp ON imp.id = b.import_id
    WHERE (v_pk IS NOT NULL AND b.phone_key = v_pk)
       OR b.phone_key IN (SELECT cp.phone_key FROM customer_phones cp WHERE cp.customer_key = p_customer_key)
       OR (p_customer_key IS NOT NULL AND b.customer_key = p_customer_key)), '[]'::jsonb);
END;
$function$;

CREATE OR REPLACE FUNCTION money_lock_opening()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT money_any_month_locked() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  -- Batch 55: merging two customers only moves a row to the kept
  -- customer's number; the amount and date stay, so it is allowed.
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'phone_key') = (to_jsonb(OLD) - 'phone_key') THEN
    RETURN NEW;
  END IF;
  PERFORM money_lock_refuse(money_start_date(), 'the opening balances');
  RETURN COALESCE(NEW, OLD);
END;
$function$;

CREATE OR REPLACE FUNCTION money_lock_due_payments()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT money_any_month_locked() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  -- Batch 55: merging two customers only moves a row to the kept
  -- customer's number; the amount and date stay, so it is allowed.
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'phone_key') = (to_jsonb(OLD) - 'phone_key') THEN
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    PERFORM money_lock_refuse(OLD.paid_date, 'a payment of a previous balance');
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM money_lock_refuse(NEW.paid_date, 'a payment of a previous balance');
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

-- ---------------------------------------------------------------------
-- 4. A customer's numbers (customer page, Super Admin)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION admin_customer_numbers(p_customer_key text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key  text := NULLIF(btrim(COALESCE(p_customer_key, '')), '');
  v_main text;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Only the Super Admin can do this.';
  END IF;
  IF NOT customer_key_known(v_key) THEN
    RAISE EXCEPTION 'Open the customer again.';
  END IF;
  v_main := customer_main_phone_key(v_key);
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
             'phone', n.phone, 'phone_key', n.phone_key, 'is_main', n.is_main, 'source', n.source,
             'orders', u.orders, 'bills', u.bills, 'money_rows', u.money_rows,
             'can_remove', NOT n.is_main AND u.orders = 0 AND u.bills = 0 AND u.money_rows = 0)
           ORDER BY n.is_main DESC, n.created_at, n.phone_key)
    FROM (
      SELECT v_main AS phone_key, v_main AS phone, true AS is_main, NULL::text AS source, NULL::timestamptz AS created_at
      WHERE v_main IS NOT NULL
      UNION ALL
      SELECT cp.phone_key, cp.phone, false, cp.source, cp.created_at
      FROM customer_phones cp WHERE cp.customer_key = v_key AND cp.phone_key IS DISTINCT FROM v_main
    ) n
    CROSS JOIN LATERAL customer_number_use(n.phone_key) u), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION admin_add_customer_number(p_customer_key text, p_phone text, p_source text DEFAULT 'added')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key   text := NULLIF(btrim(COALESCE(p_customer_key, '')), '');
  v_pk    text := bd_phone_key(p_phone);
  v_src   text := COALESCE(NULLIF(btrim(p_source), ''), 'added');
  v_owner text;
  v_name  text;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Only the Super Admin can do this.';
  END IF;
  IF v_src NOT IN ('added', 'kaarbar') THEN
    RAISE EXCEPTION 'Open the customer again.';
  END IF;
  IF v_pk IS NULL OR v_pk !~ '^01[3-9][0-9]{8}$' THEN
    RAISE EXCEPTION 'Enter a valid Bangladeshi mobile number (01XXXXXXXXX).';
  END IF;
  IF NOT customer_key_known(v_key) THEN
    RAISE EXCEPTION 'Open the customer again.';
  END IF;
  -- One number change at a time (a number must never get two owners).
  PERFORM pg_advisory_xact_lock(hashtext('customer_phones'));

  IF v_pk = customer_main_phone_key(v_key)
     OR EXISTS (SELECT 1 FROM customer_phones cp WHERE cp.phone_key = v_pk AND cp.customer_key = v_key) THEN
    RETURN jsonb_build_object('added', false, 'same', true);
  END IF;
  v_owner := customer_phone_owner(v_pk);
  IF v_owner IS NOT NULL AND v_owner <> v_key THEN
    RETURN jsonb_build_object('added', false, 'same', false, 'owner_key', v_owner,
      'owner_name', customer_name_for_key(v_owner),
      'owner_orders', (SELECT count(*) FROM order_customer_keys() k JOIN orders o ON o.id = k.order_id
                       WHERE k.customer_key = v_owner AND o.status <> 'cancelled'));
  END IF;

  INSERT INTO customer_phones (phone_key, customer_key, phone, source, created_by, created_by_username)
  VALUES (v_pk, v_key, v_pk, v_src, auth.uid(), current_actor_username());
  v_name := customer_name_for_key(v_key);
  PERFORM write_activity('customer.number_added', 'customer', v_key, v_name,
    format('Added %s to %s', v_pk, v_name), jsonb_build_object('phone_key', v_pk, 'source', v_src));
  RETURN jsonb_build_object('added', true);
END;
$$;

CREATE OR REPLACE FUNCTION admin_remove_customer_number(p_customer_key text, p_phone text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key  text := NULLIF(btrim(COALESCE(p_customer_key, '')), '');
  v_pk   text := bd_phone_key(p_phone);
  v_use  record;
  v_name text;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Only the Super Admin can do this.';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('customer_phones'));
  IF v_pk IS NULL OR NOT EXISTS (SELECT 1 FROM customer_phones cp WHERE cp.phone_key = v_pk AND cp.customer_key = v_key) THEN
    RAISE EXCEPTION 'This number is not an extra number of this customer.';
  END IF;
  SELECT * INTO v_use FROM customer_number_use(v_pk);
  IF v_use.orders > 0 OR v_use.bills > 0 OR v_use.money_rows > 0 THEN
    RAISE EXCEPTION 'Orders, dues or Kaarbar bills use this number, so it can''t be removed.';
  END IF;
  DELETE FROM customer_phones WHERE phone_key = v_pk;
  v_name := customer_name_for_key(v_key);
  PERFORM write_activity('customer.number_removed', 'customer', v_key, v_name,
    format('Removed %s from %s', v_pk, v_name), jsonb_build_object('phone_key', v_pk));
  RETURN jsonb_build_object('removed', true);
END;
$$;

-- ---------------------------------------------------------------------
-- 5. Merge two customers (Super Admin). The kept customer stays; the
--    removed one's numbers, money rows and old bills move to it.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION admin_merge_preview(p_keep_key text, p_remove_key text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_keep   text := NULLIF(btrim(COALESCE(p_keep_key, '')), '');
  v_rem    text := NULLIF(btrim(COALESCE(p_remove_key, '')), '');
  v_reason text;
  v_k      jsonb;
  v_r      jsonb;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Only the Super Admin can do this.';
  END IF;
  v_reason := customer_merge_refusal(v_keep, v_rem);
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION '%', v_reason;
  END IF;
  v_k := customer_merge_side(v_keep);
  v_r := customer_merge_side(v_rem);
  RETURN jsonb_build_object(
    'keep', v_k,
    'remove', v_r,
    'after', jsonb_build_object(
      'orders', (v_k ->> 'orders')::integer + (v_r ->> 'orders')::integer,
      'due', (v_k ->> 'due')::numeric + (v_r ->> 'due')::numeric + (v_k ->> 'previous')::numeric + (v_r ->> 'previous')::numeric),
    'kept_name', customer_name_for_key(v_keep),
    'removed_name', customer_name_for_key(v_rem),
    'removed_phone', customer_main_phone_key(v_rem));
END;
$$;

CREATE OR REPLACE FUNCTION admin_merge_customers(p_keep_key text, p_remove_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_keep      text := NULLIF(btrim(COALESCE(p_keep_key, '')), '');
  v_rem       text := NULLIF(btrim(COALESCE(p_remove_key, '')), '');
  v_reason    text;
  v_keep_pk   text;
  v_rem_pk    text;
  v_keep_name text;
  v_rem_name  text;
  v_nums      text[];
  v_moved     jsonb := '[]'::jsonb;
  v_part      jsonb;
  v_before    jsonb;
  v_dues0     numeric;
  v_row       customers%ROWTYPE;
  v_note      text;
  v_old_note  text;
  v_id        uuid;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Only the Super Admin can do this.';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('customer_phones'));
  v_reason := customer_merge_refusal(v_keep, v_rem);
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION '%', v_reason;
  END IF;

  v_keep_pk := customer_main_phone_key(v_keep);
  v_rem_pk := customer_main_phone_key(v_rem);
  v_keep_name := customer_name_for_key(v_keep);
  v_rem_name := customer_name_for_key(v_rem);
  v_nums := ARRAY[v_rem_pk] || COALESCE(ARRAY(
    SELECT cp.phone_key FROM customer_phones cp WHERE cp.customer_key = v_rem AND cp.phone_key <> v_rem_pk ORDER BY cp.created_at), '{}'::text[]);
  v_before := customer_money_totals();
  SELECT COALESCE(sum(d.order_due + d.previous_left), 0) INTO v_dues0 FROM money_customer_dues() d;

  -- 1. Every number of the removed customer becomes an extra number of
  --    the kept one.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('table', 'customer_phones', 'id', cp.phone_key,
           'old', jsonb_build_object('customer_key', cp.customer_key, 'source', cp.source))), '[]'::jsonb)
  INTO v_part FROM customer_phones cp WHERE cp.phone_key = ANY (v_nums);
  v_moved := v_moved || v_part;
  UPDATE customer_phones SET customer_key = v_keep, source = 'merge' WHERE phone_key = ANY (v_nums);
  IF NOT EXISTS (SELECT 1 FROM customer_phones WHERE phone_key = v_rem_pk) THEN
    INSERT INTO customer_phones (phone_key, customer_key, phone, source, created_by, created_by_username)
    VALUES (v_rem_pk, v_keep, v_rem_pk, 'merge', auth.uid(), current_actor_username());
    v_moved := v_moved || jsonb_build_array(jsonb_build_object('table', 'customer_phones', 'id', v_rem_pk, 'old', NULL));
  END IF;

  -- 2. Money rows and old bills: only who they belong to changes.
  WITH old AS (SELECT t.id, t.phone_key FROM customer_opening_dues t WHERE t.phone_key = ANY (v_nums)),
  upd AS (UPDATE customer_opening_dues t SET phone_key = v_keep_pk FROM old WHERE t.id = old.id RETURNING old.id, old.phone_key)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('table', 'customer_opening_dues', 'id', upd.id,
           'old', jsonb_build_object('phone_key', upd.phone_key))), '[]'::jsonb) INTO v_part FROM upd;
  v_moved := v_moved || v_part;

  WITH old AS (SELECT t.id, t.phone_key FROM customer_due_payments t WHERE t.phone_key = ANY (v_nums)),
  upd AS (UPDATE customer_due_payments t SET phone_key = v_keep_pk FROM old WHERE t.id = old.id RETURNING old.id, old.phone_key)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('table', 'customer_due_payments', 'id', upd.id,
           'old', jsonb_build_object('phone_key', upd.phone_key))), '[]'::jsonb) INTO v_part FROM upd;
  v_moved := v_moved || v_part;

  WITH old AS (SELECT t.id, t.phone_key FROM customer_previous_corrections t WHERE t.phone_key = ANY (v_nums)),
  upd AS (UPDATE customer_previous_corrections t SET phone_key = v_keep_pk FROM old WHERE t.id = old.id RETURNING old.id, old.phone_key)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('table', 'customer_previous_corrections', 'id', upd.id,
           'old', jsonb_build_object('phone_key', upd.phone_key))), '[]'::jsonb) INTO v_part FROM upd;
  v_moved := v_moved || v_part;

  WITH old AS (SELECT t.id, t.customer_key, t.phone_key FROM customer_due_reminders t
               WHERE t.customer_key = v_rem OR t.phone_key = ANY (v_nums)),
  upd AS (UPDATE customer_due_reminders t
          SET customer_key = v_keep, phone_key = CASE WHEN old.phone_key IS NULL THEN NULL ELSE v_keep_pk END
          FROM old WHERE t.id = old.id RETURNING old.id, old.customer_key, old.phone_key)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('table', 'customer_due_reminders', 'id', upd.id,
           'old', jsonb_build_object('customer_key', upd.customer_key, 'phone_key', upd.phone_key))), '[]'::jsonb) INTO v_part FROM upd;
  v_moved := v_moved || v_part;

  WITH old AS (SELECT t.id, t.customer_key, t.phone_key FROM kaarbar_bills t
               WHERE t.customer_key = v_rem OR t.phone_key = ANY (v_nums)),
  upd AS (UPDATE kaarbar_bills t
          SET customer_key = v_keep, phone_key = CASE WHEN old.phone_key IS NULL THEN NULL ELSE v_keep_pk END
          FROM old WHERE t.id = old.id RETURNING old.id, old.customer_key, old.phone_key)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('table', 'kaarbar_bills', 'id', upd.id,
           'old', jsonb_build_object('customer_key', upd.customer_key, 'phone_key', upd.phone_key))), '[]'::jsonb) INTO v_part FROM upd;
  v_moved := v_moved || v_part;

  -- Batch 54's "Undo this merge" finds a customer's merges by key.
  WITH old AS (SELECT t.id, t.customer_key FROM kaarbar_imports t WHERE t.customer_key = v_rem),
  upd AS (UPDATE kaarbar_imports t SET customer_key = v_keep FROM old WHERE t.id = old.id RETURNING old.id, old.customer_key)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('table', 'kaarbar_imports', 'id', upd.id,
           'old', jsonb_build_object('customer_key', upd.customer_key))), '[]'::jsonb) INTO v_part FROM upd;
  v_moved := v_moved || v_part;

  -- 3. The removed customer's own row goes; its note is added to the end
  --    of the kept customer's note.
  SELECT * INTO v_row FROM customers WHERE customer_key = v_rem FOR UPDATE;
  IF FOUND THEN
    v_note := NULLIF(btrim(COALESCE(v_row.note, '')), '');
    DELETE FROM customers WHERE customer_key = v_rem;
    v_moved := v_moved || jsonb_build_array(jsonb_build_object('table', 'customers', 'id', v_rem, 'old', to_jsonb(v_row)));
  END IF;
  IF v_note IS NOT NULL THEN
    v_note := format('From %s (%s):', v_rem_name, v_rem_pk) || E'\n' || v_note;
    IF v_keep LIKE 'p:%' THEN
      SELECT n.note INTO v_old_note FROM customer_notes n WHERE n.customer_id::text = substr(v_keep, 3) FOR UPDATE;
      IF FOUND THEN
        UPDATE customer_notes
        SET note = left(CASE WHEN btrim(v_old_note) = '' THEN v_note ELSE v_old_note || E'\n\n' || v_note END, 2000),
            updated_at = now(), updated_by = current_actor_username()
        WHERE customer_id::text = substr(v_keep, 3);
      ELSE
        INSERT INTO customer_notes (customer_id, note, tags, updated_at, updated_by)
        VALUES (substr(v_keep, 3)::uuid, left(v_note, 2000), '{}'::text[], now(), current_actor_username());
      END IF;
      v_moved := v_moved || jsonb_build_array(jsonb_build_object('table', 'customer_notes', 'id', substr(v_keep, 3),
                   'old', CASE WHEN v_old_note IS NULL THEN NULL ELSE jsonb_build_object('note', v_old_note) END));
    ELSE
      SELECT c.note INTO v_old_note FROM customers c WHERE c.customer_key = v_keep FOR UPDATE;
      IF FOUND THEN
        UPDATE customers
        SET note = CASE WHEN btrim(COALESCE(v_old_note, '')) = '' THEN v_note ELSE v_old_note || E'\n\n' || v_note END,
            updated_by_username = current_actor_username(), updated_at = now()
        WHERE customer_key = v_keep;
        v_moved := v_moved || jsonb_build_array(jsonb_build_object('table', 'customers', 'id', v_keep,
                     'old', jsonb_build_object('note', v_old_note)));
      ELSE
        INSERT INTO customers (customer_key, phone_key, note, created_by, created_by_username, updated_by_username)
        VALUES (v_keep, v_keep_pk, v_note, auth.uid(), current_actor_username(), current_actor_username());
        v_moved := v_moved || jsonb_build_array(jsonb_build_object('table', 'customers', 'id', v_keep, 'old', NULL));
      END IF;
    END IF;
  END IF;

  -- 4. Orders are not edited: they group under the kept customer through
  --    the numbers of step 1.

  -- The money must not change.
  IF customer_money_totals() IS DISTINCT FROM v_before
     OR (SELECT COALESCE(sum(d.order_due + d.previous_left), 0) FROM money_customer_dues() d) IS DISTINCT FROM v_dues0 THEN
    RAISE EXCEPTION 'The money totals would change, so nothing was merged.';
  END IF;

  -- 5. The log.
  INSERT INTO customer_merges (kind, kept_key, removed_key, moved, created_by, created_by_username)
  VALUES ('merge', v_keep, v_rem, v_moved, auth.uid(), current_actor_username())
  RETURNING id INTO v_id;
  PERFORM write_activity('customer.merged', 'customer', v_keep, v_keep_name,
    format('Merged %s (%s) into %s', v_rem_name, v_rem_pk, v_keep_name),
    jsonb_build_object('merge_id', v_id, 'removed_key', v_rem, 'rows', jsonb_array_length(v_moved)));
  RETURN jsonb_build_object('merge_id', v_id, 'kept_name', v_keep_name, 'removed_name', v_rem_name,
                            'moved', jsonb_array_length(v_moved));
END;
$$;

REVOKE ALL ON FUNCTION admin_customer_numbers(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION admin_add_customer_number(text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION admin_remove_customer_number(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION admin_merge_preview(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION admin_merge_customers(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_customer_numbers(text) TO authenticated;
GRANT EXECUTE ON FUNCTION admin_add_customer_number(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION admin_remove_customer_number(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION admin_merge_preview(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION admin_merge_customers(text, text) TO authenticated;

COMMIT;

-- What happened.
SELECT
  to_regclass('public.customer_phones') IS NOT NULL AS customer_phones_ready,
  to_regclass('public.customer_merges') IS NOT NULL AS customer_merges_ready,
  (SELECT count(*) FROM customer_phones) AS extra_numbers,
  (SELECT count(*) FROM customer_merges) AS merges_so_far,
  (SELECT count(DISTINCT customer_key) FROM order_customer_keys()) AS customers_with_orders;
