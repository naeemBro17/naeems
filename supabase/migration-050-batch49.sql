-- =====================================================================
-- Batch 49 — Import customers and expenses from Kaarbar
--
-- Paste the whole file into the Supabase SQL Editor and press Run.
-- It is safe to run more than once. It does not change any existing
-- customer, order, payment, due, stock, lot or money amount.
--
--   1. kaarbar_imports: one row per import (customers or expenses), so
--      "Undo last import" removes exactly what that import added.
--   2. customers.kaarbar_import_id — which import added this customer.
--   3. money_movements.kaarbar_import_id and kaarbar_bill_no — which
--      import added this expense, and Kaarbar's own Bill No (one Bill No
--      is only ever imported once, so a newer Expense Report brings in
--      only the new rows).
--   4. Functions, all Super Admin only (is_admin(), checked here in the
--      database), and the import / undo ones also need the password typed
--      in the last 5 minutes (the same rule as locking a month):
--        kaarbar_status            what the screen needs to classify rows
--        kaarbar_customers_check   who is already on the site + their due
--        kaarbar_import_customers  adds admin customers (no login, no message)
--        kaarbar_undo_customers
--        kaarbar_import_expenses   adds expenses / profit share
--        kaarbar_undo_expenses
--
-- Nothing here sends any message: the only Telegram trigger in the
-- database is on orders, and these functions never touch orders.
-- Expenses dated before the Money start date are stored as history; the
-- money ledger already ignores entries before the start date, so they do
-- not change any account balance.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. kaarbar_imports
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kaarbar_imports (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                text NOT NULL CHECK (kind IN ('customers', 'expenses')),
  row_count           integer NOT NULL DEFAULT 0,
  total_amount        numeric NOT NULL DEFAULT 0,
  created_categories  uuid[] NOT NULL DEFAULT '{}',
  created_by          uuid,
  created_by_username text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  undone_at           timestamptz,
  undone_by_username  text,
  undo_kept           jsonb
);

ALTER TABLE kaarbar_imports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON kaarbar_imports FROM anon, authenticated;
GRANT ALL ON kaarbar_imports TO service_role;

-- ---------------------------------------------------------------------
-- 2 + 3. Marks on the imported rows
-- ---------------------------------------------------------------------
ALTER TABLE customers ADD COLUMN IF NOT EXISTS kaarbar_import_id uuid
  REFERENCES kaarbar_imports(id) ON DELETE SET NULL;
ALTER TABLE money_movements ADD COLUMN IF NOT EXISTS kaarbar_import_id uuid
  REFERENCES kaarbar_imports(id) ON DELETE SET NULL;
ALTER TABLE money_movements ADD COLUMN IF NOT EXISTS kaarbar_bill_no text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_money_movements_kaarbar_bill
  ON money_movements (kaarbar_bill_no) WHERE kaarbar_bill_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_money_movements_kaarbar_import
  ON money_movements (kaarbar_import_id) WHERE kaarbar_import_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_kaarbar_import
  ON customers (kaarbar_import_id) WHERE kaarbar_import_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 4. Functions
-- ---------------------------------------------------------------------

-- Super Admin, and (for import / undo) the password typed again.
CREATE OR REPLACE FUNCTION kaarbar_require(p_password boolean)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Only the Super Admin can import from Kaarbar.';
  END IF;
  IF p_password AND NOT money_password_recent() THEN
    RAISE EXCEPTION 'Type your password again to confirm.';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION kaarbar_require(boolean) FROM PUBLIC, anon, authenticated;

