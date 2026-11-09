-- ============================================================
-- Batch 41 — Money: accounts, expenses, investors, owner, dues, opening
-- balances, write-offs (reports/batch-41.txt).
--
--   money_accounts           Cash, bKash, Bank (rename / add more) and
--                            "With Steadfast" (never typed: it follows the
--                            COD money and the Batch 36 payouts).
--   money_categories         the expense categories (editable list).
--   parties_payable          investors and other people money is owed to.
--                            Suppliers stay in the Batch 39 suppliers list
--                            (the lots already use it) — not copied.
--   money_movements          every money entry that is not a customer
--                            payment: expenses, moves between accounts (a
--                            pair), investor money, the owner's money, money
--                            that is not the shop's, supplier and lot
--                            payments, Steadfast payouts placed in an
--                            account, opening balances, count differences.
--   money_ledger (view)      money_movements + the existing customer
--                            payments (order_payments, never copied) +
--                            previous-balance payments + Steadfast payouts.
--   money_books              one row: the start date (= the opening stock
--                            L-000 date), when the opening balances were
--                            confirmed, and the last account a payout went to.
--   customer_opening_dues    "Previous balance" per phone (from Kaarbar).
--   customer_due_payments    money received against a previous balance.
--   customer_due_reminders   each WhatsApp due reminder sent.
--   money_opening_payables   what was owed on the start date.
--   stock_write_offs         stock that left without a sale (expired,
--                            damaged, gift, own use, lost, count difference,
--                            damaged return), at landed cost.
--   money_check_log          the balance check's result per day (to show the
--                            first day it went wrong).
--
-- Who can read and write: only staff_can('view_profit_costs') (today only
-- the Super Admin). A new staff switch "Add money entries" (Off for every
-- role and person) lets someone add an expense or move money without seeing
-- any profit, balance or list.
--
-- Accounting rules (fixed): profit and cash are different. Investor money,
-- profit share, capital back, the owner's withdrawals and money put in,
-- moves between accounts, buying stock (a lot) and money that is not the
-- shop's are never expenses. Courier + COD fee stay in each order's profit
-- (order_courier_costs); lot weight / trip costs stay in the lot.
--
-- Additive only: new tables, functions, one view, one storage bucket, one
-- more staff switch, one settings row. Two existing functions are replaced
-- with the same behaviour plus one fix each:
--   order_customer_keys()  a Returned order owes nothing (like Cancelled).
--   staff_permission_names()  one more name at the end.
-- Nothing is dropped or renamed. Safe to run more than once.
-- ============================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- PART 0 — the new staff switch (appended: every role and person keeps
-- exactly what they have, so it is Off for everyone)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION staff_permission_names()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'view_orders', 'change_order_status', 'create_orders', 'book_steadfast',
    'edit_products', 'edit_categories', 'view_customers', 'delete_early_orders',
    'view_wholesalers', 'see_sales', 'edit_brands', 'edit_customer_notes',
    'edit_orders', 'manage_customers', 'view_profit_costs', 'add_money_entries'
  ];
$$;

CREATE OR REPLACE FUNCTION money_can_view()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT staff_can('view_profit_costs');
$$;

CREATE OR REPLACE FUNCTION money_can_add()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT staff_can('view_profit_costs') OR staff_can('add_money_entries');
$$;

GRANT EXECUTE ON FUNCTION money_can_view() TO authenticated;
GRANT EXECUTE ON FUNCTION money_can_add() TO authenticated;

-- ---------------------------------------------------------------------------
-- PART 1 — tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS money_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL CHECK (btrim(name) <> ''),
  -- 'steadfast' = With Steadfast (one row, never typed into).
  kind            text NOT NULL CHECK (kind IN ('cash', 'bkash', 'bank', 'nagad', 'other', 'steadfast')),
  -- Customer payments with this method land in this account
  -- (order_payments.method). One account per method.
  payment_method  text UNIQUE CHECK (payment_method IS NULL OR payment_method IN ('cash', 'bkash', 'bank', 'nagad', 'cod_steadfast', 'other')),
  sort_order      integer NOT NULL DEFAULT 0,
  archived        boolean NOT NULL DEFAULT false,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_money_accounts_steadfast ON money_accounts (kind) WHERE kind = 'steadfast';

