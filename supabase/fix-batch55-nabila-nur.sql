-- =====================================================================
-- Batch 55 — one-time fix: Nabila Nur's orders off the wrong login
--
-- Run ONCE, after supabase/migration-056-batch55.sql, in the Supabase
-- SQL Editor (paste the whole file and press Run).
--
-- Naeem once made a normal customer login with one of his own Gmails and
-- ordered for Nabila Nur with it. This moves everything of hers to a
-- customer record with no login ("ph:<her number>"), and empties that
-- login (its name, phone and saved address are cleared; it is NOT
-- deleted; its wishlist and cart stay).
--
-- Safe: it stops and changes nothing if the login is not exactly the one
-- found on 21 Nov 2026, and it checks that every money total is the same
-- afterwards (otherwise everything is undone). Running it a second time
-- stops with "already done".
-- =====================================================================

BEGIN;

DO $fix$
DECLARE
  -- The login found on 21 Nov 2026 (role customer, name "Nabila Nur").
  c_profile constant uuid := 'f05af719-446e-4d9b-82ff-8d6626e803fe';
  v_prof    profiles%ROWTYPE;
  v_email   text;
  v_pkey    text := 'p:' || c_profile::text;
  v_pk      text;
  v_key     text;
  v_last    orders%ROWTYPE;
  v_div     text;
  v_dist    text;
  v_thana   text;
  v_addr    text;
  v_note    text;
  v_old     customers%ROWTYPE;
  v_before  jsonb;
  v_after   jsonb;
  v_moved   jsonb := '[]'::jsonb;
  v_part    jsonb;
  v_id      uuid;