-- One category name for matching: lower case, single spaces.
CREATE OR REPLACE FUNCTION kaarbar_name_key(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT lower(regexp_replace(btrim(COALESCE(p_name, '')), '\s+', ' ', 'g'));
$$;

CREATE OR REPLACE FUNCTION kaarbar_last_import(p_kind text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object('id', i.id, 'at', i.created_at, 'by', i.created_by_username,
                            'count', i.row_count, 'total', i.total_amount)
  FROM kaarbar_imports i
  WHERE i.kind = p_kind AND i.undone_at IS NULL
  ORDER BY i.created_at DESC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION kaarbar_last_import(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION kaarbar_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM kaarbar_require(false);
  RETURN jsonb_build_object(
    'start_date', money_start_date(),
    'today', inventory_dhaka_today(),
    'locked_months', COALESCE((SELECT jsonb_agg(to_char(month, 'YYYY-MM') ORDER BY month)
                               FROM money_month_locks WHERE locked), '[]'::jsonb),
    'bill_nos', COALESCE((SELECT jsonb_agg(kaarbar_bill_no) FROM money_movements
                          WHERE kaarbar_bill_no IS NOT NULL), '[]'::jsonb),
    'last_customers', kaarbar_last_import('customers'),
    'last_expenses', kaarbar_last_import('expenses'));
END;
$$;

REVOKE ALL ON FUNCTION kaarbar_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION kaarbar_status() TO authenticated;

-- p_rows: [{n, phone_key, name}]. For each row: the customer already on
-- the site with that phone (or, with no phone, that name) and what the
-- site says they owe today (orders still due + previous balance left).
CREATE OR REPLACE FUNCTION kaarbar_customers_check(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_out jsonb;
BEGIN
  PERFORM kaarbar_require(false);
  WITH r AS (
    SELECT (e ->> 'n')::integer AS n,
           NULLIF(btrim(COALESCE(e ->> 'phone_key', '')), '') AS pk,
           lower(btrim(COALESCE(e ->> 'name', ''))) AS nm
    FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) e
  ), keys AS (
    SELECT k.customer_key, k.due, bd_phone_key(o.customer_phone) AS pk, o.customer_name, o.created_at
    FROM order_customer_keys() k JOIN orders o ON o.id = k.order_id
  ), dues AS (
    SELECT d.phone_key, sum(d.order_due + d.previous_left) AS amount
    FROM money_customer_dues() d WHERE d.phone_key IS NOT NULL GROUP BY d.phone_key
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'n', r.n,
           'site_key', m.key,
           'site_name', m.name,
           'site_due', CASE WHEN r.pk IS NOT NULL THEN COALESCE(d.amount, 0)
                            ELSE COALESCE((SELECT sum(k.due) FROM keys k WHERE k.customer_key = 'n:' || r.nm), 0) END)
         ORDER BY r.n), '[]'::jsonb)
  INTO v_out
  FROM r
  LEFT JOIN dues d ON d.phone_key = r.pk
  LEFT JOIN LATERAL (
    SELECT x.key, x.name FROM (
      SELECT 1 AS ord, 'p:' || p.id AS key, p.full_name AS name, p.created_at AS ts
      FROM profiles p WHERE r.pk IS NOT NULL AND p.role = 'customer' AND bd_phone_key(p.phone) = r.pk
      UNION ALL
      SELECT 2, k.customer_key, k.customer_name, k.created_at FROM keys k WHERE r.pk IS NOT NULL AND k.pk = r.pk
      UNION ALL
      SELECT 3, c.customer_key, c.full_name, c.created_at FROM customers c WHERE r.pk IS NOT NULL AND c.phone_key = r.pk
      UNION ALL
      SELECT 4, c.customer_key, c.full_name, c.created_at FROM customers c WHERE r.pk IS NULL AND c.customer_key = 'n:' || r.nm
      UNION ALL
      SELECT 5, k.customer_key, k.customer_name, k.created_at FROM keys k WHERE r.pk IS NULL AND k.customer_key = 'n:' || r.nm
    ) x ORDER BY x.ord, x.ts LIMIT 1
  ) m ON true;
  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION kaarbar_customers_check(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION kaarbar_customers_check(jsonb) TO authenticated;

-- p_rows: [{name, phone_key (or null), contact}]. Adds admin customers
-- (no login account, no email, no password, no message). A customer
-- already on the site is never changed: that row is skipped.
CREATE OR REPLACE FUNCTION kaarbar_import_customers(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
          OR EXISTS (SELECT 1 FROM customers c WHERE c.phone_key = v_pk)))
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
$$;

REVOKE ALL ON FUNCTION kaarbar_import_customers(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION kaarbar_import_customers(jsonb) TO authenticated;

-- Removes the customers the last customer import added — except anyone
-- who since has an order, a payment, a due or a login account.
CREATE OR REPLACE FUNCTION kaarbar_undo_customers()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_import  uuid;
  v_c       customers%ROWTYPE;
  v_reason  text;
  v_kept    jsonb := '[]'::jsonb;
  v_removed integer := 0;
BEGIN
  PERFORM kaarbar_require(true);
  SELECT id INTO v_import FROM kaarbar_imports
  WHERE kind = 'customers' AND undone_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF v_import IS NULL THEN
    RAISE EXCEPTION 'There is no customer import to undo.';
  END IF;

  FOR v_c IN SELECT * FROM customers WHERE kaarbar_import_id = v_import FOR UPDATE LOOP
    v_reason := CASE
      WHEN EXISTS (SELECT 1 FROM order_customer_keys() k WHERE k.customer_key = v_c.customer_key)
        OR (v_c.phone_key IS NOT NULL AND EXISTS (SELECT 1 FROM orders o WHERE bd_phone_key(o.customer_phone) = v_c.phone_key))
        THEN 'has an order'
      WHEN v_c.phone_key IS NOT NULL AND EXISTS (SELECT 1 FROM customer_due_payments x WHERE x.phone_key = v_c.phone_key)
        THEN 'has a payment'
      WHEN v_c.phone_key IS NOT NULL AND EXISTS (SELECT 1 FROM customer_opening_dues x WHERE x.phone_key = v_c.phone_key)
        THEN 'has a due'
      WHEN v_c.phone_key IS NOT NULL AND EXISTS (
             SELECT 1 FROM profiles p WHERE p.role = 'customer' AND bd_phone_key(p.phone) = v_c.phone_key)
        THEN 'has a login account'
    END;
    IF v_reason IS NULL THEN
      DELETE FROM customers WHERE customer_key = v_c.customer_key;
      v_removed := v_removed + 1;
    ELSE
      v_kept := v_kept || jsonb_build_object('name', v_c.full_name, 'phone', v_c.phone, 'reason', v_reason);
    END IF;
  END LOOP;

  UPDATE kaarbar_imports SET undone_at = now(), undone_by_username = current_actor_username(), undo_kept = v_kept
  WHERE id = v_import;
  PERFORM write_activity('kaarbar.customers_undone', 'kaarbar_import', v_import::text, 'Kaarbar customers',
    format('Undid the Kaarbar customer import: removed %s customers%s', v_removed,
           CASE WHEN jsonb_array_length(v_kept) > 0 THEN format(', kept %s', jsonb_array_length(v_kept)) ELSE '' END),
    jsonb_build_object('removed', v_removed, 'kept', v_kept));
  RETURN jsonb_build_object('removed', v_removed, 'kept', v_kept);
END;
$$;

REVOKE ALL ON FUNCTION kaarbar_undo_customers() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION kaarbar_undo_customers() TO authenticated;

-- p_rows: [{bill_no, date, kind, category, account_id, party_id, amount, note}]
-- kind: 'expense', 'investor_profit_share' (party_id = the investor) or
-- 'owner_withdrawal'. A Bill No already on the site is skipped. A row in
-- a locked month refuses the whole import (the screen leaves those out).
CREATE OR REPLACE FUNCTION kaarbar_import_expenses(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_import   uuid;
  v_row      jsonb;
  v_bill     text;
  v_date     date;
  v_kind     text;
  v_amount   numeric;
  v_acc      money_accounts%ROWTYPE;
  v_cat      uuid;
  v_cat_name text;
  v_party    uuid;
  v_created  uuid[] := '{}';
  v_added    integer := 0;
  v_skipped  integer := 0;
  v_total    numeric := 0;
BEGIN
  PERFORM kaarbar_require(true);
  IF money_start_date() IS NULL THEN
    RAISE EXCEPTION 'Confirm your opening balances in Money first.';
  END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'There is nothing to import.';
  END IF;

  INSERT INTO kaarbar_imports (kind, created_by, created_by_username)
  VALUES ('expenses', auth.uid(), current_actor_username())
  RETURNING id INTO v_import;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_bill := NULLIF(btrim(COALESCE(v_row ->> 'bill_no', '')), '');
    v_date := NULLIF(v_row ->> 'date', '')::date;
    v_kind := v_row ->> 'kind';
    v_amount := round(NULLIF(v_row ->> 'amount', '')::numeric, 2);
    IF v_bill IS NULL THEN
      RAISE EXCEPTION 'A row has no Bill No. Preview the file again.';
    END IF;
    IF v_date IS NULL OR v_date > inventory_dhaka_today() THEN
      RAISE EXCEPTION 'Bill No % has no date or a future date.', v_bill;
    END IF;
    IF v_amount IS NULL OR v_amount <= 0 OR v_amount > 1000000000 THEN
      RAISE EXCEPTION 'Bill No % has no amount above 0.', v_bill;
    END IF;
    IF v_kind NOT IN ('expense', 'investor_profit_share', 'owner_withdrawal') THEN
      RAISE EXCEPTION 'Bill No % is not an expense.', v_bill;
    END IF;
    IF money_month_locked(v_date) THEN
      RAISE EXCEPTION '% is locked: Bill No % can''t be added. Preview the file again.', to_char(v_date, 'FMMonth YYYY'), v_bill;
    END IF;
    IF EXISTS (SELECT 1 FROM money_movements WHERE kaarbar_bill_no = v_bill) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    v_acc := money_check_account(NULLIF(v_row ->> 'account_id', '')::uuid);

    v_cat := NULL;
    v_party := NULL;
    IF v_kind = 'expense' THEN
      v_cat_name := regexp_replace(btrim(COALESCE(v_row ->> 'category', '')), '\s+', ' ', 'g');
      IF v_cat_name = '' THEN
        RAISE EXCEPTION 'Bill No % has no category.', v_bill;
      END IF;
      SELECT id INTO v_cat FROM money_categories
      WHERE kaarbar_name_key(name) = kaarbar_name_key(v_cat_name)
      ORDER BY archived, sort_order LIMIT 1;
      IF v_cat IS NULL THEN
        INSERT INTO money_categories (name, sort_order)
        VALUES (v_cat_name, COALESCE((SELECT max(sort_order) FROM money_categories), 0) + 1)
        RETURNING id INTO v_cat;
        v_created := v_created || v_cat;
      END IF;
    ELSIF v_kind = 'investor_profit_share' THEN
      v_party := NULLIF(v_row ->> 'party_id', '')::uuid;
      IF NOT EXISTS (SELECT 1 FROM parties_payable WHERE id = v_party AND kind = 'investor') THEN
        RAISE EXCEPTION 'Pick the investor for Bill No %.', v_bill;
      END IF;
    END IF;

    INSERT INTO money_movements (entry_date, account_id, amount, type, category_id, party_id, note,
                                 kaarbar_import_id, kaarbar_bill_no, created_by, created_by_username)
    VALUES (v_date, v_acc.id, -v_amount, v_kind, v_cat, v_party,
            NULLIF(COALESCE(v_row ->> 'note', ''), ''),
            v_import, v_bill, auth.uid(), current_actor_username());
    v_added := v_added + 1;
    v_total := v_total + v_amount;
  END LOOP;

  UPDATE kaarbar_imports SET row_count = v_added, total_amount = v_total, created_categories = v_created
  WHERE id = v_import;
  PERFORM write_activity('kaarbar.expenses_imported', 'kaarbar_import', v_import::text, 'Kaarbar expenses',
    format('Imported %s expenses from Kaarbar (%s)%s', v_added, money_short(v_total),
           CASE WHEN v_skipped > 0 THEN format(', %s already on the site skipped', v_skipped) ELSE '' END),
    jsonb_build_object('added', v_added, 'skipped', v_skipped, 'total', v_total,
                       'new_categories', cardinality(v_created)));
  RETURN jsonb_build_object('import_id', v_import, 'added', v_added, 'skipped', v_skipped,
                            'total', v_total, 'new_categories', cardinality(v_created));
END;
$$;

REVOKE ALL ON FUNCTION kaarbar_import_expenses(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION kaarbar_import_expenses(jsonb) TO authenticated;

-- Removes the entries the last expense import added (which also takes
-- their amount back out of the money accounts) and the categories it
-- created, when nothing else uses them. Entries in a month locked since
-- are kept and listed.
CREATE OR REPLACE FUNCTION kaarbar_undo_expenses()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_imp     kaarbar_imports%ROWTYPE;
  v_kept    jsonb;
  v_removed integer;
  v_total   numeric;
BEGIN
  PERFORM kaarbar_require(true);
  SELECT * INTO v_imp FROM kaarbar_imports
  WHERE kind = 'expenses' AND undone_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'There is no expense import to undo.';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('bill_no', m.kaarbar_bill_no, 'date', m.entry_date,
                                               'amount', -m.amount, 'reason', 'month is locked')
                            ORDER BY m.entry_date), '[]'::jsonb)
  INTO v_kept
  FROM money_movements m WHERE m.kaarbar_import_id = v_imp.id AND money_month_locked(m.entry_date);

  SELECT count(*), COALESCE(-sum(amount), 0) INTO v_removed, v_total
  FROM money_movements WHERE kaarbar_import_id = v_imp.id AND NOT money_month_locked(entry_date);
  DELETE FROM money_movements WHERE kaarbar_import_id = v_imp.id AND NOT money_month_locked(entry_date);

  DELETE FROM money_categories c
  WHERE c.id = ANY (v_imp.created_categories)
    AND NOT EXISTS (SELECT 1 FROM money_movements m WHERE m.category_id = c.id);

  UPDATE kaarbar_imports SET undone_at = now(), undone_by_username = current_actor_username(), undo_kept = v_kept
  WHERE id = v_imp.id;
  PERFORM write_activity('kaarbar.expenses_undone', 'kaarbar_import', v_imp.id::text, 'Kaarbar expenses',
    format('Undid the Kaarbar expense import: removed %s entries (%s)%s', v_removed, money_short(v_total),
           CASE WHEN jsonb_array_length(v_kept) > 0 THEN format(', kept %s in locked months', jsonb_array_length(v_kept)) ELSE '' END),
    jsonb_build_object('removed', v_removed, 'total', v_total, 'kept', v_kept));
  RETURN jsonb_build_object('removed', v_removed, 'total', v_total, 'kept', v_kept);
END;
$$;

REVOKE ALL ON FUNCTION kaarbar_undo_expenses() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION kaarbar_undo_expenses() TO authenticated;

COMMIT;