CREATE TABLE IF NOT EXISTS money_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE CHECK (btrim(name) <> ''),
  sort_order  integer NOT NULL DEFAULT 0,
  archived    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS parties_payable (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (btrim(name) <> ''),
  phone       text,
  -- Suppliers are the Batch 39 suppliers list (lots use it).
  kind        text NOT NULL CHECK (kind IN ('investor', 'other')),
  note        text,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_parties_payable_name ON parties_payable (kind, lower(btrim(name)));

CREATE TABLE IF NOT EXISTS money_movements (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_date          date NOT NULL,
  account_id          uuid NOT NULL REFERENCES money_accounts(id),
  -- + money in, − money out (the sign follows the type, see money_type_sign).
  amount              numeric(12,2) NOT NULL CHECK (amount <> 0),
  type                text NOT NULL CHECK (type IN (
                        'opening_balance', 'expense', 'transfer_out', 'transfer_in',
                        'investor_in', 'investor_profit_share', 'investor_capital_back',
                        'owner_withdrawal', 'owner_money_in', 'non_business_in', 'non_business_out',
                        'supplier_payment', 'steadfast_payout_in', 'adjustment', 'lot_payment')),
  category_id         uuid REFERENCES money_categories(id),
  party_id            uuid REFERENCES parties_payable(id),
  supplier_id         uuid REFERENCES suppliers(id),
  lot_id              uuid REFERENCES lots(id) ON DELETE SET NULL,
  order_id            uuid REFERENCES orders(id) ON DELETE SET NULL,
  payout_id           uuid UNIQUE REFERENCES steadfast_payouts(id) ON DELETE SET NULL,
  -- The two rows of one move between accounts share this id.
  transfer_id         uuid,
  note                text,
  reference           text,
  -- A small bill photo (private bucket money-bills).
  bill_path           text,
  created_by          uuid,
  created_by_username text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by_username text,
  CHECK (type <> 'expense' OR category_id IS NOT NULL),
  CHECK (type NOT IN ('transfer_out', 'transfer_in') OR transfer_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_money_movements_date ON money_movements (entry_date);
CREATE INDEX IF NOT EXISTS idx_money_movements_account ON money_movements (account_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_money_movements_type ON money_movements (type, entry_date);
CREATE INDEX IF NOT EXISTS idx_money_movements_lot ON money_movements (lot_id);
CREATE INDEX IF NOT EXISTS idx_money_movements_transfer ON money_movements (transfer_id);

CREATE TABLE IF NOT EXISTS money_books (
  id                      integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  start_date              date,
  confirmed_at            timestamptz,
  confirmed_by_username   text,
  opening_steadfast       numeric(12,2),
  last_payout_account_id  uuid REFERENCES money_accounts(id) ON DELETE SET NULL
);

INSERT INTO money_books (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS customer_opening_dues (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_key           text NOT NULL,
  full_name           text NOT NULL DEFAULT '',
  phone               text NOT NULL DEFAULT '',
  amount              numeric(12,2) NOT NULL CHECK (amount > 0),
  -- 'kaarbar' (the due from Kaarbar), 'kaarbar_minus_site' (Kaarbar's due
  -- with the site's own due for the same orders taken off), 'added' (both).
  choice              text NOT NULL DEFAULT 'kaarbar' CHECK (choice IN ('kaarbar', 'kaarbar_minus_site', 'added')),
  kaarbar_amount      numeric(12,2),
  site_due_then       numeric(12,2),
  created_by_username text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_opening_dues_phone ON customer_opening_dues (phone_key);

CREATE TABLE IF NOT EXISTS customer_due_payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_key           text NOT NULL,
  amount              numeric(12,2) NOT NULL CHECK (amount > 0),
  account_id          uuid NOT NULL REFERENCES money_accounts(id),
  paid_date           date NOT NULL,
  note                text,
  created_by          uuid,
  created_by_username text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_due_payments_phone ON customer_due_payments (phone_key);

CREATE TABLE IF NOT EXISTS customer_due_reminders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_key        text NOT NULL,
  phone_key           text,
  amount              numeric(12,2) NOT NULL,
  order_id            uuid REFERENCES orders(id) ON DELETE SET NULL,
  how                 text NOT NULL DEFAULT 'whatsapp' CHECK (how IN ('whatsapp', 'copied')),
  created_by          uuid,
  created_by_username text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_due_reminders_key ON customer_due_reminders (customer_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_due_reminders_phone ON customer_due_reminders (phone_key, created_at DESC);

CREATE TABLE IF NOT EXISTS money_opening_payables (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id            uuid REFERENCES parties_payable(id),
  supplier_id         uuid REFERENCES suppliers(id),
  amount              numeric(12,2) NOT NULL CHECK (amount > 0),
  note                text,
  created_by_username text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((party_id IS NULL) <> (supplier_id IS NULL))
);

CREATE TABLE IF NOT EXISTS stock_write_offs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  write_date          date NOT NULL,
  product_id          uuid REFERENCES products(id) ON DELETE SET NULL,
  variant_id          uuid REFERENCES product_variants(id) ON DELETE SET NULL,
  label               text NOT NULL DEFAULT '',
  units               integer NOT NULL CHECK (units > 0),
  reason              text NOT NULL CHECK (reason IN ('expired', 'damaged', 'gift', 'own_use', 'lost', 'count_difference', 'damaged_return')),
  note                text,
  -- Landed cost of the units (a loss in profit on write_date).
  cost_bdt            numeric(12,2) NOT NULL DEFAULT 0,
  order_id            uuid REFERENCES orders(id) ON DELETE SET NULL,
  -- [{lot_item_id, code, units, unit_cost}]
  lots                jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by          uuid,
  created_by_username text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_write_offs_date ON stock_write_offs (write_date);

CREATE TABLE IF NOT EXISTS money_check_log (
  check_date  date PRIMARY KEY,
  difference  numeric(12,2) NOT NULL,
  checked_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Who can read (RLS). No write policy: every write goes through the
-- functions below.
-- ---------------------------------------------------------------------------
ALTER TABLE money_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE parties_payable ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_books ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_opening_dues ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_due_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_due_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_opening_payables ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_write_offs ENABLE ROW LEVEL SECURITY;
ALTER TABLE money_check_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON money_accounts, money_categories, parties_payable, money_movements, money_books,
  customer_opening_dues, customer_due_payments, customer_due_reminders, money_opening_payables,
  stock_write_offs, money_check_log FROM anon, authenticated;
GRANT SELECT ON money_accounts, money_categories, parties_payable, money_movements, money_books,
  customer_opening_dues, customer_due_payments, customer_due_reminders, money_opening_payables,
  stock_write_offs, money_check_log TO authenticated;
GRANT ALL ON money_accounts, money_categories, parties_payable, money_movements, money_books,
  customer_opening_dues, customer_due_payments, customer_due_reminders, money_opening_payables,
  stock_write_offs, money_check_log TO service_role;

-- Account names and categories: also for "Add money entries" (the form
-- needs them). Nothing else is readable without "View profit & costs".
DROP POLICY IF EXISTS money_accounts_read ON money_accounts;
CREATE POLICY money_accounts_read ON money_accounts FOR SELECT TO authenticated USING (money_can_add());
DROP POLICY IF EXISTS money_categories_read ON money_categories;
CREATE POLICY money_categories_read ON money_categories FOR SELECT TO authenticated USING (money_can_add());
DROP POLICY IF EXISTS parties_payable_read ON parties_payable;
CREATE POLICY parties_payable_read ON parties_payable FOR SELECT TO authenticated USING (money_can_view());
DROP POLICY IF EXISTS money_movements_read ON money_movements;
CREATE POLICY money_movements_read ON money_movements FOR SELECT TO authenticated USING (money_can_view());
DROP POLICY IF EXISTS money_books_read ON money_books;
CREATE POLICY money_books_read ON money_books FOR SELECT TO authenticated USING (money_can_view());
DROP POLICY IF EXISTS customer_opening_dues_read ON customer_opening_dues;
CREATE POLICY customer_opening_dues_read ON customer_opening_dues FOR SELECT TO authenticated USING (money_can_view());
DROP POLICY IF EXISTS customer_due_payments_read ON customer_due_payments;
CREATE POLICY customer_due_payments_read ON customer_due_payments FOR SELECT TO authenticated USING (money_can_view());
DROP POLICY IF EXISTS customer_due_reminders_read ON customer_due_reminders;
CREATE POLICY customer_due_reminders_read ON customer_due_reminders FOR SELECT TO authenticated USING (money_can_view());
DROP POLICY IF EXISTS money_opening_payables_read ON money_opening_payables;
CREATE POLICY money_opening_payables_read ON money_opening_payables FOR SELECT TO authenticated USING (money_can_view());
DROP POLICY IF EXISTS stock_write_offs_read ON stock_write_offs;
CREATE POLICY stock_write_offs_read ON stock_write_offs FOR SELECT TO authenticated USING (money_can_view());
DROP POLICY IF EXISTS money_check_log_read ON money_check_log;
CREATE POLICY money_check_log_read ON money_check_log FOR SELECT TO authenticated USING (money_can_view());

-- ---------------------------------------------------------------------------
-- Starting lists (only when empty, so a rename is never undone)
-- ---------------------------------------------------------------------------
INSERT INTO money_accounts (name, kind, payment_method, sort_order)
SELECT v.name, v.kind, v.method, v.sort
FROM (VALUES ('Cash', 'cash', 'cash', 1), ('bKash', 'bkash', 'bkash', 2), ('Bank', 'bank', 'bank', 3),
             ('With Steadfast', 'steadfast', 'cod_steadfast', 9)) v(name, kind, method, sort)
WHERE NOT EXISTS (SELECT 1 FROM money_accounts a WHERE a.kind = v.kind);

INSERT INTO money_categories (name, sort_order)
SELECT v.name, v.sort
FROM (VALUES ('Ads', 1), ('Packaging', 2), ('Subscriptions', 3), ('Salaries & bonus', 4),
             ('Customer gifts & offers', 5), ('Food', 6), ('Utilities', 7), ('Bank & mobile fees', 8),
             ('Rent', 9), ('Transport', 10), ('Other', 11)) v(name, sort)
WHERE NOT EXISTS (SELECT 1 FROM money_categories);

-- The due reminder text (Settings). {name} {due} {date} {link}; the line
-- with {link} is left out when there is no unpaid site order.
INSERT INTO app_settings (key, value)
VALUES ('due_reminder_template',
        E'Hello {name},\nYou have Tk. {due} left to pay as on {date}.\nThank you!\n– Naeem''s - SkinScience\nView your orders: {link}')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- PART 2 — helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION money_start_date()
RETURNS date
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT start_date FROM money_books WHERE id = 1 AND confirmed_at IS NOT NULL;
$$;

-- The start of the start date in Dhaka (counts are as of the morning).
CREATE OR REPLACE FUNCTION money_start_ts()
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT (money_start_date()::timestamp AT TIME ZONE 'Asia/Dhaka');
$$;

CREATE OR REPLACE FUNCTION money_type_sign(p_type text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_type IN ('expense', 'transfer_out', 'investor_profit_share', 'investor_capital_back',
                    'owner_withdrawal', 'non_business_out', 'supplier_payment', 'lot_payment') THEN -1
    WHEN p_type IN ('transfer_in', 'investor_in', 'owner_money_in', 'non_business_in', 'steadfast_payout_in') THEN 1
    ELSE 0
  END;
$$;

CREATE OR REPLACE FUNCTION money_type_label(p_type text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_type
    WHEN 'opening_balance' THEN 'Opening balance'
    WHEN 'expense' THEN 'Expense'
    WHEN 'transfer_out' THEN 'Moved out'
    WHEN 'transfer_in' THEN 'Moved in'
    WHEN 'investor_in' THEN 'Investor money in'
    WHEN 'investor_profit_share' THEN 'Investor profit share'
    WHEN 'investor_capital_back' THEN 'Investor capital returned'
    WHEN 'owner_withdrawal' THEN 'My withdrawal'
    WHEN 'owner_money_in' THEN 'My money put in'
    WHEN 'non_business_in' THEN 'Not shop money in'
    WHEN 'non_business_out' THEN 'Not shop money out'
    WHEN 'supplier_payment' THEN 'Paid what I owe'
    WHEN 'steadfast_payout_in' THEN 'Steadfast payout'
    WHEN 'adjustment' THEN 'Count difference'
    WHEN 'lot_payment' THEN 'Paid for a lot'
    WHEN 'customer_payment' THEN 'Customer payment'
    WHEN 'customer_refund' THEN 'Refund to customer'
    WHEN 'previous_balance_payment' THEN 'Previous balance paid'
    WHEN 'steadfast_payout_out' THEN 'Paid out by Steadfast'
    WHEN 'courier_fees' THEN 'Courier & COD fees (in order profit)'
    WHEN 'steadfast_unmatched' THEN 'Steadfast parcel not matched to an order'
    ELSE p_type
  END;
$$;

-- The account a customer payment method lands in. A method no account
-- takes (e.g. Nagad before a Nagad account exists, or "Other") goes to Cash.
CREATE OR REPLACE FUNCTION money_account_for_method(p_method text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT id FROM money_accounts WHERE payment_method = p_method),
    (SELECT id FROM money_accounts WHERE payment_method = 'cash'),
    (SELECT id FROM money_accounts WHERE kind = 'cash' ORDER BY sort_order, created_at LIMIT 1));
$$;

CREATE OR REPLACE FUNCTION money_steadfast_account()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM money_accounts WHERE kind = 'steadfast' LIMIT 1;
$$;

-- An order took (or tried to take) stock from lots — its profit counts.
CREATE OR REPLACE FUNCTION money_order_costed(p_order_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM order_item_lots WHERE order_id = p_order_id)
      OR EXISTS (SELECT 1 FROM stock_shortfalls WHERE order_id = p_order_id);
$$;

-- An order's status at a moment (from its status history).
CREATE OR REPLACE FUNCTION money_order_status_at(p_order_id uuid, p_at timestamptz)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT h.new_status FROM order_status_history h WHERE h.order_id = p_order_id AND h.changed_at < p_at
     ORDER BY h.changed_at DESC, h.id DESC LIMIT 1),
    (SELECT h.old_status FROM order_status_history h WHERE h.order_id = p_order_id AND h.changed_at >= p_at
     AND h.old_status IS NOT NULL ORDER BY h.changed_at, h.id LIMIT 1),
    (SELECT status FROM orders WHERE id = p_order_id));
$$;

-- "Previous balance" left per phone.
CREATE OR REPLACE FUNCTION money_previous_left(p_phone_key text)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT sum(amount) FROM customer_opening_dues WHERE phone_key = p_phone_key), 0)
       - COALESCE((SELECT sum(amount) FROM customer_due_payments WHERE phone_key = p_phone_key), 0);
$$;

CREATE OR REPLACE FUNCTION money_short(p_amount numeric)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT '৳' || regexp_replace(to_char(round(abs(COALESCE(p_amount, 0)), 2), 'FM999,999,999,990.00'), '\.00$', '');
$$;

-- The money_ledger view calls these as the person reading it (they only
-- return a date or an account id).
REVOKE ALL ON FUNCTION money_start_ts() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION money_account_for_method(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION money_steadfast_account() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION money_start_ts() TO authenticated;
GRANT EXECUTE ON FUNCTION money_account_for_method(text) TO authenticated;
GRANT EXECUTE ON FUNCTION money_steadfast_account() TO authenticated;
REVOKE ALL ON FUNCTION money_order_costed(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION money_order_status_at(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION money_previous_left(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION money_start_date() TO authenticated;

-- ---------------------------------------------------------------------------
-- Fix: a Returned order owes nothing (Batch 39 added Returned; the Batch 30
-- due still counted its total). Otherwise the same as migration-033.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION order_customer_keys()
RETURNS TABLE (order_id uuid, customer_key text, profile_id uuid, due numeric)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  WITH prof AS (
    SELECT p.id, bd_phone_key(p.phone) AS pkey, p.created_at
    FROM profiles p WHERE p.role = 'customer'
  ),
  prof_by_key AS (
    SELECT DISTINCT ON (pkey) pkey, id FROM prof WHERE pkey IS NOT NULL ORDER BY pkey, created_at, id
  ),
  paid AS (
    SELECT order_id, sum(CASE WHEN kind = 'refund' THEN -amount ELSE amount END) AS net
    FROM order_payments GROUP BY order_id
  )
  SELECT o.id,
         CASE
           WHEN own.id IS NOT NULL THEN 'p:' || own.id
           WHEN picked.id IS NOT NULL THEN 'p:' || picked.id
           WHEN pk.id IS NOT NULL THEN 'p:' || pk.id
           WHEN bd_phone_key(o.customer_phone) IS NOT NULL THEN 'ph:' || bd_phone_key(o.customer_phone)
           ELSE 'n:' || lower(trim(o.customer_name))
         END,
         COALESCE(own.id, picked.id, pk.id),
         CASE WHEN o.status IN ('cancelled', 'returned') THEN 0 ELSE GREATEST(o.total - COALESCE(pd.net, 0), 0) END
  FROM orders o
  LEFT JOIN prof own ON own.id = o.customer_id
  LEFT JOIN prof picked ON picked.id = o.admin_customer_id
  LEFT JOIN prof_by_key pk ON pk.pkey = bd_phone_key(o.customer_phone)
  LEFT JOIN paid pd ON pd.order_id = o.id;
$$;

REVOKE ALL ON FUNCTION order_customer_keys() FROM PUBLIC, anon, authenticated;

-- The customer key a phone belongs to (same rule as order_customer_keys).
CREATE OR REPLACE FUNCTION money_customer_key_for_phone(p_phone_key text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT 'p:' || p.id FROM profiles p WHERE p.role = 'customer' AND bd_phone_key(p.phone) = p_phone_key
     ORDER BY p.created_at, p.id LIMIT 1),
    'ph:' || p_phone_key);
$$;

REVOKE ALL ON FUNCTION money_customer_key_for_phone(text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- PART 3 — the money ledger (one row per money move in an account)
-- From the start date on (everything before it is in the opening balances).
-- Customer payments are read from order_payments — never copied.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW money_ledger AS
SELECT * FROM (
  -- Money entries.
  SELECT 'movement'::text AS source, m.id::text AS source_id, m.entry_date, m.account_id, m.amount,
         m.type, m.category_id, m.party_id, m.supplier_id, m.lot_id, m.order_id, m.payout_id,
         m.note, m.reference, m.created_by_username, m.created_at
  FROM money_movements m
  WHERE money_start_date() IS NULL OR m.entry_date >= money_start_date()
  UNION ALL
  -- A payout placed in an account leaves "With Steadfast".
  SELECT 'payout_out', m.id::text, m.entry_date, money_steadfast_account(), -m.amount,
         'steadfast_payout_out', NULL, NULL, NULL, NULL, NULL, m.payout_id,
         m.note, m.reference, m.created_by_username, m.created_at
  FROM money_movements m
  WHERE m.type = 'steadfast_payout_in'
    AND (money_start_date() IS NULL OR m.entry_date >= money_start_date())
  UNION ALL
  -- Customer payments and refunds (Batch 30), in the account of their method.
  SELECT 'payment', p.id::text, (p.paid_at AT TIME ZONE 'Asia/Dhaka')::date, money_account_for_method(p.method),
         CASE WHEN p.kind = 'refund' THEN -p.amount ELSE p.amount END,
         CASE WHEN p.kind = 'refund' THEN 'customer_refund' ELSE 'customer_payment' END,
         NULL, NULL, NULL, NULL, p.order_id, NULL,
         p.note, o.order_number, p.created_by_username, p.created_at
  FROM order_payments p
  JOIN orders o ON o.id = p.order_id
  WHERE money_start_date() IS NULL OR p.paid_at >= money_start_ts()
  UNION ALL
  -- Payments against a previous balance (Kaarbar dues).
  SELECT 'due_payment', d.id::text, d.paid_date, d.account_id, d.amount, 'previous_balance_payment',
         NULL, NULL, NULL, NULL, NULL, NULL, d.note, d.phone_key, d.created_by_username, d.created_at
  FROM customer_due_payments d
  WHERE money_start_date() IS NULL OR d.paid_date >= money_start_date()
  UNION ALL
  -- What Steadfast kept (delivery charge + COD fee + other) on parcels it
  -- delivered or returned from the start date on. Already in each order's
  -- profit — here only so "With Steadfast" is right. Parcels delivered
  -- before the start date are in Steadfast's opening balance (net).
  SELECT 'payout_fees', i.id::text, (sp.paid_at AT TIME ZONE 'Asia/Dhaka')::date, money_steadfast_account(),
         -(i.delivery_charge + i.cod_fee + i.other_deduction), 'courier_fees',
         NULL, NULL, NULL, NULL, i.order_id, sp.id,
         NULL, o.order_number, 'steadfast', sp.last_synced_at
  FROM steadfast_payout_items i
  JOIN steadfast_payouts sp ON sp.id = i.payout_id
  JOIN orders o ON o.id = i.order_id
  WHERE (i.delivery_charge + i.cod_fee + i.other_deduction) <> 0
    AND (money_start_date() IS NULL
         OR (sp.paid_at >= money_start_ts()
             AND COALESCE((SELECT max(h.changed_at) FROM order_status_history h
                           WHERE h.order_id = o.id AND h.new_status IN ('delivered', 'returned')), o.created_at) >= money_start_ts()))
  UNION ALL
  -- A parcel in a payout that matches no order: its COD was never recorded
  -- as a customer payment, so the net Steadfast paid for it is added here.
  SELECT 'payout_unmatched', i.id::text, (sp.paid_at AT TIME ZONE 'Asia/Dhaka')::date, money_steadfast_account(),
         i.net_paid, 'steadfast_unmatched',
         NULL, NULL, NULL, NULL, NULL, sp.id,
         COALESCE(i.invoice, i.consignment_id), NULL, 'steadfast', sp.last_synced_at
  FROM steadfast_payout_items i
  JOIN steadfast_payouts sp ON sp.id = i.payout_id
  WHERE i.order_id IS NULL AND i.net_paid <> 0
    AND money_start_date() IS NOT NULL AND sp.paid_at >= money_start_ts()
) ledger
-- The view reads as its owner, so it checks the permission itself.
WHERE money_can_view();

REVOKE ALL ON money_ledger FROM anon, authenticated;
GRANT SELECT ON money_ledger TO authenticated;

-- Balance per account (today).
CREATE OR REPLACE FUNCTION money_account_balances()
RETURNS TABLE (account_id uuid, name text, kind text, archived boolean, sort_order integer, balance numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  RETURN QUERY
  SELECT a.id, a.name, a.kind, a.archived, a.sort_order,
         COALESCE((SELECT sum(l.amount) FROM money_ledger l WHERE l.account_id = a.id), 0)::numeric
  FROM money_accounts a
  ORDER BY (a.kind = 'steadfast'), a.sort_order, a.created_at;
END;
$$;

REVOKE ALL ON FUNCTION money_account_balances() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION money_account_balances() TO authenticated;

-- ---------------------------------------------------------------------------
-- PART 4 — adding, editing and deleting money entries
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION money_check_entry_date(p_date date)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_date IS NULL THEN
    RAISE EXCEPTION 'Pick a date.';
  END IF;
  IF p_date > inventory_dhaka_today() THEN
    RAISE EXCEPTION 'The date can''t be in the future.';
  END IF;
  IF money_start_date() IS NOT NULL AND p_date < money_start_date() THEN
    RAISE EXCEPTION 'The date is before your start date (%). Everything before it is in the opening balances.',
      to_char(money_start_date(), 'DD Mon YYYY');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION money_check_account(p_account uuid)
RETURNS money_accounts
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_acc money_accounts%ROWTYPE;
BEGIN
  SELECT * INTO v_acc FROM money_accounts WHERE id = p_account;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pick an account.';
  END IF;
  IF v_acc.kind = 'steadfast' THEN
    RAISE EXCEPTION '"With Steadfast" is not typed into: it follows the COD money and the Steadfast payouts.';
  END IF;
  IF v_acc.archived THEN
    RAISE EXCEPTION 'The account "%" is archived.', v_acc.name;
  END IF;
  RETURN v_acc;
END;
$$;

REVOKE ALL ON FUNCTION money_check_entry_date(date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION money_check_account(uuid) FROM PUBLIC, anon, authenticated;

-- One entry as a short line for the Activity Log.
CREATE OR REPLACE FUNCTION money_entry_text(p_row money_movements)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT format('%s %s, %s, %s%s%s',
    money_type_label(p_row.type), money_short(p_row.amount),
    (SELECT name FROM money_accounts WHERE id = p_row.account_id),
    to_char(p_row.entry_date, 'DD Mon YYYY'),
    COALESCE(' · ' || (SELECT name FROM money_categories WHERE id = p_row.category_id), ''),
    COALESCE(' · ' || NULLIF(btrim(p_row.note), ''), ''));
$$;

REVOKE ALL ON FUNCTION money_entry_text(money_movements) FROM PUBLIC, anon, authenticated;

-- Add money (the "Add money" screen). p_amount is typed positive; the sign
-- follows the type. Only "adjustment" takes a signed amount.
-- p_type: expense | transfer | investor_in | investor_profit_share |
--         investor_capital_back | owner_withdrawal | owner_money_in |
--         non_business_in | non_business_out | supplier_payment | adjustment
-- "Add money entries" (without "View profit & costs") may add an expense or
-- move money; everything else needs "View profit & costs".
CREATE OR REPLACE FUNCTION money_add_entry(
  p_type        text,
  p_amount      numeric,
  p_account     uuid,
  p_date        date,
  p_note        text DEFAULT NULL,
  p_category    uuid DEFAULT NULL,
  p_party       uuid DEFAULT NULL,
  p_supplier    uuid DEFAULT NULL,
  p_to_account  uuid DEFAULT NULL,
  p_bill_path   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_acc      money_accounts%ROWTYPE;
  v_to       money_accounts%ROWTYPE;
  v_amount   numeric := round(p_amount, 2);
  v_note     text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_row      money_movements%ROWTYPE;
  v_pair     uuid;
  v_ids      uuid[] := '{}';
  v_kind     text;
  v_in_id    uuid;
BEGIN
  IF p_type IN ('expense', 'transfer') THEN
    IF NOT money_can_add() THEN
      RAISE EXCEPTION 'Not authorized.';
    END IF;
  ELSIF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_type NOT IN ('expense', 'transfer', 'investor_in', 'investor_profit_share', 'investor_capital_back',
                    'owner_withdrawal', 'owner_money_in', 'non_business_in', 'non_business_out',
                    'supplier_payment', 'adjustment') THEN
    RAISE EXCEPTION 'Unknown kind of money entry.';
  END IF;
  IF v_amount IS NULL OR v_amount = 0 OR (p_type <> 'adjustment' AND v_amount < 0) THEN
    RAISE EXCEPTION 'Type an amount above 0.';
  END IF;
  IF abs(v_amount) > 1000000000 THEN
    RAISE EXCEPTION 'That amount is too large.';
  END IF;
  PERFORM money_check_entry_date(p_date);
  v_acc := money_check_account(p_account);

  IF p_type = 'expense' THEN
    IF p_category IS NULL OR NOT EXISTS (SELECT 1 FROM money_categories WHERE id = p_category AND NOT archived) THEN
      RAISE EXCEPTION 'Pick a category.';
    END IF;
  END IF;
  IF p_type IN ('investor_in', 'investor_profit_share', 'investor_capital_back') THEN
    SELECT kind INTO v_kind FROM parties_payable WHERE id = p_party;
    IF v_kind IS DISTINCT FROM 'investor' THEN
      RAISE EXCEPTION 'Pick the investor.';
    END IF;
  END IF;
  IF p_type = 'supplier_payment' THEN
    IF (p_supplier IS NULL) = (p_party IS NULL) THEN
      RAISE EXCEPTION 'Pick who you paid.';
    END IF;
    IF p_supplier IS NOT NULL AND NOT EXISTS (SELECT 1 FROM suppliers WHERE id = p_supplier) THEN
      RAISE EXCEPTION 'Supplier not found.';
    END IF;
    IF p_party IS NOT NULL AND NOT EXISTS (SELECT 1 FROM parties_payable WHERE id = p_party) THEN
      RAISE EXCEPTION 'Not found.';
    END IF;
  END IF;

  IF p_type = 'transfer' THEN
    v_to := money_check_account(p_to_account);
    IF v_to.id = v_acc.id THEN
      RAISE EXCEPTION 'Pick two different accounts.';
    END IF;
    v_pair := gen_random_uuid();
    INSERT INTO money_movements (entry_date, account_id, amount, type, transfer_id, note, created_by, created_by_username)
    VALUES (p_date, v_acc.id, -v_amount, 'transfer_out', v_pair, v_note, auth.uid(), current_actor_username())
    RETURNING * INTO v_row;
    v_ids := v_ids || v_row.id;
    INSERT INTO money_movements (entry_date, account_id, amount, type, transfer_id, note, created_by, created_by_username)
    VALUES (p_date, v_to.id, v_amount, 'transfer_in', v_pair, v_note, auth.uid(), current_actor_username())
    RETURNING id INTO v_in_id;
    v_ids := v_ids || v_in_id;
    PERFORM write_activity('money.add', 'money', v_pair::text, 'Move money',
      format('Moved %s from %s to %s, %s%s', money_short(v_amount), v_acc.name, v_to.name,
             to_char(p_date, 'DD Mon YYYY'), COALESCE(' · ' || v_note, '')),
      jsonb_build_object('type', 'transfer', 'amount', v_amount, 'from', v_acc.name, 'to', v_to.name, 'date', p_date));
    RETURN jsonb_build_object('ids', to_jsonb(v_ids), 'transfer_id', v_pair);
  END IF;

  INSERT INTO money_movements (entry_date, account_id, amount, type, category_id, party_id, supplier_id,
                               note, bill_path, created_by, created_by_username)
  VALUES (p_date, v_acc.id,
          CASE WHEN p_type = 'adjustment' THEN v_amount ELSE money_type_sign(p_type) * v_amount END,
          p_type,
          CASE WHEN p_type = 'expense' THEN p_category END,
          CASE WHEN p_type IN ('investor_in', 'investor_profit_share', 'investor_capital_back', 'supplier_payment') THEN p_party END,
          CASE WHEN p_type = 'supplier_payment' THEN p_supplier END,
          v_note, NULLIF(btrim(COALESCE(p_bill_path, '')), ''), auth.uid(), current_actor_username())
  RETURNING * INTO v_row;

  PERFORM write_activity('money.add', 'money', v_row.id::text, money_type_label(v_row.type),
    'Added ' || money_entry_text(v_row), to_jsonb(v_row));
  RETURN jsonb_build_object('ids', to_jsonb(ARRAY[v_row.id]));
END;
$$;

REVOKE ALL ON FUNCTION money_add_entry(text, numeric, uuid, date, text, uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION money_add_entry(text, numeric, uuid, date, text, uuid, uuid, uuid, uuid, text) TO authenticated;

-- Edit an entry (amount typed positive, except a count difference). Every
-- change is written to the Activity Log with before and after. A move
-- between accounts changes both of its rows. Opening balances are changed
-- only by undoing the opening (Careful actions).
CREATE OR REPLACE FUNCTION money_update_entry(
  p_id          uuid,
  p_amount      numeric,
  p_account     uuid,
  p_date        date,
  p_note        text DEFAULT NULL,
  p_category    uuid DEFAULT NULL,
  p_party       uuid DEFAULT NULL,
  p_supplier    uuid DEFAULT NULL,
  p_to_account  uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old     money_movements%ROWTYPE;
  v_new     money_movements%ROWTYPE;
  v_other   money_movements%ROWTYPE;
  v_amount  numeric := round(p_amount, 2);
  v_note    text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_kind    text;
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  SELECT * INTO v_old FROM money_movements WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Entry not found.';
  END IF;
  IF v_old.type IN ('opening_balance') THEN
    RAISE EXCEPTION 'Opening balances change only by undoing the opening (Careful actions).';
  END IF;
  IF v_old.type IN ('steadfast_payout_in') THEN
    RAISE EXCEPTION 'Change the account of a payout on the Money page (Steadfast payouts).';
  END IF;
  IF v_old.type = 'lot_payment' THEN
    RAISE EXCEPTION 'Change a lot payment on the lot.';
  END IF;
  IF money_start_date() IS NOT NULL AND v_old.entry_date < money_start_date() THEN
    RAISE EXCEPTION 'This entry is before your start date and is not part of the books.';
  END IF;
  IF v_amount IS NULL OR v_amount = 0 OR (v_old.type <> 'adjustment' AND v_amount < 0) THEN
    RAISE EXCEPTION 'Type an amount above 0.';
  END IF;
  IF abs(v_amount) > 1000000000 THEN
    RAISE EXCEPTION 'That amount is too large.';
  END IF;
  PERFORM money_check_entry_date(p_date);
  PERFORM money_check_account(p_account);

  IF v_old.type = 'expense' AND (p_category IS NULL OR NOT EXISTS (SELECT 1 FROM money_categories WHERE id = p_category)) THEN
    RAISE EXCEPTION 'Pick a category.';
  END IF;
  IF v_old.type IN ('investor_in', 'investor_profit_share', 'investor_capital_back') THEN
    SELECT kind INTO v_kind FROM parties_payable WHERE id = p_party;
    IF v_kind IS DISTINCT FROM 'investor' THEN
      RAISE EXCEPTION 'Pick the investor.';
    END IF;
  END IF;
  IF v_old.type = 'supplier_payment' AND (p_supplier IS NULL) = (p_party IS NULL) THEN
    RAISE EXCEPTION 'Pick who you paid.';
  END IF;

  IF v_old.type IN ('transfer_out', 'transfer_in') THEN
    SELECT * INTO v_other FROM money_movements
    WHERE transfer_id = v_old.transfer_id AND id <> v_old.id FOR UPDATE;
    IF p_to_account IS NULL THEN
      p_to_account := v_other.account_id;
    END IF;
    PERFORM money_check_account(p_to_account);
    IF p_to_account = p_account THEN
      RAISE EXCEPTION 'Pick two different accounts.';
    END IF;
    UPDATE money_movements
    SET entry_date = p_date, note = v_note, updated_at = now(), updated_by_username = current_actor_username(),
        account_id = CASE WHEN id = v_old.id THEN p_account ELSE p_to_account END,
        amount = CASE WHEN type = 'transfer_out' THEN -v_amount ELSE v_amount END
    WHERE transfer_id = v_old.transfer_id;
    -- The row that was edited keeps its side: an edit of the "in" row
    -- with account A and "to" B means money came into A from B.
    SELECT * INTO v_new FROM money_movements WHERE id = v_old.id;
    PERFORM write_activity('money.edit', 'money', v_old.transfer_id::text, 'Move money',
      format('Changed a move between accounts: %s → %s', money_entry_text(v_old), money_entry_text(v_new)),
      jsonb_build_object('before', to_jsonb(v_old), 'after', to_jsonb(v_new)));
    RETURN true;
  END IF;

  UPDATE money_movements
  SET entry_date = p_date, account_id = p_account,
      amount = CASE WHEN type = 'adjustment' THEN v_amount ELSE money_type_sign(type) * v_amount END,
      note = v_note,
      category_id = CASE WHEN type = 'expense' THEN p_category END,
      party_id = CASE WHEN type IN ('investor_in', 'investor_profit_share', 'investor_capital_back', 'supplier_payment') THEN p_party END,
      supplier_id = CASE WHEN type = 'supplier_payment' THEN p_supplier END,
      updated_at = now(), updated_by_username = current_actor_username()
  WHERE id = p_id
  RETURNING * INTO v_new;

  PERFORM write_activity('money.edit', 'money', v_old.id::text, money_type_label(v_old.type),
    format('Changed %s → %s', money_entry_text(v_old), money_entry_text(v_new)),
    jsonb_build_object('before', to_jsonb(v_old), 'after', to_jsonb(v_new)));
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION money_update_entry(uuid, numeric, uuid, date, text, uuid, uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION money_update_entry(uuid, numeric, uuid, date, text, uuid, uuid, uuid, uuid) TO authenticated;

-- Delete an entry (Careful actions: the screen asks to type the amount, and
-- the database checks the same). A move between accounts loses both rows.
CREATE OR REPLACE FUNCTION money_delete_entry(p_id uuid, p_confirm_amount numeric)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old money_movements%ROWTYPE;
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  SELECT * INTO v_old FROM money_movements WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Entry not found.';
  END IF;
  IF v_old.type = 'opening_balance' THEN
    RAISE EXCEPTION 'Opening balances go only by undoing the opening (Careful actions).';
  END IF;
  IF p_confirm_amount IS NULL OR round(abs(p_confirm_amount)) <> round(abs(v_old.amount)) THEN
    RAISE EXCEPTION 'Type the amount (%) to confirm.', round(abs(v_old.amount));
  END IF;
  IF v_old.transfer_id IS NOT NULL THEN
    DELETE FROM money_movements WHERE transfer_id = v_old.transfer_id;
  ELSE
    DELETE FROM money_movements WHERE id = p_id;
  END IF;
  PERFORM write_activity('money.delete', 'money', COALESCE(v_old.transfer_id, v_old.id)::text, money_type_label(v_old.type),
    'Deleted ' || money_entry_text(v_old), jsonb_build_object('deleted', to_jsonb(v_old)));
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION money_delete_entry(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION money_delete_entry(uuid, numeric) TO authenticated;

-- ---------------------------------------------------------------------------
-- Accounts, categories, investors / other people
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION money_save_account(
  p_id uuid, p_name text, p_kind text, p_payment_method text DEFAULT NULL, p_archived boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old money_accounts%ROWTYPE;
  v_id  uuid;
  v_name text := btrim(COALESCE(p_name, ''));
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF v_name = '' THEN
    RAISE EXCEPTION 'Type a name.';
  END IF;
  IF p_kind NOT IN ('cash', 'bkash', 'bank', 'nagad', 'other') THEN
    RAISE EXCEPTION 'Pick what kind of account it is.';
  END IF;
  IF p_payment_method IS NOT NULL AND p_payment_method NOT IN ('cash', 'bkash', 'bank', 'nagad', 'other') THEN
    RAISE EXCEPTION 'Unknown payment method.';
  END IF;
  IF p_payment_method IS NOT NULL AND EXISTS (
    SELECT 1 FROM money_accounts WHERE payment_method = p_payment_method AND id IS DISTINCT FROM p_id) THEN
    RAISE EXCEPTION 'Another account already takes those customer payments.';
  END IF;
  IF p_id IS NULL THEN
    INSERT INTO money_accounts (name, kind, payment_method, sort_order, created_by)
    VALUES (v_name, p_kind, p_payment_method,
            COALESCE((SELECT max(sort_order) FROM money_accounts WHERE kind <> 'steadfast'), 0) + 1, auth.uid())
    RETURNING id INTO v_id;
    PERFORM write_activity('money.account_add', 'money_account', v_id::text, v_name, format('Added the account "%s"', v_name), '{}'::jsonb);
    RETURN v_id;
  END IF;
  SELECT * INTO v_old FROM money_accounts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account not found.';
  END IF;
  IF v_old.kind = 'steadfast' THEN
    UPDATE money_accounts SET name = v_name WHERE id = p_id;
  ELSE
    UPDATE money_accounts
    SET name = v_name, kind = p_kind, payment_method = p_payment_method, archived = COALESCE(p_archived, false)
    WHERE id = p_id;
  END IF;
  PERFORM write_activity('money.account_edit', 'money_account', p_id::text, v_name,
    format('Changed the account "%s"%s', v_old.name,
           CASE WHEN v_old.name <> v_name THEN format(' (renamed to "%s")', v_name) ELSE '' END),
    jsonb_build_object('before', to_jsonb(v_old)));
  RETURN p_id;
END;
$$;

REVOKE ALL ON FUNCTION money_save_account(uuid, text, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION money_save_account(uuid, text, text, text, boolean) TO authenticated;

-- Profit share, courier and weight / cargo are never expense categories
-- (they are in profit already, or not an expense at all).
CREATE OR REPLACE FUNCTION money_category_name_ok(p_name text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT lower(p_name) !~ '(profit\s*share|courier|weight|cargo|steadfast|investor|withdraw)';
$$;

CREATE OR REPLACE FUNCTION money_save_category(p_id uuid, p_name text, p_archived boolean DEFAULT false)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text := btrim(COALESCE(p_name, ''));
  v_id   uuid;
  v_old  money_categories%ROWTYPE;
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF v_name = '' THEN
    RAISE EXCEPTION 'Type a name.';
  END IF;
  IF NOT money_category_name_ok(v_name) THEN
    RAISE EXCEPTION '"%" can''t be an expense category: courier and COD fees are in each order''s profit, weight and trip costs belong to the lot, and profit share, investor money, withdrawals and stock are not expenses.', v_name;
  END IF;
  IF EXISTS (SELECT 1 FROM money_categories WHERE lower(name) = lower(v_name) AND id IS DISTINCT FROM p_id) THEN
    RAISE EXCEPTION 'That category already exists.';
  END IF;
  IF p_id IS NULL THEN
    INSERT INTO money_categories (name, sort_order)
    VALUES (v_name, COALESCE((SELECT max(sort_order) FROM money_categories), 0) + 1)
    RETURNING id INTO v_id;
    PERFORM write_activity('money.category_add', 'money_category', v_id::text, v_name, format('Added the expense category "%s"', v_name), '{}'::jsonb);
    RETURN v_id;
  END IF;
  SELECT * INTO v_old FROM money_categories WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Category not found.';
  END IF;
  UPDATE money_categories SET name = v_name, archived = COALESCE(p_archived, false) WHERE id = p_id;
  PERFORM write_activity('money.category_edit', 'money_category', p_id::text, v_name,
    format('Changed the expense category "%s"', v_old.name), jsonb_build_object('before', to_jsonb(v_old)));
  RETURN p_id;
END;
$$;

REVOKE ALL ON FUNCTION money_save_category(uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION money_save_category(uuid, text, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION money_save_party(p_id uuid, p_name text, p_phone text, p_kind text, p_note text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text := btrim(COALESCE(p_name, ''));
  v_id   uuid;
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF v_name = '' THEN
    RAISE EXCEPTION 'Type a name.';
  END IF;
  IF p_kind NOT IN ('investor', 'other') THEN
    RAISE EXCEPTION 'Pick investor or other.';
  END IF;
  IF EXISTS (SELECT 1 FROM parties_payable WHERE kind = p_kind AND lower(btrim(name)) = lower(v_name) AND id IS DISTINCT FROM p_id) THEN
    RAISE EXCEPTION '"%" is already in the list.', v_name;
  END IF;
  IF p_id IS NULL THEN
    INSERT INTO parties_payable (name, phone, kind, note, created_by)
    VALUES (v_name, NULLIF(btrim(COALESCE(p_phone, '')), ''), p_kind, NULLIF(btrim(COALESCE(p_note, '')), ''), auth.uid())
    RETURNING id INTO v_id;
    PERFORM write_activity('money.party_add', 'party', v_id::text, v_name,
      format('Added %s "%s"', CASE WHEN p_kind = 'investor' THEN 'the investor' ELSE 'the person' END, v_name), '{}'::jsonb);
    RETURN v_id;
  END IF;
  UPDATE parties_payable
  SET name = v_name, phone = NULLIF(btrim(COALESCE(p_phone, '')), ''), kind = p_kind, note = NULLIF(btrim(COALESCE(p_note, '')), '')
  WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not found.';
  END IF;
  PERFORM write_activity('money.party_edit', 'party', p_id::text, v_name, format('Changed "%s"', v_name), '{}'::jsonb);
  RETURN p_id;
END;
$$;

REVOKE ALL ON FUNCTION money_save_party(uuid, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION money_save_party(uuid, text, text, text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- PART 5 — Steadfast payouts: choose once which account a payout landed in
-- (the screen offers the last account used).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION money_place_payout(p_payout_id uuid, p_account uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payout steadfast_payouts%ROWTYPE;
  v_acc    money_accounts%ROWTYPE;
  v_old    money_movements%ROWTYPE;
  v_id     uuid;
  v_date   date;
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  SELECT * INTO v_payout FROM steadfast_payouts WHERE id = p_payout_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payout not found.';
  END IF;
  IF v_payout.total_amount <= 0 THEN
    RAISE EXCEPTION 'This payout has no money in it.';
  END IF;
  v_date := (COALESCE(v_payout.paid_at, v_payout.first_synced_at) AT TIME ZONE 'Asia/Dhaka')::date;
  IF money_start_date() IS NOT NULL AND v_date < money_start_date() THEN
    RAISE EXCEPTION 'This payout is before your start date: it is part of the opening balances.';
  END IF;
  v_acc := money_check_account(p_account);

  SELECT * INTO v_old FROM money_movements WHERE payout_id = p_payout_id FOR UPDATE;
  IF FOUND THEN
    UPDATE money_movements SET account_id = v_acc.id, updated_at = now(), updated_by_username = current_actor_username()
    WHERE id = v_old.id;
    v_id := v_old.id;
    PERFORM write_activity('money.payout_place', 'money', v_id::text, 'Steadfast payout',
      format('Steadfast payout %s (%s) moved from %s to %s', money_short(v_payout.total_amount),
             to_char(v_date, 'DD Mon YYYY'), (SELECT name FROM money_accounts WHERE id = v_old.account_id), v_acc.name),
      jsonb_build_object('payout_id', p_payout_id));
  ELSE
    INSERT INTO money_movements (entry_date, account_id, amount, type, payout_id, reference, note, created_by, created_by_username)
    VALUES (v_date, v_acc.id, v_payout.total_amount, 'steadfast_payout_in', p_payout_id,
            v_payout.steadfast_payment_id, format('%s parcels', v_payout.parcel_count), auth.uid(), current_actor_username())
    RETURNING id INTO v_id;
    PERFORM write_activity('money.payout_place', 'money', v_id::text, 'Steadfast payout',
      format('Steadfast payout %s (%s) landed in %s', money_short(v_payout.total_amount), to_char(v_date, 'DD Mon YYYY'), v_acc.name),
      jsonb_build_object('payout_id', p_payout_id));
  END IF;
  UPDATE money_books SET last_payout_account_id = v_acc.id WHERE id = 1;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION money_place_payout(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION money_place_payout(uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- PART 6 — lots get payments ("Paid for this lot")
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION money_lot_landed(p_lot_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT round(COALESCE(sum(
    CASE WHEN li.buy_value_bdt > 0 THEN li.buy_value_bdt ELSE li.qty * li.unit_price_bdt END
    + (li.alloc_weight_paisa + li.alloc_other_paisa)::numeric / 100), 0), 2)
  FROM lot_items li WHERE li.lot_id = p_lot_id;
$$;

-- What is still owed for a lot. The opening stock and old lots with no
-- payment rows were paid before the start date (no invented debts).
CREATE OR REPLACE FUNCTION money_lot_owed(p_lot_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN l.kind = 'opening' THEN 0
    WHEN NOT EXISTS (SELECT 1 FROM money_movements m WHERE m.lot_id = l.id AND m.type = 'lot_payment')
         AND money_start_date() IS NOT NULL AND l.lot_date < money_start_date() THEN 0
    ELSE money_lot_landed(l.id)
         + COALESCE((SELECT sum(m.amount) FROM money_movements m WHERE m.lot_id = l.id AND m.type = 'lot_payment'), 0)
  END
  FROM lots l WHERE l.id = p_lot_id;
$$;

REVOKE ALL ON FUNCTION money_lot_landed(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION money_lot_owed(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION money_lot_payments(p_lot_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  RETURN jsonb_build_object(
    'landed', money_lot_landed(p_lot_id),
    'owed', money_lot_owed(p_lot_id),
    'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', m.id, 'account_id', m.account_id,
                         'account', a.name, 'amount', -m.amount, 'date', m.entry_date) ORDER BY m.entry_date, m.created_at)
                      FROM money_movements m JOIN money_accounts a ON a.id = m.account_id
                      WHERE m.lot_id = p_lot_id AND m.type = 'lot_payment'), '[]'::jsonb),
    'supplier_payments', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', m.id, 'account', a.name,
                         'amount', -m.amount, 'date', m.entry_date) ORDER BY m.entry_date, m.created_at)
                      FROM money_movements m JOIN money_accounts a ON a.id = m.account_id
                      WHERE m.lot_id = p_lot_id AND m.type = 'supplier_payment'), '[]'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION money_lot_payments(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION money_lot_payments(uuid) TO authenticated;

-- Replaces the lot's "Paid for this lot" rows: [{account_id, amount, date}].
CREATE OR REPLACE FUNCTION money_set_lot_payments(p_lot_id uuid, p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lot    lots%ROWTYPE;
  v_row    jsonb;
  v_amount numeric;
  v_date   date;
  v_before numeric;
  v_after  numeric;
  v_n      integer := 0;
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lot not found.';
  END IF;
  IF v_lot.kind = 'opening' THEN
    RAISE EXCEPTION 'The opening stock was paid before the start date.';
  END IF;
  IF jsonb_typeof(COALESCE(p_rows, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Bad payment rows.';
  END IF;
  SELECT COALESCE(-sum(amount), 0) INTO v_before FROM money_movements WHERE lot_id = p_lot_id AND type = 'lot_payment';
  DELETE FROM money_movements WHERE lot_id = p_lot_id AND type = 'lot_payment';
  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) LOOP
    v_amount := round((v_row ->> 'amount')::numeric, 2);
    v_date := COALESCE(NULLIF(v_row ->> 'date', '')::date, v_lot.lot_date);
    IF v_amount IS NULL OR v_amount <= 0 THEN
      RAISE EXCEPTION 'Each payment needs an amount above 0.';
    END IF;
    PERFORM money_check_entry_date(v_date);
    PERFORM money_check_account((v_row ->> 'account_id')::uuid);
    INSERT INTO money_movements (entry_date, account_id, amount, type, lot_id, supplier_id, reference, created_by, created_by_username)
    VALUES (v_date, (v_row ->> 'account_id')::uuid, -v_amount, 'lot_payment', p_lot_id, v_lot.supplier_id, v_lot.code,
            auth.uid(), current_actor_username());
    v_n := v_n + 1;
  END LOOP;
  SELECT COALESCE(-sum(amount), 0) INTO v_after FROM money_movements WHERE lot_id = p_lot_id AND type = 'lot_payment';
  IF v_after > money_lot_landed(p_lot_id) + 0.005 THEN
    RAISE EXCEPTION 'Paid (%) is more than the lot''s landed total (%).', money_short(v_after), money_short(money_lot_landed(p_lot_id));
  END IF;
  IF v_before <> v_after OR v_n > 0 THEN
    PERFORM write_activity('money.lot_payments', 'lot', p_lot_id::text, v_lot.code,
      format('%s: paid for this lot %s → %s (landed %s, still owed %s)', v_lot.code, money_short(v_before),
             money_short(v_after), money_short(money_lot_landed(p_lot_id)), money_short(money_lot_owed(p_lot_id))),
      jsonb_build_object('rows', p_rows));
  END IF;
  RETURN money_lot_payments(p_lot_id);
END;
$$;

REVOKE ALL ON FUNCTION money_set_lot_payments(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION money_set_lot_payments(uuid, jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- PART 7 — "To give": investors, suppliers, other people
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION money_to_give_rows()
RETURNS TABLE (kind text, id uuid, name text, owed numeric, capital_in numeric, capital_back numeric,
               share_month numeric, share_year numeric, share_all numeric, lots jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_today date := inventory_dhaka_today();
  v_month date := date_trunc('month', inventory_dhaka_today())::date;
  v_year  date := date_trunc('year', inventory_dhaka_today())::date;
  v_start date := money_start_date();
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  RETURN QUERY
  -- Investors: capital in (opening + money in) − capital returned.
  SELECT 'investor'::text, p.id, p.name,
         (ci.v - cb.v)::numeric, ci.v, cb.v, sm.v, sy.v, sa.v, '[]'::jsonb
  FROM parties_payable p
  CROSS JOIN LATERAL (SELECT
      COALESCE((SELECT sum(amount) FROM money_opening_payables o WHERE o.party_id = p.id), 0)
    + COALESCE((SELECT sum(amount) FROM money_movements m WHERE m.party_id = p.id AND m.type = 'investor_in'
                AND (v_start IS NULL OR m.entry_date >= v_start)), 0) AS v) ci
  CROSS JOIN LATERAL (SELECT COALESCE(-(SELECT sum(amount) FROM money_movements m WHERE m.party_id = p.id
                AND m.type = 'investor_capital_back' AND (v_start IS NULL OR m.entry_date >= v_start)), 0) AS v) cb
  CROSS JOIN LATERAL (SELECT COALESCE(-(SELECT sum(amount) FROM money_movements m WHERE m.party_id = p.id
                AND m.type = 'investor_profit_share' AND m.entry_date BETWEEN v_month AND v_today), 0) AS v) sm
  CROSS JOIN LATERAL (SELECT COALESCE(-(SELECT sum(amount) FROM money_movements m WHERE m.party_id = p.id
                AND m.type = 'investor_profit_share' AND m.entry_date BETWEEN v_year AND v_today), 0) AS v) sy
  CROSS JOIN LATERAL (SELECT COALESCE(-(SELECT sum(amount) FROM money_movements m WHERE m.party_id = p.id
                AND m.type = 'investor_profit_share' AND (v_start IS NULL OR m.entry_date >= v_start)), 0) AS v) sa
  WHERE p.kind = 'investor'
  UNION ALL
  -- Other people: opening payables − what was paid to them.
  SELECT 'other', p.id, p.name,
         COALESCE((SELECT sum(amount) FROM money_opening_payables o WHERE o.party_id = p.id), 0)
         + COALESCE((SELECT sum(amount) FROM money_movements m WHERE m.party_id = p.id AND m.type = 'supplier_payment'
                     AND (v_start IS NULL OR m.entry_date >= v_start)), 0),
         NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, '[]'::jsonb
  FROM parties_payable p
  WHERE p.kind = 'other'
  UNION ALL
  -- Suppliers: each lot's unpaid rest + opening payables − supplier payments.
  SELECT 'supplier', s.id, s.name,
         COALESCE((SELECT sum(money_lot_owed(l.id)) FROM lots l WHERE l.supplier_id = s.id), 0)
         + COALESCE((SELECT sum(amount) FROM money_opening_payables o WHERE o.supplier_id = s.id), 0)
         + COALESCE((SELECT sum(amount) FROM money_movements m WHERE m.supplier_id = s.id AND m.type = 'supplier_payment'
                     AND (v_start IS NULL OR m.entry_date >= v_start)), 0),
         NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('lot_id', l.id, 'code', l.code, 'owed', money_lot_owed(l.id))
                                    ORDER BY l.lot_date, l.code)
                   FROM lots l WHERE l.supplier_id = s.id AND money_lot_owed(l.id) <> 0), '[]'::jsonb)
  FROM suppliers s
  UNION ALL
  -- Lots with no supplier picked.
  SELECT 'supplier', NULL::uuid, 'No supplier picked',
         COALESCE((SELECT sum(money_lot_owed(l.id)) FROM lots l WHERE l.supplier_id IS NULL), 0),
         NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('lot_id', l.id, 'code', l.code, 'owed', money_lot_owed(l.id))
                                    ORDER BY l.lot_date, l.code)
                   FROM lots l WHERE l.supplier_id IS NULL AND money_lot_owed(l.id) <> 0), '[]'::jsonb)
  WHERE EXISTS (SELECT 1 FROM lots l WHERE l.supplier_id IS NULL AND money_lot_owed(l.id) <> 0);
END;
$$;

REVOKE ALL ON FUNCTION money_to_give_rows() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION money_to_give_rows() TO authenticated;

-- ---------------------------------------------------------------------------
-- PART 8 — customer dues, previous balances, due reminders
-- ---------------------------------------------------------------------------
-- Per customer: what site orders owe, the previous balance left, the latest
-- unpaid site order (for the reminder link), the last reminder.
CREATE OR REPLACE FUNCTION money_customer_dues()
RETURNS TABLE (customer_key text, phone_key text, order_due numeric, previous_left numeric,
               latest_unpaid_order_id uuid, latest_unpaid_order_number text,
               last_reminder_at timestamptz, last_reminder_amount numeric, reminders bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
  ), prev AS (
    SELECT d.phone_key, money_customer_key_for_phone(d.phone_key) AS customer_key, money_previous_left(d.phone_key) AS left_amount
    FROM (SELECT DISTINCT phone_key FROM customer_opening_dues) d
  ), keys AS (
    SELECT b.customer_key FROM by_order b
    UNION
    SELECT p.customer_key FROM prev p
  )
  SELECT ks.customer_key,
         COALESCE(b.pk, p.phone_key, CASE WHEN ks.customer_key LIKE 'ph:%' THEN substr(ks.customer_key, 4) END),
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
$$;

REVOKE ALL ON FUNCTION money_customer_dues() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION money_customer_dues() TO authenticated;

-- One customer's money history: previous balance lines, payments against
-- it, and the reminders sent.
CREATE OR REPLACE FUNCTION money_customer_history(p_customer_key text, p_phone text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pk text := bd_phone_key(p_phone);
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  RETURN jsonb_build_object(
    'phone_key', v_pk,
    'previous', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', d.id, 'amount', d.amount, 'at', d.created_at,
                    'choice', d.choice, 'kaarbar_amount', d.kaarbar_amount, 'site_due_then', d.site_due_then) ORDER BY d.created_at)
                  FROM customer_opening_dues d WHERE d.phone_key = v_pk), '[]'::jsonb),
    'previous_left', CASE WHEN v_pk IS NULL THEN 0 ELSE money_previous_left(v_pk) END,
    'payments', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'amount', p.amount, 'date', p.paid_date,
                    'account', a.name, 'note', p.note, 'by', p.created_by_username) ORDER BY p.paid_date, p.created_at)
                  FROM customer_due_payments p JOIN money_accounts a ON a.id = p.account_id WHERE p.phone_key = v_pk), '[]'::jsonb),
    'reminders', COALESCE((SELECT jsonb_agg(jsonb_build_object('at', r.created_at, 'amount', r.amount, 'how', r.how,
                    'by', r.created_by_username) ORDER BY r.created_at DESC)
                  FROM customer_due_reminders r WHERE r.customer_key = p_customer_key
                     OR (v_pk IS NOT NULL AND r.phone_key = v_pk)), '[]'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION money_customer_history(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION money_customer_history(text, text) TO authenticated;

CREATE OR REPLACE FUNCTION money_record_reminder(p_customer_key text, p_phone text, p_amount numeric, p_order_id uuid, p_how text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_customer_key IS NULL OR btrim(p_customer_key) = '' THEN
    RAISE EXCEPTION 'Customer not found.';
  END IF;
  IF p_how NOT IN ('whatsapp', 'copied') THEN
    RAISE EXCEPTION 'Unknown way of sending.';
  END IF;
  INSERT INTO customer_due_reminders (customer_key, phone_key, amount, order_id, how, created_by, created_by_username)
  VALUES (p_customer_key, bd_phone_key(p_phone), round(COALESCE(p_amount, 0), 2), p_order_id, p_how, auth.uid(), current_actor_username())
  RETURNING id INTO v_id;
  PERFORM write_activity('money.due_reminder', 'customer', p_customer_key, COALESCE(bd_phone_key(p_phone), p_customer_key),
    format('Due reminder %s, %s, %s', CASE WHEN p_how = 'whatsapp' THEN 'sent' ELSE 'copied' END,
           money_short(p_amount), to_char(inventory_dhaka_today(), 'DD Mon YYYY')),
    jsonb_build_object('amount', p_amount, 'order_id', p_order_id, 'how', p_how));
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION money_record_reminder(text, text, numeric, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION money_record_reminder(text, text, numeric, uuid, text) TO authenticated;

-- Money received against a previous balance.
CREATE OR REPLACE FUNCTION money_add_due_payment(p_phone text, p_amount numeric, p_account uuid, p_date date, p_note text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pk     text := bd_phone_key(p_phone);
  v_amount numeric := round(p_amount, 2);
  v_acc    money_accounts%ROWTYPE;
  v_id     uuid;
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF v_pk IS NULL THEN
    RAISE EXCEPTION 'This customer has no phone number.';
  END IF;
  IF v_amount IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION 'Type an amount above 0.';
  END IF;
  IF v_amount > money_previous_left(v_pk) + 0.005 THEN
    RAISE EXCEPTION 'The previous balance left is only %.', money_short(money_previous_left(v_pk));
  END IF;
  PERFORM money_check_entry_date(p_date);
  v_acc := money_check_account(p_account);
  INSERT INTO customer_due_payments (phone_key, amount, account_id, paid_date, note, created_by, created_by_username)
  VALUES (v_pk, v_amount, v_acc.id, p_date, NULLIF(btrim(COALESCE(p_note, '')), ''), auth.uid(), current_actor_username())
  RETURNING id INTO v_id;
  PERFORM write_activity('money.previous_paid', 'customer', money_customer_key_for_phone(v_pk), v_pk,
    format('Previous balance paid %s into %s, %s (left %s)', money_short(v_amount), v_acc.name,
           to_char(p_date, 'DD Mon YYYY'), money_short(money_previous_left(v_pk))),
    jsonb_build_object('amount', v_amount, 'account', v_acc.name));
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION money_add_due_payment(text, numeric, uuid, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION money_add_due_payment(text, numeric, uuid, date, text) TO authenticated;

-- Deleting a previous-balance payment (Careful actions: type the amount).
CREATE OR REPLACE FUNCTION money_delete_due_payment(p_id uuid, p_confirm_amount numeric)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old customer_due_payments%ROWTYPE;
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  SELECT * INTO v_old FROM customer_due_payments WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found.';
  END IF;
  IF p_confirm_amount IS NULL OR round(p_confirm_amount) <> round(v_old.amount) THEN
    RAISE EXCEPTION 'Type the amount (%) to confirm.', round(v_old.amount);
  END IF;
  DELETE FROM customer_due_payments WHERE id = p_id;
  PERFORM write_activity('money.previous_paid_delete', 'customer', money_customer_key_for_phone(v_old.phone_key), v_old.phone_key,
    format('Deleted a previous-balance payment of %s (%s)', money_short(v_old.amount), to_char(v_old.paid_date, 'DD Mon YYYY')),
    jsonb_build_object('deleted', to_jsonb(v_old)));
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION money_delete_due_payment(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION money_delete_due_payment(uuid, numeric) TO authenticated;

-- The customer's own "Previous balance" (one line, no details behind it).
CREATE OR REPLACE FUNCTION customer_previous_balance()
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT GREATEST(COALESCE(money_previous_left(bd_phone_key(p.phone)), 0), 0)
  FROM profiles p
  WHERE p.id = auth.uid() AND p.role = 'customer' AND bd_phone_key(p.phone) IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION customer_previous_balance() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION customer_previous_balance() TO authenticated;

-- ---------------------------------------------------------------------------
-- PART 9 — stock that leaves without a sale (write-offs)
-- ---------------------------------------------------------------------------
-- Takes p_units from the given lot rows (earliest expiry first, or one row)
-- as 'adjustment' movements at landed cost and records the write-off.
CREATE OR REPLACE FUNCTION money_write_off_units(
  p_product_id uuid, p_variant_id uuid, p_units integer, p_reason text, p_note text,
  p_lot_item_id uuid, p_order_id uuid, p_rows jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_need   integer := p_units;
  v_row    record;
  v_take   integer;
  v_cost   numeric := 0;
  v_lots   jsonb := '[]'::jsonb;
  v_label  text;
  v_unit   text;
  v_id     uuid := gen_random_uuid();
  v_ref    text;
  v_reason text := CASE p_reason
    WHEN 'expired' THEN 'Expired' WHEN 'damaged' THEN 'Damaged' WHEN 'gift' THEN 'Gift / sample'
    WHEN 'own_use' THEN 'Own use' WHEN 'lost' THEN 'Lost' WHEN 'count_difference' THEN 'Count difference'
    WHEN 'damaged_return' THEN 'Damaged return' END;
BEGIN
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'Pick a reason.';
  END IF;
  IF p_units IS NULL OR p_units <= 0 THEN
    RAISE EXCEPTION 'Type how many units.';
  END IF;
  SELECT p.name || COALESCE(' — ' || NULLIF(concat_ws(' · ', NULLIF(btrim(v.region), ''), NULLIF(btrim(v.size), '')), ''), '')
  INTO v_label
  FROM products p LEFT JOIN product_variants v ON v.id = p_variant_id
  WHERE p.id = p_product_id;
  v_unit := inventory_stock_unit(p_product_id, p_variant_id);
  v_ref := 'Write-off ' || left(v_id::text, 8);
  SELECT order_number INTO v_ref FROM orders WHERE id = p_order_id;
  v_ref := COALESCE(v_ref, 'Write-off ' || left(v_id::text, 8));

  FOR v_row IN
    SELECT li.id, li.qty_remaining, li.landed_unit_cost_bdt AS cost, l.code,
           COALESCE((r.value ->> 'units')::integer, li.qty_remaining) AS cap,
           COALESCE((r.value ->> 'unit_cost')::numeric, li.landed_unit_cost_bdt) AS use_cost,
           COALESCE(r.ordinality, 0) AS ord
    FROM lot_items li
    JOIN lots l ON l.id = li.lot_id
    LEFT JOIN LATERAL (
      SELECT x.value, x.ordinality FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) WITH ORDINALITY x
      WHERE (x.value ->> 'lot_item_id')::uuid = li.id LIMIT 1
    ) r ON true
    WHERE li.product_id = p_product_id
      AND li.variant_id IS NOT DISTINCT FROM p_variant_id
      AND li.qty_remaining > 0
      AND (p_lot_item_id IS NULL OR li.id = p_lot_item_id)
      AND (p_rows IS NULL OR r.value IS NOT NULL)
    ORDER BY COALESCE(r.ordinality, 0), li.expiry_date ASC NULLS LAST, l.lot_date ASC,
             (l.kind = 'opening') DESC, length(l.code), l.code, li.sort_order
    FOR UPDATE OF li
  LOOP
    EXIT WHEN v_need <= 0;
    v_take := LEAST(v_need, v_row.qty_remaining, v_row.cap);
    CONTINUE WHEN v_take <= 0;
    INSERT INTO stock_movements (lot_item_id, movement_type, qty, reference, reason, created_by)
    VALUES (v_row.id, 'adjustment', -v_take, v_ref,
            v_reason || COALESCE(': ' || NULLIF(btrim(COALESCE(p_note, '')), ''), ''), auth.uid());
    v_cost := v_cost + v_take * v_row.use_cost;
    v_lots := v_lots || jsonb_build_object('lot_item_id', v_row.id, 'code', v_row.code, 'units', v_take, 'unit_cost', v_row.use_cost);
    v_need := v_need - v_take;
  END LOOP;

  IF v_need > 0 THEN
    RAISE EXCEPTION 'Only % % of "%" are in lots%.', p_units - v_need, v_unit, COALESCE(v_label, 'this product'),
      CASE WHEN p_lot_item_id IS NOT NULL THEN ' (in the lot you picked)' ELSE '' END;
  END IF;

  INSERT INTO stock_write_offs (id, write_date, product_id, variant_id, label, units, reason, note, cost_bdt, order_id,
                                lots, created_by, created_by_username)
  VALUES (v_id, inventory_dhaka_today(), p_product_id, p_variant_id, COALESCE(v_label, ''), p_units, p_reason,
          NULLIF(btrim(COALESCE(p_note, '')), ''), round(v_cost, 2), p_order_id, v_lots, auth.uid(), current_actor_username());
  PERFORM write_activity('money.write_off', 'product', p_product_id::text, COALESCE(v_label, ''),
    format('Removed %s %s of %s (%s) — loss %s at landed cost (%s)', p_units, v_unit, COALESCE(v_label, ''), v_reason,
           money_short(v_cost), (SELECT string_agg(format('%s %s', x ->> 'units', x ->> 'code'), ', ') FROM jsonb_array_elements(v_lots) x)),
    jsonb_build_object('units', p_units, 'reason', p_reason, 'cost', round(v_cost, 2), 'lots', v_lots, 'order_id', p_order_id));
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION money_write_off_units(uuid, uuid, integer, text, text, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;

-- "Remove stock" on a product (only while Inventory mode is On).
CREATE OR REPLACE FUNCTION money_write_off(
  p_product_id uuid, p_variant_id uuid, p_units integer, p_reason text, p_note text DEFAULT NULL, p_lot_item_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF NOT inventory_mode_on() THEN
    RAISE EXCEPTION 'Remove stock works only while Inventory mode is On (stock then comes from lots).';
  END IF;
  IF p_reason NOT IN ('expired', 'damaged', 'gift', 'own_use', 'lost', 'count_difference') THEN
    RAISE EXCEPTION 'Pick a reason.';
  END IF;
  IF p_variant_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM product_variants WHERE id = p_variant_id AND product_id = p_product_id) THEN
    RAISE EXCEPTION 'Option not found.';
  END IF;
  v_id := money_write_off_units(p_product_id, p_variant_id, p_units, p_reason, p_note, p_lot_item_id, NULL, NULL);
  RETURN (SELECT to_jsonb(w) FROM stock_write_offs w WHERE w.id = v_id);
END;
$$;

REVOKE ALL ON FUNCTION money_write_off(uuid, uuid, integer, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION money_write_off(uuid, uuid, integer, text, text, uuid) TO authenticated;

-- "Mark returned" with damaged items: p_damaged = [{order_item_id, units}].
-- The order is returned exactly as before (its units go back to the lot
-- rows they came from); then the damaged units leave those same rows again
-- as a write-off at the cost the sale took — so they never go back in stock.
CREATE OR REPLACE FUNCTION admin_mark_order_returned_damaged(p_order_id uuid, p_note text, p_damaged jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_d     jsonb;
  v_item  order_items%ROWTYPE;
  v_units integer;
  v_rows  jsonb;
  v_back  integer;
BEGIN
  IF COALESCE(jsonb_array_length(COALESCE(p_damaged, '[]'::jsonb)), 0) > 0 THEN
    IF NOT money_can_view() THEN
      RAISE EXCEPTION 'Only someone with "View profit & costs" can mark items damaged.';
    END IF;
    IF NOT inventory_mode_on() THEN
      RAISE EXCEPTION 'Damaged returns work only while Inventory mode is On.';
    END IF;
  END IF;

  PERFORM admin_mark_order_returned(p_order_id, p_note);

  FOR v_d IN SELECT * FROM jsonb_array_elements(COALESCE(p_damaged, '[]'::jsonb)) LOOP
    v_units := (v_d ->> 'units')::integer;
    CONTINUE WHEN v_units IS NULL OR v_units <= 0;
    SELECT * INTO v_item FROM order_items WHERE id = (v_d ->> 'order_item_id')::uuid AND order_id = p_order_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Item not found on this order.';
    END IF;
    SELECT COALESCE(sum(g.units), 0)::integer,
           COALESCE(jsonb_agg(jsonb_build_object('lot_item_id', g.lot_item_id, 'units', g.units, 'unit_cost', g.unit_cost)
                              ORDER BY g.last_seq DESC), '[]'::jsonb)
    INTO v_back, v_rows
    FROM (
      SELECT lot_item_id, sum(units_back) AS units, sum(units_back * unit_cost_bdt) / sum(units_back) AS unit_cost,
             max(seq) AS last_seq
      FROM order_item_lots WHERE order_item_id = v_item.id AND units_back > 0
      GROUP BY lot_item_id
    ) g;
    v_units := v_units * inventory_item_factor(v_item);
    IF v_units > v_back THEN
      RAISE EXCEPTION '"%": only % units came back from lots.', v_item.product_name, v_back;
    END IF;
    PERFORM money_write_off_units(v_item.product_id, v_item.variant_id, v_units, 'damaged_return',
      NULLIF(btrim(COALESCE(p_note, '')), ''), NULL, p_order_id, v_rows);
  END LOOP;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION admin_mark_order_returned_damaged(uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_mark_order_returned_damaged(uuid, text, jsonb) TO authenticated;

-- ---------------------------------------------------------------------------
-- PART 10 — opening balances (one screen, used once)
-- ---------------------------------------------------------------------------
-- Preview of the Kaarbar dues file: [{phone, name, due}]. Nothing is saved.
CREATE OR REPLACE FUNCTION money_opening_preview(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_out jsonb;
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  WITH rows AS (
    SELECT x.ordinality AS n, bd_phone_key(x.value ->> 'phone') AS pk, btrim(COALESCE(x.value ->> 'name', '')) AS name,
           x.value ->> 'phone' AS phone, round(NULLIF(x.value ->> 'due', '')::numeric, 2) AS due
    FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) WITH ORDINALITY x
  ), dues AS (
    SELECT customer_key, sum(due) AS due FROM order_customer_keys() GROUP BY customer_key
  ), names AS (
    SELECT DISTINCT ON (bd_phone_key(o.customer_phone)) bd_phone_key(o.customer_phone) AS pk, o.customer_name
    FROM orders o WHERE bd_phone_key(o.customer_phone) IS NOT NULL ORDER BY bd_phone_key(o.customer_phone), o.created_at DESC
  )
  SELECT jsonb_build_object(
    'rows', COALESCE(jsonb_agg(jsonb_build_object(
       'n', r.n, 'phone', r.phone, 'phone_key', r.pk, 'name', r.name, 'due', r.due,
       'customer_key', CASE WHEN r.pk IS NOT NULL THEN money_customer_key_for_phone(r.pk) END,
       'known', r.pk IS NOT NULL AND (
          EXISTS (SELECT 1 FROM orders o WHERE bd_phone_key(o.customer_phone) = r.pk)
          OR EXISTS (SELECT 1 FROM customers c WHERE c.phone_key = r.pk)
          OR EXISTS (SELECT 1 FROM profiles p WHERE p.role = 'customer' AND bd_phone_key(p.phone) = r.pk)),
       'site_name', COALESCE((SELECT customer_name FROM names WHERE names.pk = r.pk),
                             (SELECT full_name FROM customers c WHERE c.phone_key = r.pk LIMIT 1)),
       'site_due', CASE WHEN r.pk IS NOT NULL THEN COALESCE((SELECT due FROM dues WHERE dues.customer_key = money_customer_key_for_phone(r.pk)), 0) ELSE 0 END,
       'previous_already', CASE WHEN r.pk IS NOT NULL THEN money_previous_left(r.pk) ELSE 0 END,
       'problem', CASE
          WHEN r.pk IS NULL OR r.pk !~ '^01[0-9]{9}$' THEN 'Phone number not valid'
          WHEN r.due IS NULL THEN 'Due amount missing'
          WHEN r.due <= 0 THEN 'Due must be above 0'
          WHEN (SELECT count(*) FROM rows r2 WHERE r2.pk = r.pk) > 1 THEN 'Same phone twice in the file'
        END) ORDER BY r.n), '[]'::jsonb),
    'site_total_due', COALESCE((SELECT sum(due) FROM dues), 0))
  INTO v_out FROM rows r;
  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION money_opening_preview(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION money_opening_preview(jsonb) TO authenticated;

-- What the books started with (live, from the stored opening rows): the
-- accounts, Steadfast, customer dues on the start date, stock, minus what
-- was owed.
CREATE OR REPLACE FUNCTION money_opening_net_worth()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start   date := money_start_date();
  v_ts      timestamptz := money_start_ts();
  v_acc     numeric;
  v_prev    numeric;
  v_stock   numeric;
  v_orders  numeric;
  v_pay     numeric;
BEGIN
  IF v_start IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(sum(amount), 0) INTO v_acc FROM money_movements WHERE type = 'opening_balance';
  SELECT COALESCE(sum(amount), 0) INTO v_prev FROM customer_opening_dues;
  SELECT COALESCE(round(sum(li.qty * li.landed_unit_cost_bdt), 2), 0) INTO v_stock
  FROM lot_items li JOIN lots l ON l.id = li.lot_id
  WHERE l.kind = 'opening' OR l.lot_date < v_start;
  -- Site orders placed before the start date: what they were owed then.
  -- An order whose stock was taken from lots (it was still on the shelf,
  -- counted in the opening stock) was not owed yet — it is a sale when
  -- delivered.
  SELECT COALESCE(sum(
           CASE WHEN money_order_status_at(o.id, v_ts) IN ('cancelled', 'returned') OR money_order_costed(o.id) THEN 0
                ELSE o.total END
           - COALESCE((SELECT sum(CASE WHEN p.kind = 'refund' THEN -p.amount ELSE p.amount END)
                       FROM order_payments p WHERE p.order_id = o.id AND p.paid_at < v_ts), 0)), 0)
  INTO v_orders
  FROM orders o WHERE o.created_at < v_ts;
  SELECT COALESCE(sum(amount), 0) INTO v_pay FROM money_opening_payables;
  RETURN jsonb_build_object('accounts', v_acc, 'previous_balances', v_prev, 'stock', v_stock,
                            'site_orders', v_orders, 'payables', v_pay,
                            'total', v_acc + v_prev + v_stock + v_orders - v_pay);
END;
$$;

REVOKE ALL ON FUNCTION money_opening_net_worth() FROM PUBLIC, anon, authenticated;

-- Confirm the opening balances (once). p_accounts [{account_id, amount}],
-- p_dues [{phone, name, due, choice: keep_site | kaarbar | both}],
-- p_payables [{kind: investor|supplier|other, name, phone, amount, note}].
CREATE OR REPLACE FUNCTION money_confirm_opening(p_start date, p_accounts jsonb, p_dues jsonb, p_payables jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_books    money_books%ROWTYPE;
  v_opening  date;
  v_row      jsonb;
  v_amount   numeric;
  v_pk       text;
  v_key      text;
  v_site     numeric;
  v_choice   text;
  v_party    uuid;
  v_supplier uuid;
  v_kind     text;
  v_name     text;
  v_sf       numeric;
  v_n_acc    integer := 0;
  v_n_dues   integer := 0;
  v_n_new    integer := 0;
  v_n_pay    integer := 0;
  v_sum_dues numeric := 0;
  v_sum_pay  numeric := 0;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Only the Super Admin can confirm the opening balances.';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('money_opening'));
  SELECT * INTO v_books FROM money_books WHERE id = 1 FOR UPDATE;
  IF v_books.confirmed_at IS NOT NULL THEN
    RAISE EXCEPTION 'The opening balances were already confirmed on %.', to_char(v_books.start_date, 'DD Mon YYYY');
  END IF;
  IF p_start IS NULL THEN
    RAISE EXCEPTION 'Pick the start date.';
  END IF;
  IF p_start > inventory_dhaka_today() THEN
    RAISE EXCEPTION 'The start date can''t be in the future.';
  END IF;
  SELECT lot_date INTO v_opening FROM lots WHERE kind = 'opening' LIMIT 1;
  IF v_opening IS NOT NULL AND v_opening <> p_start THEN
    RAISE EXCEPTION 'The start date must be the opening stock''s date (L-000: %).', to_char(v_opening, 'DD Mon YYYY');
  END IF;

  -- Accounts (as counted on the start date).
  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(p_accounts, '[]'::jsonb)) LOOP
    v_amount := round(NULLIF(v_row ->> 'amount', '')::numeric, 2);
    CONTINUE WHEN v_amount IS NULL OR v_amount = 0;
    PERFORM money_check_account((v_row ->> 'account_id')::uuid);
    INSERT INTO money_movements (entry_date, account_id, amount, type, note, created_by, created_by_username)
    VALUES (p_start, (v_row ->> 'account_id')::uuid, v_amount, 'opening_balance', 'Counted on the start date',
            auth.uid(), current_actor_username());
    v_n_acc := v_n_acc + 1;
  END LOOP;

  -- "With Steadfast": Steadfast's own balance.
  SELECT COALESCE(current_balance, 0) INTO v_sf FROM steadfast_sync_state WHERE id = 1;
  v_sf := COALESCE(v_sf, 0);
  IF v_sf <> 0 THEN
    INSERT INTO money_movements (entry_date, account_id, amount, type, note, created_by, created_by_username)
    VALUES (p_start, money_steadfast_account(), v_sf, 'opening_balance', 'Steadfast''s balance on the start date',
            auth.uid(), current_actor_username());
  END IF;

  -- Customer dues from Kaarbar.
  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(p_dues, '[]'::jsonb)) LOOP
    v_pk := bd_phone_key(v_row ->> 'phone');
    v_amount := round(NULLIF(v_row ->> 'due', '')::numeric, 2);
    v_choice := COALESCE(v_row ->> 'choice', 'kaarbar');
    IF v_pk IS NULL OR v_pk !~ '^01[0-9]{9}$' OR v_amount IS NULL OR v_amount <= 0 THEN
      RAISE EXCEPTION 'Row with phone "%" is not valid. Fix the file and preview again.', COALESCE(v_row ->> 'phone', '');
    END IF;
    IF v_choice NOT IN ('keep_site', 'kaarbar', 'both') THEN
      RAISE EXCEPTION 'Pick what to do with the due of %.', v_pk;
    END IF;
    v_key := money_customer_key_for_phone(v_pk);
    SELECT COALESCE(sum(due), 0) INTO v_site FROM order_customer_keys() WHERE customer_key = v_key;
    CONTINUE WHEN v_choice = 'keep_site' AND v_site > 0;
    -- "Use the Kaarbar due": Kaarbar's number is the whole due, so the site
    -- orders' own due is taken off it (those orders are in both places).
    IF v_choice = 'kaarbar' AND v_site > 0 THEN
      v_amount := v_amount - v_site;
    END IF;
    CONTINUE WHEN v_amount <= 0;
    -- A new customer is added to the Customers list.
    IF NOT EXISTS (SELECT 1 FROM orders o WHERE bd_phone_key(o.customer_phone) = v_pk)
       AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.phone_key = v_pk)
       AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.role = 'customer' AND bd_phone_key(p.phone) = v_pk) THEN
      INSERT INTO customers (customer_key, phone_key, full_name, phone, note, added_by_hand, created_by, created_by_username)
      VALUES ('ph:' || v_pk, v_pk, COALESCE(NULLIF(btrim(v_row ->> 'name'), ''), v_pk), v_pk,
              'Added from the opening dues (Kaarbar)', true, auth.uid(), current_actor_username())
      ON CONFLICT (customer_key) DO NOTHING;
      v_n_new := v_n_new + 1;
    END IF;
    INSERT INTO customer_opening_dues (phone_key, full_name, phone, amount, choice, kaarbar_amount, site_due_then, created_by_username)
    VALUES (v_pk, COALESCE(btrim(v_row ->> 'name'), ''), COALESCE(v_row ->> 'phone', ''), v_amount,
            CASE WHEN v_choice = 'both' AND v_site > 0 THEN 'added'
                 WHEN v_choice = 'kaarbar' AND v_site > 0 THEN 'kaarbar_minus_site' ELSE 'kaarbar' END,
            round(NULLIF(v_row ->> 'due', '')::numeric, 2), v_site, current_actor_username());
    v_n_dues := v_n_dues + 1;
    v_sum_dues := v_sum_dues + v_amount;
  END LOOP;

  -- What I owe.
  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(p_payables, '[]'::jsonb)) LOOP
    v_amount := round(NULLIF(v_row ->> 'amount', '')::numeric, 2);
    v_kind := v_row ->> 'kind';
    v_name := btrim(COALESCE(v_row ->> 'name', ''));
    CONTINUE WHEN v_amount IS NULL OR v_amount <= 0;
    IF v_name = '' THEN
      RAISE EXCEPTION 'Each row of "What I owe" needs a name.';
    END IF;
    v_party := NULL;
    v_supplier := NULL;
    IF v_kind = 'supplier' THEN
      SELECT id INTO v_supplier FROM suppliers WHERE lower(btrim(name)) = lower(v_name) LIMIT 1;
      IF v_supplier IS NULL THEN
        INSERT INTO suppliers (name, created_by) VALUES (v_name, auth.uid()) RETURNING id INTO v_supplier;
      END IF;
    ELSIF v_kind IN ('investor', 'other') THEN
      SELECT id INTO v_party FROM parties_payable WHERE kind = v_kind AND lower(btrim(name)) = lower(v_name) LIMIT 1;
      IF v_party IS NULL THEN
        INSERT INTO parties_payable (name, phone, kind, created_by)
        VALUES (v_name, NULLIF(btrim(COALESCE(v_row ->> 'phone', '')), ''), v_kind, auth.uid())
        RETURNING id INTO v_party;
      END IF;
    ELSE
      RAISE EXCEPTION 'Pick investor, supplier or other for "%".', v_name;
    END IF;
    INSERT INTO money_opening_payables (party_id, supplier_id, amount, note, created_by_username)
    VALUES (v_party, v_supplier, v_amount, NULLIF(btrim(COALESCE(v_row ->> 'note', '')), ''), current_actor_username());
    v_n_pay := v_n_pay + 1;
    v_sum_pay := v_sum_pay + v_amount;
  END LOOP;

  UPDATE money_books
  SET start_date = p_start, confirmed_at = now(), confirmed_by_username = current_actor_username(), opening_steadfast = v_sf
  WHERE id = 1;

  PERFORM write_activity('money.opening_confirm', 'money_books', '1', 'Opening balances',
    format('Confirmed the opening balances for %s: %s accounts, Steadfast %s, %s customer dues (%s, %s new customers), %s owed (%s)',
           to_char(p_start, 'DD Mon YYYY'), v_n_acc, money_short(v_sf), v_n_dues, money_short(v_sum_dues), v_n_new,
           v_n_pay, money_short(v_sum_pay)),
    jsonb_build_object('start', p_start, 'accounts', p_accounts, 'dues', v_n_dues, 'dues_total', v_sum_dues,
                       'payables', p_payables, 'steadfast', v_sf));
  RETURN jsonb_build_object('start', p_start, 'accounts', v_n_acc, 'steadfast', v_sf, 'dues', v_n_dues,
                            'dues_total', v_sum_dues, 'new_customers', v_n_new, 'payables', v_n_pay, 'payables_total', v_sum_pay);
END;
$$;

REVOKE ALL ON FUNCTION money_confirm_opening(date, jsonb, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION money_confirm_opening(date, jsonb, jsonb, jsonb) TO authenticated;

-- Undo the opening (Careful actions + the Safety Lock open). Customers
-- added from the file stay in the list; payments against previous balances
-- must be deleted first.
CREATE OR REPLACE FUNCTION money_undo_opening(p_confirm text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_books money_books%ROWTYPE;
  v_n     integer;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Only the Super Admin can undo the opening balances.';
  END IF;
  IF admin_delete_lock_until() IS NULL THEN
    RAISE EXCEPTION 'Open the Safety Lock first (Settings → Safety Locks).';
  END IF;
  IF upper(btrim(COALESCE(p_confirm, ''))) <> 'UNDO' THEN
    RAISE EXCEPTION 'Type UNDO to confirm.';
  END IF;
  SELECT * INTO v_books FROM money_books WHERE id = 1 FOR UPDATE;
  IF v_books.confirmed_at IS NULL THEN
    RAISE EXCEPTION 'The opening balances are not confirmed.';
  END IF;
  SELECT count(*) INTO v_n FROM customer_due_payments;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'There are % payments against previous balances. Delete them first.', v_n;
  END IF;
  DELETE FROM money_movements WHERE type = 'opening_balance';
  DELETE FROM customer_opening_dues;
  DELETE FROM money_opening_payables;
  DELETE FROM money_check_log;
  UPDATE money_books SET start_date = NULL, confirmed_at = NULL, confirmed_by_username = NULL, opening_steadfast = NULL WHERE id = 1;
  PERFORM write_activity('money.opening_undo', 'money_books', '1', 'Opening balances',
    format('Undid the opening balances of %s', to_char(v_books.start_date, 'DD Mon YYYY')), to_jsonb(v_books));
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION money_undo_opening(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION money_undo_opening(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- PART 11 — the Money page
-- ---------------------------------------------------------------------------
-- Net profit for dates (Batch 39 sales profit + this batch's parts).
CREATE OR REPLACE FUNCTION money_profit_parts(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sales    jsonb;
  v_exp      numeric;
  v_wo       numeric;
  v_share    numeric;
  v_with     numeric;
  v_own_in   numeric;
  v_nb       numeric;
  v_adj      numeric;
  v_net      numeric;
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  v_sales := inventory_sales_profit(p_from, p_to) -> 'totals';
  SELECT COALESCE(-sum(amount) FILTER (WHERE type = 'expense'), 0),
         COALESCE(-sum(amount) FILTER (WHERE type = 'investor_profit_share'), 0),
         COALESCE(-sum(amount) FILTER (WHERE type = 'owner_withdrawal'), 0),
         COALESCE(sum(amount) FILTER (WHERE type = 'owner_money_in'), 0),
         COALESCE(sum(amount) FILTER (WHERE type IN ('non_business_in', 'non_business_out')), 0),
         COALESCE(sum(amount) FILTER (WHERE type = 'adjustment'), 0)
  INTO v_exp, v_share, v_with, v_own_in, v_nb, v_adj
  FROM money_movements
  WHERE entry_date BETWEEN p_from AND p_to
    AND (money_start_date() IS NULL OR entry_date >= money_start_date());
  SELECT COALESCE(sum(cost_bdt), 0) INTO v_wo FROM stock_write_offs WHERE write_date BETWEEN p_from AND p_to;
  v_net := (v_sales ->> 'sales')::numeric - (v_sales ->> 'cost')::numeric + (v_sales ->> 'delivery')::numeric
           - (v_sales ->> 'courier')::numeric - (v_sales ->> 'adjustments')::numeric - v_exp - v_wo;
  RETURN jsonb_build_object(
    'from', p_from, 'to', p_to,
    'orders', (v_sales ->> 'orders')::integer, 'uncosted_orders', (v_sales ->> 'uncosted_orders')::integer,
    'sales', (v_sales ->> 'sales')::numeric, 'cost', (v_sales ->> 'cost')::numeric,
    'provisional', (v_sales ->> 'provisional')::numeric,
    'delivery', (v_sales ->> 'delivery')::numeric, 'courier', (v_sales ->> 'courier')::numeric,
    'cost_adjustments', (v_sales ->> 'adjustments')::numeric,
    'expenses', v_exp, 'write_offs', v_wo, 'net_profit', v_net,
    'profit_share', v_share, 'your_profit', v_net - v_share,
    'withdrawals', v_with, 'left_in_business', v_net - v_share - v_with,
    'owner_money_in', v_own_in, 'not_shop_money', v_nb, 'count_differences', v_adj);
END;
$$;

REVOKE ALL ON FUNCTION money_profit_parts(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION money_profit_parts(date, date) TO authenticated;

-- What the business has and owes right now, and the balance check:
--   has − owes  =  opening net worth + net profit − investor profit share
--                  − my withdrawals + my money put in ± not-shop money
--                  ± count differences ± orders outside profit
-- (all since the start date).
CREATE OR REPLACE FUNCTION money_position()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start     date := money_start_date();
  v_ts        timestamptz := money_start_ts();
  v_today     date := inventory_dhaka_today();
  v_accounts  jsonb;
  v_acc_sum   numeric;
  v_sf        numeric;
  v_recv      numeric;
  v_adv       numeric;
  v_prev      numeric;
  v_stock     numeric;
  v_goods     numeric;
  v_open_val  numeric;
  v_short     numeric;
  v_give      numeric;
  v_give_inv  numeric;
  v_give_sup  numeric;
  v_give_oth  numeric;
  v_have      numeric;
  v_owe       numeric;
  v_open      jsonb;
  v_parts     jsonb;
  v_outside   numeric := 0;
  v_out_orders numeric := 0;
  v_out_fees  numeric := 0;
  v_out_unm   numeric := 0;
  v_rhs       numeric;
  v_diff      numeric;
  v_first     date;
  v_last_ok   date;
  v_sf_reported numeric;
  v_sf_at     timestamptz;
  v_unplaced  jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('account_id', b.account_id, 'name', b.name, 'kind', b.kind,
                    'archived', b.archived, 'balance', b.balance)), '[]'::jsonb),
         COALESCE(sum(b.balance) FILTER (WHERE b.kind <> 'steadfast'), 0),
         COALESCE(sum(b.balance) FILTER (WHERE b.kind = 'steadfast'), 0)
  INTO v_accounts, v_acc_sum, v_sf
  FROM money_account_balances() b;

  -- Customers (per order: owed − paid; Cancelled / Returned owe nothing).
  WITH per AS (
    SELECT o.id, o.status, o.total, money_order_costed(o.id) AS costed,
           (CASE WHEN o.status IN ('cancelled', 'returned') THEN 0 ELSE o.total END)
           - COALESCE((SELECT sum(CASE WHEN p.kind = 'refund' THEN -p.amount ELSE p.amount END)
                       FROM order_payments p WHERE p.order_id = o.id), 0) AS r
    FROM orders o
  )
  SELECT COALESCE(sum(GREATEST(r, 0)), 0), COALESCE(sum(GREATEST(-r, 0)), 0),
         COALESCE(sum(total) FILTER (WHERE costed AND status IN ('pending', 'confirmed', 'shipped')), 0)
  INTO v_recv, v_adv, v_open_val
  FROM per;

  SELECT COALESCE(sum(amount), 0) INTO v_prev FROM customer_opening_dues;
  v_prev := v_prev - COALESCE((SELECT sum(amount) FROM customer_due_payments), 0);

  SELECT COALESCE(round(sum(qty_remaining * landed_unit_cost_bdt), 2), 0) INTO v_stock FROM lot_items;

  -- Goods on orders not delivered yet (taken from lots, at their cost).
  SELECT COALESCE(round(sum((x.units - x.units_back) * x.unit_cost_bdt), 2), 0) INTO v_goods
  FROM order_item_lots x JOIN orders o ON o.id = x.order_id
  WHERE o.status IN ('pending', 'confirmed', 'shipped');

  -- Sold without stock (counted in profit at a provisional cost, not yet
  -- taken from any lot).
  SELECT COALESCE(round(sum(s.units * s.provisional_unit_cost_bdt), 2), 0) INTO v_short
  FROM stock_shortfalls s JOIN orders o ON o.id = s.order_id
  WHERE s.status = 'open' AND o.status = 'delivered';

  SELECT COALESCE(sum(owed) FILTER (WHERE kind = 'investor'), 0),
         COALESCE(sum(owed) FILTER (WHERE kind = 'supplier'), 0),
         COALESCE(sum(owed) FILTER (WHERE kind = 'other'), 0)
  INTO v_give_inv, v_give_sup, v_give_oth
  FROM money_to_give_rows();
  v_give := v_give_inv + v_give_sup + v_give_oth;

  v_have := v_acc_sum + v_sf + v_recv + v_prev + v_stock + v_goods;
  v_owe := v_give + v_adv + v_open_val + v_short;

  SELECT current_balance, balance_at INTO v_sf_reported, v_sf_at FROM steadfast_sync_state WHERE id = 1;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('payout_id', p.id, 'paid_at', p.paid_at, 'amount', p.total_amount,
                    'parcels', p.parcel_count) ORDER BY p.paid_at), '[]'::jsonb)
  INTO v_unplaced
  FROM steadfast_payouts p
  WHERE p.total_amount > 0
    AND NOT EXISTS (SELECT 1 FROM money_movements m WHERE m.payout_id = p.id)
    AND (v_start IS NULL OR p.paid_at >= v_ts);

  IF v_start IS NOT NULL THEN
    v_open := money_opening_net_worth();
    v_parts := money_profit_parts(v_start, v_today);
    -- Orders outside profit (no lot cost: placed before Inventory mode):
    -- what changed on them since the start date, and what Steadfast kept on
    -- them; parcels that match no order.
    SELECT COALESCE(sum(
             (CASE WHEN o.status IN ('cancelled', 'returned') THEN 0 ELSE o.total END)
             - CASE WHEN o.created_at >= v_ts OR money_order_status_at(o.id, v_ts) IN ('cancelled', 'returned') THEN 0
                    ELSE o.total END), 0)
    INTO v_out_orders
    FROM orders o
    WHERE NOT money_order_costed(o.id);
    SELECT COALESCE(sum(l.amount) FILTER (WHERE l.type = 'courier_fees' AND NOT money_order_costed(l.order_id)), 0),
           COALESCE(sum(l.amount) FILTER (WHERE l.type = 'steadfast_unmatched'), 0)
    INTO v_out_fees, v_out_unm
    FROM money_ledger l WHERE l.type IN ('courier_fees', 'steadfast_unmatched');
    v_outside := v_out_orders + v_out_fees + v_out_unm;

    v_rhs := (v_open ->> 'total')::numeric + (v_parts ->> 'net_profit')::numeric
             - (v_parts ->> 'profit_share')::numeric - (v_parts ->> 'withdrawals')::numeric
             + (v_parts ->> 'owner_money_in')::numeric + (v_parts ->> 'not_shop_money')::numeric
             + (v_parts ->> 'count_differences')::numeric + v_outside;
    v_diff := round((v_have - v_owe) - v_rhs, 2);

    INSERT INTO money_check_log (check_date, difference, checked_at) VALUES (v_today, v_diff, now())
    ON CONFLICT (check_date) DO UPDATE SET difference = EXCLUDED.difference, checked_at = now();
    IF abs(v_diff) > 1 THEN
      SELECT max(check_date) INTO v_last_ok FROM money_check_log WHERE abs(difference) <= 1 AND check_date < v_today;
      SELECT min(check_date) INTO v_first FROM money_check_log
      WHERE abs(difference) > 1 AND (v_last_ok IS NULL OR check_date > v_last_ok);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'start_date', v_start,
    'accounts', v_accounts,
    'accounts_total', v_acc_sum,
    'with_steadfast', v_sf,
    'steadfast_reported', v_sf_reported,
    'steadfast_reported_at', v_sf_at,
    'unplaced_payouts', v_unplaced,
    'to_receive', v_recv,
    'previous_balances', v_prev,
    'customer_advances', v_adv,
    'stock_value', v_stock,
    'goods_on_open_orders', v_goods,
    'open_orders_value', v_open_val,
    'sold_without_stock', v_short,
    'to_give', v_give,
    'to_give_investors', v_give_inv,
    'to_give_suppliers', v_give_sup,
    'to_give_others', v_give_oth,
    'have', v_have,
    'owe', v_owe,
    'net_worth', v_have - v_owe,
    'opening', v_open,
    'since_start', v_parts,
    'outside_orders', v_out_orders,
    'outside_fees', v_out_fees,
    'outside_unmatched', v_out_unm,
    'outside', v_outside,
    'expected', v_rhs,
    'difference', v_diff,
    'balanced', CASE WHEN v_start IS NULL THEN NULL ELSE abs(v_diff) <= 1 END,
    'first_wrong', v_first);
END;
$$;

REVOKE ALL ON FUNCTION money_position() FROM PUBLIC, anon, authenticated;

-- The Money page: profit for the period, the money now, the balance check
-- and the return on money in the business.
CREATE OR REPLACE FUNCTION money_summary(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start    date := money_start_date();
  v_today    date := inventory_dhaka_today();
  v_profit   jsonb;
  v_pos      jsonb;
  v_cats     jsonb;
  v_avg      numeric;
  v_begin    numeric;
  v_end      numeric;
  v_to       date;
  v_before   jsonb;
  v_upto     jsonb;
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION 'Pick a date range.';
  END IF;
  v_profit := money_profit_parts(p_from, p_to);
  v_pos := money_position();

  SELECT COALESCE(jsonb_agg(jsonb_build_object('category_id', c.id, 'name', c.name, 'amount', x.amount) ORDER BY x.amount DESC), '[]'::jsonb)
  INTO v_cats
  FROM (
    SELECT m.category_id, -sum(m.amount) AS amount
    FROM money_movements m
    WHERE m.type = 'expense' AND m.entry_date BETWEEN p_from AND p_to
      AND (v_start IS NULL OR m.entry_date >= v_start)
    GROUP BY m.category_id
  ) x JOIN money_categories c ON c.id = x.category_id;

  -- Return on money in the business: net profit ÷ the average of the money
  -- in the business at the start and at the end of the period (worked out
  -- from the opening and everything since; equal to "has − owes" when the
  -- books balance).
  IF v_start IS NOT NULL THEN
    v_to := LEAST(p_to, v_today);
    IF p_from <= v_start THEN
      v_begin := (v_pos -> 'opening' ->> 'total')::numeric;
    ELSE
      v_before := money_profit_parts(v_start, p_from - 1);
      v_begin := (v_pos -> 'opening' ->> 'total')::numeric + (v_before ->> 'net_profit')::numeric
                 - (v_before ->> 'profit_share')::numeric - (v_before ->> 'withdrawals')::numeric
                 + (v_before ->> 'owner_money_in')::numeric + (v_before ->> 'not_shop_money')::numeric
                 + (v_before ->> 'count_differences')::numeric;
    END IF;
    IF v_to >= v_today THEN
      v_end := (v_pos ->> 'net_worth')::numeric;
    ELSE
      v_upto := money_profit_parts(v_start, v_to);
      v_end := (v_pos -> 'opening' ->> 'total')::numeric + (v_upto ->> 'net_profit')::numeric
               - (v_upto ->> 'profit_share')::numeric - (v_upto ->> 'withdrawals')::numeric
               + (v_upto ->> 'owner_money_in')::numeric + (v_upto ->> 'not_shop_money')::numeric
               + (v_upto ->> 'count_differences')::numeric;
    END IF;
    v_avg := round((v_begin + v_end) / 2, 2);
  END IF;

  RETURN jsonb_build_object(
    'profit', v_profit,
    'expenses_by_category', v_cats,
    'position', v_pos,
    'roi', jsonb_build_object('average_money', v_avg, 'begin', v_begin, 'end', v_end,
                              'percent', CASE WHEN v_avg > 0 THEN round((v_profit ->> 'net_profit')::numeric / v_avg * 100, 1) END),
    'last_payout_account_id', (SELECT last_payout_account_id FROM money_books WHERE id = 1),
    'confirmed', v_start IS NOT NULL,
    'inventory_mode', inventory_mode_on());
END;
$$;

REVOKE ALL ON FUNCTION money_summary(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION money_summary(date, date) TO authenticated;

-- ---------------------------------------------------------------------------
-- PART 12 — bill photos (private bucket; small, compressed in the browser)
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('money-bills', 'money-bills', false, 204800, ARRAY['image/webp', 'image/jpeg'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS money_bills_insert ON storage.objects;
CREATE POLICY money_bills_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'money-bills' AND public.money_can_add());
DROP POLICY IF EXISTS money_bills_read ON storage.objects;
CREATE POLICY money_bills_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'money-bills' AND public.money_can_view());
DROP POLICY IF EXISTS money_bills_delete ON storage.objects;
CREATE POLICY money_bills_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'money-bills' AND public.money_can_view());

COMMIT;

-- Tell the API about the new tables and functions straight away.
NOTIFY pgrst, 'reload schema';