BEGIN
  IF to_regclass('public.customer_merges') IS NULL THEN
    RAISE EXCEPTION 'Run supabase/migration-056-batch55.sql first. Nothing was changed.';
  END IF;

  -- 1. Stop if this is not the same login any more.
  SELECT * INTO v_prof FROM profiles WHERE id = c_profile FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stopped: that login no longer exists. Nothing was changed.';
  END IF;
  IF v_prof.role <> 'customer' THEN
    RAISE EXCEPTION 'Stopped: that login is not a customer login. Nothing was changed.';
  END IF;
  IF lower(regexp_replace(btrim(COALESCE(v_prof.full_name, '')), '\s+', ' ', 'g')) <> 'nabila nur' THEN
    IF EXISTS (SELECT 1 FROM customer_merges WHERE kind = 'one_time_fix' AND removed_key = v_pkey) THEN
      RAISE EXCEPTION 'Already done: this fix was run before. Nothing was changed.';
    END IF;
    RAISE EXCEPTION 'Stopped: that login''s name is not Nabila Nur any more. Nothing was changed.';
  END IF;
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = c_profile;

  -- 2. The totals before.
  v_before := customer_money_totals();

  -- Her number: the login's, else her latest order's.
  SELECT * INTO v_last FROM orders WHERE customer_id = c_profile OR admin_customer_id = c_profile
  ORDER BY created_at DESC LIMIT 1;
  v_pk := COALESCE(bd_phone_key(v_prof.phone), bd_phone_key(v_last.customer_phone));
  IF v_pk IS NULL OR v_pk !~ '^01[3-9][0-9]{8}$' THEN
    RAISE EXCEPTION 'Stopped: Nabila Nur has no mobile number on the login or her orders. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM profiles p WHERE p.role = 'customer' AND p.id <> c_profile AND bd_phone_key(p.phone) = v_pk) THEN
    RAISE EXCEPTION 'Stopped: another login uses her number %. Nothing was changed.', v_pk;
  END IF;
  IF EXISTS (SELECT 1 FROM customer_phones cp WHERE cp.phone_key = v_pk AND cp.customer_key <> v_pkey) THEN
    RAISE EXCEPTION 'Stopped: her number % is another customer''s extra number. Nothing was changed.', v_pk;
  END IF;
  v_key := 'ph:' || v_pk;

  -- Her address: the login's saved one, else her latest order's.
  IF btrim(COALESCE(v_prof.address_line, '')) <> '' THEN
    v_div := COALESCE(v_prof.division, ''); v_dist := COALESCE(v_prof.district, '');
    v_thana := COALESCE(v_prof.thana, ''); v_addr := btrim(v_prof.address_line);
  ELSE
    v_div := COALESCE(v_last.division, ''); v_dist := COALESCE(v_last.district, '');
    v_thana := COALESCE(v_last.thana, ''); v_addr := btrim(COALESCE(v_last.address_line, ''));
  END IF;
  -- Her private note (the login's note, and a note on a flag row if any).
  SELECT NULLIF(concat_ws(E'\n\n',
           (SELECT NULLIF(btrim(n.note), '') FROM customer_notes n WHERE n.customer_id = c_profile),
           (SELECT NULLIF(btrim(c.note), '') FROM customers c WHERE c.customer_key = v_pkey)), '')
  INTO v_note;

  -- 3. The customer record with no login, with her name, number, address, note.
  SELECT * INTO v_old FROM customers WHERE customer_key = v_key FOR UPDATE;
  IF FOUND THEN
    v_moved := v_moved || jsonb_build_array(jsonb_build_object('table', 'customers', 'id', v_key, 'old', to_jsonb(v_old)));
    UPDATE customers
    SET phone_key = v_pk, full_name = btrim(v_prof.full_name), phone = v_pk,
        division = v_div, district = v_dist, thana = v_thana, address_line = v_addr,
        note = NULLIF(concat_ws(E'\n\n', NULLIF(btrim(COALESCE(v_old.note, '')), ''), v_note), ''),
        updated_by_username = current_actor_username(), updated_at = now()
    WHERE customer_key = v_key;
  ELSE
    INSERT INTO customers (customer_key, phone_key, full_name, phone, division, district, thana, address_line, note,
                           added_by_hand, created_by, created_by_username, updated_by_username)
    VALUES (v_key, v_pk, btrim(v_prof.full_name), v_pk, v_div, v_dist, v_thana, v_addr, v_note,
            false, auth.uid(), current_actor_username(), current_actor_username());
    v_moved := v_moved || jsonb_build_array(jsonb_build_object('table', 'customers', 'id', v_key, 'old', NULL));
  END IF;

  -- 4. Her orders: no login any more (contents, delivery name and phone stay).
  WITH old AS (SELECT o.id, o.customer_id, o.admin_customer_id FROM orders o
               WHERE o.customer_id = c_profile OR o.admin_customer_id = c_profile),
  upd AS (UPDATE orders o SET customer_id = NULL, admin_customer_id = NULL FROM old WHERE o.id = old.id
          RETURNING old.id, old.customer_id, old.admin_customer_id)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('table', 'orders', 'id', upd.id,
           'old', jsonb_build_object('customer_id', upd.customer_id, 'admin_customer_id', upd.admin_customer_id))), '[]'::jsonb)
  INTO v_part FROM upd;
  v_moved := v_moved || v_part;

  -- 5. Reminders, old Kaarbar bills, Kaarbar merges and extra numbers of
  --    the login move to her record; the login's note row goes (its text
  --    is in step 3), and so does a flag row of the login, if any.
  WITH old AS (SELECT t.id, t.customer_key FROM customer_due_reminders t WHERE t.customer_key = v_pkey),
  upd AS (UPDATE customer_due_reminders t SET customer_key = v_key FROM old WHERE t.id = old.id RETURNING old.id, old.customer_key)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('table', 'customer_due_reminders', 'id', upd.id,
           'old', jsonb_build_object('customer_key', upd.customer_key))), '[]'::jsonb) INTO v_part FROM upd;
  v_moved := v_moved || v_part;

  WITH old AS (SELECT t.id, t.customer_key FROM kaarbar_bills t WHERE t.customer_key = v_pkey),
  upd AS (UPDATE kaarbar_bills t SET customer_key = v_key FROM old WHERE t.id = old.id RETURNING old.id, old.customer_key)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('table', 'kaarbar_bills', 'id', upd.id,
           'old', jsonb_build_object('customer_key', upd.customer_key))), '[]'::jsonb) INTO v_part FROM upd;
  v_moved := v_moved || v_part;

  WITH old AS (SELECT t.id, t.customer_key FROM kaarbar_imports t WHERE t.customer_key = v_pkey),
  upd AS (UPDATE kaarbar_imports t SET customer_key = v_key FROM old WHERE t.id = old.id RETURNING old.id, old.customer_key)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('table', 'kaarbar_imports', 'id', upd.id,
           'old', jsonb_build_object('customer_key', upd.customer_key))), '[]'::jsonb) INTO v_part FROM upd;
  v_moved := v_moved || v_part;

  WITH old AS (SELECT t.phone_key, t.customer_key FROM customer_phones t WHERE t.customer_key = v_pkey AND t.phone_key <> v_pk),
  upd AS (UPDATE customer_phones t SET customer_key = v_key FROM old WHERE t.phone_key = old.phone_key RETURNING old.phone_key, old.customer_key)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('table', 'customer_phones', 'id', upd.phone_key,
           'old', jsonb_build_object('customer_key', upd.customer_key))), '[]'::jsonb) INTO v_part FROM upd;
  v_moved := v_moved || v_part;
  -- Her own number is her record's main number now, not an extra one.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('table', 'customer_phones', 'id', t.phone_key, 'old', to_jsonb(t))), '[]'::jsonb)
  INTO v_part FROM customer_phones t WHERE t.phone_key = v_pk;
  v_moved := v_moved || v_part;
  DELETE FROM customer_phones WHERE phone_key = v_pk;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('table', 'customer_notes', 'id', n.customer_id, 'old', to_jsonb(n))), '[]'::jsonb)
  INTO v_part FROM customer_notes n WHERE n.customer_id = c_profile;
  v_moved := v_moved || v_part;
  DELETE FROM customer_notes WHERE customer_id = c_profile;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('table', 'customers', 'id', c.customer_key, 'old', to_jsonb(c))), '[]'::jsonb)
  INTO v_part FROM customers c WHERE c.customer_key = v_pkey;
  v_moved := v_moved || v_part;
  DELETE FROM customers WHERE customer_key = v_pkey;

  -- 6. Empty the login (not deleted; wishlist and cart stay).
  v_moved := v_moved || jsonb_build_array(jsonb_build_object('table', 'profiles', 'id', c_profile,
    'old', jsonb_build_object('full_name', v_prof.full_name, 'phone', v_prof.phone, 'division', v_prof.division,
                              'district', v_prof.district, 'thana', v_prof.thana, 'address_line', v_prof.address_line)));
  UPDATE profiles SET full_name = NULL, phone = NULL, division = NULL, district = NULL, thana = NULL, address_line = NULL
  WHERE id = c_profile;

  -- 7. Every money total must be exactly the same.
  v_after := customer_money_totals();
  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'Stopped: the money totals would change (before %, after %). Nothing was changed.', v_before, v_after;
  END IF;

  -- 8. The log.
  INSERT INTO customer_merges (kind, kept_key, removed_key, moved, created_by, created_by_username)
  VALUES ('one_time_fix', v_key, v_pkey, v_moved, auth.uid(), current_actor_username())
  RETURNING id INTO v_id;
  PERFORM write_activity('customer.login_fixed', 'customer', v_key, 'Nabila Nur',
    format('Moved Nabila Nur''s orders off the login %s', COALESCE(v_email, c_profile::text)),
    jsonb_build_object('merge_id', v_id, 'login', c_profile, 'rows', jsonb_array_length(v_moved)));
END
$fix$;

-- 9. What happened: her record now, and the login (must show 0 orders).
SELECT
  c.customer_key AS her_customer_key,
  (SELECT count(*) FROM order_customer_keys() k WHERE k.customer_key = c.customer_key) AS her_orders,
  (SELECT COALESCE(sum(k.due), 0) FROM order_customer_keys() k WHERE k.customer_key = c.customer_key) AS her_due_on_orders,
  (SELECT count(*) FROM orders o WHERE o.customer_id = 'f05af719-446e-4d9b-82ff-8d6626e803fe'
                                     OR o.admin_customer_id = 'f05af719-446e-4d9b-82ff-8d6626e803fe') AS login_orders_now
FROM customer_merges m
JOIN customers c ON c.customer_key = m.kept_key
WHERE m.kind = 'one_time_fix' AND m.removed_key = 'p:f05af719-446e-4d9b-82ff-8d6626e803fe'
ORDER BY m.created_at DESC
LIMIT 1;

COMMIT;
