-- ============================================================
-- Migration 060 — Batch 60: My Wallet (the "store wallet")
-- ============================================================
-- (The number 059 is kept for Batch 59.)
--
-- A customer can keep money with the shop and spend it on any order.
-- In the code it is the "store wallet" (store_wallet_*), never "wallet":
-- the checkout already calls bKash / Nagad its "wallet" choice.
--
-- THE MONEY RULES
--  * A wallet balance is money the business OWES the customer (customer
--    deposits). It is never a sale and never profit. Profit still counts
--    only when an order is delivered (Batch 58's one profit engine is not
--    touched).
--  * store_wallet_entries is the wallet's ledger: one row per change.
--    Balance = the sum of a customer's rows. Nobody writes a row
--    directly; only the functions below do.
--  * Money ADDED (a confirmed "I sent money" request, or Naeem's "Add to
--    wallet") goes INTO an account (it shows in money_ledger like a
--    previous-balance payment), and "Customer wallets" under To give goes
--    up by the same amount: net worth unchanged.
--  * Money USED on an order is an order payment of method 'store_wallet'.
--    It moves NO money (money_ledger leaves it out: the cash came in when
--    it was added). The order's due goes down and the wallet goes down by
--    the same amount: net worth unchanged.
--  * Whenever an order has been paid MORE than it asks (cancelled,
--    returned, edited down, or simply over-paid), the extra goes into the
--    wallet automatically: the wallet part first ('order_back'), the rest
--    as 'overpaid'. Batch 58's "credit" is therefore the wallet now. If the
--    order later asks more again (reopened, edited up, a refund recorded),
--    that money is taken back from the wallet, as far as the balance
--    allows.
--  * Advance-payment discount: only when the part paid in advance by
--    bKash / Nagad for this order is ৳1,000 or more; money from the wallet
--    never earns it. Old orders keep what they were placed with.
--
-- Nothing here needs a signed-in user. Safe to run more than once.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------------
-- 1. Tables
-- ------------------------------------------------------------------

-- A customer's "I sent money" request (bKash / Nagad), waiting for Naeem.
CREATE TABLE IF NOT EXISTS store_wallet_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_key        text NOT NULL,
  profile_id          uuid REFERENCES profiles(id) ON DELETE SET NULL,
  customer_name       text,
  amount              numeric(12,2) NOT NULL CHECK (amount >= 500 AND amount <= 10000000),
  method              text NOT NULL CHECK (method IN ('bkash', 'nagad')),
  trx_id              text NOT NULL CHECK (trx_id ~ '^[A-Z0-9]{6,20}$'),
  sender              text NOT NULL CHECK (sender ~ '^01[3-9][0-9]{8}$'),
  status              text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'confirmed', 'rejected')),
  reject_reason       text CHECK (reject_reason IS NULL OR char_length(reject_reason) <= 300),
  account_id          uuid REFERENCES money_accounts(id),
  decided_by          uuid,
  decided_by_username text,
  decided_at          timestamptz,
  -- The customer has seen the answer (the "added" toast, or dismissed the
  -- "couldn't confirm" line).
  seen_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS store_wallet_requests_trx ON store_wallet_requests (upper(trx_id));
CREATE INDEX IF NOT EXISTS store_wallet_requests_key ON store_wallet_requests (customer_key);
CREATE INDEX IF NOT EXISTS store_wallet_requests_waiting ON store_wallet_requests (created_at) WHERE status = 'waiting';
ALTER TABLE store_wallet_requests ENABLE ROW LEVEL SECURITY;

-- The wallet's ledger. Balance = sum(amount) of a customer's rows.
CREATE TABLE IF NOT EXISTS store_wallet_entries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_key        text NOT NULL,
  amount              numeric(12,2) NOT NULL CHECK (amount <> 0),
  kind                text NOT NULL CHECK (kind IN ('added', 'order', 'order_back', 'overpaid', 'correction')),
  -- 'added': the account the money came into.
  account_id          uuid REFERENCES money_accounts(id),
  request_id          uuid REFERENCES store_wallet_requests(id) ON DELETE SET NULL,
  -- 'order' / 'order_back' / 'overpaid': the order (its number is kept
  -- for the history if the order is ever deleted) and the order payment
  -- row that mirrors this entry.
  order_id            uuid REFERENCES orders(id) ON DELETE SET NULL,
  order_number        text,
  payment_id          uuid REFERENCES order_payments(id) ON DELETE SET NULL,
  entry_date          date NOT NULL,
  note                text,
  created_by          uuid,
  created_by_username text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_wallet_entries_added_account CHECK ((kind = 'added') = (account_id IS NOT NULL)),
  CONSTRAINT store_wallet_entries_added_positive CHECK (kind <> 'added' OR amount > 0)
);
CREATE INDEX IF NOT EXISTS store_wallet_entries_key ON store_wallet_entries (customer_key);
CREATE INDEX IF NOT EXISTS store_wallet_entries_order ON store_wallet_entries (order_id);
ALTER TABLE store_wallet_entries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON store_wallet_requests FROM anon, authenticated;
REVOKE ALL ON store_wallet_entries FROM anon, authenticated;
GRANT SELECT, INSERT ON store_wallet_requests TO authenticated;
GRANT SELECT ON store_wallet_entries TO authenticated;
GRANT ALL ON store_wallet_requests TO service_role;
GRANT ALL ON store_wallet_entries TO service_role;

-- Order payments: the wallet is a payment method that moves no money.
ALTER TABLE order_payments DROP CONSTRAINT IF EXISTS order_payments_method_check;
ALTER TABLE order_payments ADD CONSTRAINT order_payments_method_check
  CHECK (method = ANY (ARRAY['bkash', 'nagad', 'cash', 'bank', 'cod_steadfast', 'other', 'store_wallet']));
ALTER TABLE order_payments DROP CONSTRAINT IF EXISTS order_payments_source_check;
ALTER TABLE order_payments ADD CONSTRAINT order_payments_source_check
  CHECK (source = ANY (ARRAY['manual', 'mark_paid', 'status_paid', 'steadfast_cod', 'store_wallet']));

-- ------------------------------------------------------------------
-- 2. Who a wallet belongs to
-- ------------------------------------------------------------------

-- The customer key a stored key belongs to today: a phone key follows the
-- number to its customer (a later sign-up, or a Batch 55 merge).
CREATE OR REPLACE FUNCTION store_wallet_owner(p_key text)
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT CASE WHEN p_key LIKE 'ph:%' THEN money_customer_key_for_phone(substr(p_key, 4)) ELSE p_key END;
$function$;

CREATE OR REPLACE FUNCTION store_wallet_balance(p_key text)
RETURNS numeric
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(sum(e.amount), 0)::numeric
  FROM store_wallet_entries e
  WHERE p_key IS NOT NULL AND store_wallet_owner(e.customer_key) = store_wallet_owner(p_key);
$function$;

-- The signed-in customer's key (the key their own orders have). Staff,
-- wholesalers and visitors have no wallet.
CREATE OR REPLACE FUNCTION store_wallet_my_key()
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT 'p:' || p.id FROM profiles p WHERE p.id = auth.uid() AND p.role = 'customer';
$function$;

CREATE OR REPLACE FUNCTION store_wallet_order_key(p_order_id uuid)
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT k.customer_key FROM order_customer_keys() k WHERE k.order_id = p_order_id;
$function$;

-- One lock per customer, so two orders can never spend the same taka.
CREATE OR REPLACE FUNCTION store_wallet_lock(p_key text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT pg_advisory_xact_lock(hashtext('store_wallet:' || COALESCE(store_wallet_owner(p_key), '')));
$function$;

-- A transaction ID already used by a wallet request or an order payment.
CREATE OR REPLACE FUNCTION store_wallet_trx_used(p_trx text, p_except uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (SELECT 1 FROM store_wallet_requests r
                 WHERE upper(r.trx_id) = upper(btrim(p_trx)) AND r.id IS DISTINCT FROM p_except)
      OR EXISTS (SELECT 1 FROM order_payments p WHERE upper(btrim(p.trx_id)) = upper(btrim(p_trx)))
      OR EXISTS (SELECT 1 FROM orders o WHERE upper(btrim(o.bkash_trx_id)) = upper(btrim(p_trx)));
$function$;

-- ------------------------------------------------------------------
-- 3. RLS
-- ------------------------------------------------------------------

DROP POLICY IF EXISTS store_wallet_requests_read ON store_wallet_requests;
CREATE POLICY store_wallet_requests_read ON store_wallet_requests
  FOR SELECT USING (profile_id = auth.uid() OR money_can_view());

-- A customer may send a request only for themselves, only waiting, at
-- least ৳500 (the trigger below checks the transaction ID and fills the
-- rest). store_wallet_request() is the normal way in.
DROP POLICY IF EXISTS store_wallet_requests_insert ON store_wallet_requests;
CREATE POLICY store_wallet_requests_insert ON store_wallet_requests
  FOR INSERT WITH CHECK (
    profile_id = auth.uid()
    AND customer_key = 'p:' || auth.uid()::text
    AND EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'customer')
    AND status = 'waiting' AND amount >= 500
    AND reject_reason IS NULL AND account_id IS NULL AND decided_by IS NULL
    AND decided_by_username IS NULL AND decided_at IS NULL AND seen_at IS NULL);

DROP POLICY IF EXISTS store_wallet_entries_read ON store_wallet_entries;
CREATE POLICY store_wallet_entries_read ON store_wallet_entries
  FOR SELECT USING (customer_key = 'p:' || auth.uid()::text OR money_can_view());

-- Requests: tidy and check before saving (also for a direct insert).
CREATE OR REPLACE FUNCTION store_wallet_request_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  NEW.trx_id := upper(regexp_replace(COALESCE(NEW.trx_id, ''), '\s', '', 'g'));
  NEW.sender := bd_phone_key(NEW.sender);
  NEW.created_at := now();
  IF NEW.trx_id = '' THEN
    RAISE EXCEPTION 'Transaction ID is required';
  END IF;
  IF NEW.trx_id !~ '^[A-Z0-9]{6,20}$' THEN
    RAISE EXCEPTION 'Enter a valid transaction ID';
  END IF;
  IF NEW.sender IS NULL OR NEW.sender !~ '^01[3-9][0-9]{8}$' THEN
    RAISE EXCEPTION 'Enter a valid number';
  END IF;
  IF NEW.amount IS NULL OR NEW.amount < 500 THEN
    RAISE EXCEPTION 'Minimum ৳500';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('store_wallet_trx:' || NEW.trx_id));
  IF store_wallet_trx_used(NEW.trx_id, NEW.id) THEN
    RAISE EXCEPTION 'This transaction ID has already been used.';
  END IF;
  IF NEW.customer_name IS NULL AND NEW.profile_id IS NOT NULL THEN
    SELECT NULLIF(btrim(p.full_name), '') INTO NEW.customer_name FROM profiles p WHERE p.id = NEW.profile_id;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS store_wallet_request_check ON store_wallet_requests;
CREATE TRIGGER store_wallet_request_check BEFORE INSERT ON store_wallet_requests
  FOR EACH ROW EXECUTE FUNCTION store_wallet_request_check();

-- ------------------------------------------------------------------
-- 4. Moving wallet money onto / off an order (internal)
-- ------------------------------------------------------------------

-- One move: an order payment of method 'store_wallet' (kind 'payment' =
-- wallet → order, 'refund' = order → wallet) and its mirror entry. No
-- money moves between accounts.
CREATE OR REPLACE FUNCTION store_wallet_move(p_order_id uuid, p_key text, p_pay_kind text, p_amount numeric,
                                             p_entry_kind text, p_text text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_order orders%ROWTYPE;
  v_amt   numeric(12,2) := round(p_amount, 2);
  v_pid   uuid;
BEGIN
  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND OR v_amt IS NULL OR v_amt < 0.01 THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('app.store_wallet_sync', 'on', true);
  INSERT INTO order_payments (order_id, kind, amount, method, paid_at, note, source, created_by, created_by_username)
  VALUES (p_order_id, p_pay_kind, v_amt, 'store_wallet', now(), p_text, 'store_wallet', auth.uid(), current_actor_username())
  RETURNING id INTO v_pid;
  INSERT INTO store_wallet_entries (customer_key, amount, kind, order_id, order_number, payment_id, entry_date, note,
                                    created_by, created_by_username)
  VALUES (p_key, CASE WHEN p_pay_kind = 'payment' THEN -v_amt ELSE v_amt END, p_entry_kind, p_order_id,
          v_order.order_number, v_pid, money_dhaka_date(now()), p_text, auth.uid(), current_actor_username());
  PERFORM set_config('app.store_wallet_sync', 'off', true);
  PERFORM order_history_line(p_order_id, v_order.status, p_text);
  PERFORM order_payments_sync(p_order_id);
  RETURN v_pid;
END;
$function$;

-- Keeps an order and the wallet in step: money paid above what the order
-- asks goes into the wallet (the wallet part first, then the rest as
-- "overpaid"); if the order asks more again, it is taken back from the
-- wallet as far as the balance allows.
CREATE OR REPLACE FUNCTION store_wallet_sync_order(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_order  orders%ROWTYPE;
  v_basis  numeric;
  v_excess numeric;
  v_key    text;
  v_on     numeric;
  v_over   numeric;
  v_backs  numeric;
  v_back   numeric;
  v_rest   numeric;
  v_bal    numeric;
  v_take   numeric;
BEGIN
  IF COALESCE(current_setting('app.store_wallet_sync', true), '') = 'on' THEN
    RETURN;
  END IF;
  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  v_basis := CASE WHEN v_order.status IN ('cancelled', 'returned') THEN 0 ELSE v_order.total END;
  v_excess := round(order_payment_net(p_order_id) - v_basis, 2);
  IF abs(v_excess) < 0.01 THEN
    RETURN;
  END IF;
  SELECT COALESCE(-sum(e.amount) FILTER (WHERE e.kind IN ('order', 'order_back')), 0),
         COALESCE(sum(e.amount) FILTER (WHERE e.kind = 'overpaid'), 0),
         COALESCE(sum(e.amount) FILTER (WHERE e.kind = 'order_back'), 0)
  INTO v_on, v_over, v_backs
  FROM store_wallet_entries e WHERE e.order_id = p_order_id;

  IF v_excess > 0 THEN
    v_key := store_wallet_order_key(p_order_id);
    IF v_key IS NULL THEN
      RETURN;
    END IF;
    PERFORM store_wallet_lock(v_key);
    v_back := LEAST(v_excess, GREATEST(v_on, 0));
    v_rest := v_excess - v_back;
    IF v_back >= 0.01 THEN
      PERFORM store_wallet_move(p_order_id, v_key, 'refund', v_back, 'order_back',
        taka_text(v_back) || ' went back to the customer''s wallet');
    END IF;
    IF v_rest >= 0.01 THEN
      PERFORM store_wallet_move(p_order_id, v_key, 'refund', v_rest, 'overpaid',
        taka_text(v_rest) || ' paid above the total went to the customer''s wallet');
    END IF;
    RETURN;
  END IF;

  -- The order asks more than was paid. Only money this order once put in
  -- the wallet is taken back.
  IF v_over < 0.01 AND v_backs < 0.01 THEN
    RETURN;
  END IF;
  v_key := store_wallet_order_key(p_order_id);
  IF v_key IS NULL THEN
    RETURN;
  END IF;
  PERFORM store_wallet_lock(v_key);
  v_bal := GREATEST(store_wallet_balance(v_key), 0);
  v_rest := -v_excess;
  v_take := LEAST(v_rest, GREATEST(v_over, 0), v_bal);
  IF v_take >= 0.01 THEN
    PERFORM store_wallet_move(p_order_id, v_key, 'payment', v_take, 'overpaid',
      taka_text(v_take) || ' taken back from the customer''s wallet');
    v_rest := v_rest - v_take;
    v_bal := v_bal - v_take;
  END IF;
  v_take := LEAST(v_rest, GREATEST(v_backs, 0), v_bal);
  IF v_take >= 0.01 THEN
    PERFORM store_wallet_move(p_order_id, v_key, 'payment', v_take, 'order_back',
      'Paid ' || taka_text(v_take) || ' from the customer''s wallet again');
    v_rest := v_rest - v_take;
  END IF;
  IF v_rest >= 0.01 AND v_order.status IN ('cancelled', 'returned') THEN
    RAISE EXCEPTION 'This order''s money went into the customer''s wallet and % of it is already used, so it can''t be refunded.',
      taka_text(round(v_rest, 2));
  END IF;
END;
$function$;

-- Takes wallet money onto an order (checkout and admin): up to the
-- balance and up to what the order still owes. Returns what was taken.
CREATE OR REPLACE FUNCTION store_wallet_take(p_order_id uuid, p_amount numeric, p_key text)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_order orders%ROWTYPE;
  v_due   numeric;
  v_take  numeric;
BEGIN
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;
  IF v_order.status IN ('cancelled', 'returned') THEN
    RAISE EXCEPTION 'This order is %: nothing to pay.', v_order.status;
  END IF;
  PERFORM store_wallet_lock(p_key);
  v_due := GREATEST(v_order.total - order_payment_net(p_order_id), 0);
  v_take := round(LEAST(GREATEST(COALESCE(p_amount, 0), 0), GREATEST(store_wallet_balance(p_key), 0), v_due), 2);
  IF v_take < 0.01 THEN
    RETURN 0;
  END IF;
  PERFORM store_wallet_move(p_order_id, p_key, 'payment', v_take, 'order',
    'Paid ' || taka_text(v_take) || ' from the customer''s wallet');
  RETURN v_take;
END;
$function$;

REVOKE ALL ON FUNCTION store_wallet_move(uuid, text, text, numeric, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION store_wallet_sync_order(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION store_wallet_take(uuid, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION store_wallet_lock(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION store_wallet_owner(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION store_wallet_balance(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION store_wallet_order_key(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION store_wallet_trx_used(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION store_wallet_my_key() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION store_wallet_owner(text) TO authenticated;
GRANT EXECUTE ON FUNCTION store_wallet_my_key() TO authenticated;

-- ------------------------------------------------------------------
-- 5. Triggers that keep orders and wallets in step
-- ------------------------------------------------------------------

-- Order payments: wallet rows are written only by store_wallet_move. A
-- wallet payment (money used on an order) may be deleted by the Super
-- Admin: the money goes back to the wallet. Wallet refund rows and edits
-- are refused: cancel or edit the order instead.
CREATE OR REPLACE FUNCTION store_wallet_payment_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_entry store_wallet_entries%ROWTYPE;
BEGIN
  IF COALESCE(current_setting('app.store_wallet_sync', true), '') = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.method = 'store_wallet' OR NEW.source = 'store_wallet' THEN
      RAISE EXCEPTION 'Wallet money is put on an order with "Use wallet balance".';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.method = 'store_wallet' OR NEW.method = 'store_wallet' THEN
      RAISE EXCEPTION 'A wallet payment can''t be changed. Edit or cancel the order instead.';
    END IF;
    RETURN NEW;
  END IF;
  -- DELETE
  IF OLD.method <> 'store_wallet' THEN
    RETURN OLD;
  END IF;
  -- The whole order is being deleted (store_wallet_order_deleted already
  -- settled the wallet).
  IF NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = OLD.order_id)
     OR COALESCE(current_setting('app.store_wallet_deleting', true), '') = OLD.order_id::text THEN
    RETURN OLD;
  END IF;
  IF OLD.kind = 'refund' THEN
    RAISE EXCEPTION 'This money is in the customer''s wallet. Edit the order instead.';
  END IF;
  SELECT * INTO v_entry FROM store_wallet_entries WHERE payment_id = OLD.id;
  IF FOUND THEN
    INSERT INTO store_wallet_entries (customer_key, amount, kind, order_id, order_number, entry_date, note,
                                      created_by, created_by_username)
    VALUES (v_entry.customer_key, -v_entry.amount, v_entry.kind, v_entry.order_id, v_entry.order_number,
            money_dhaka_date(now()), 'Wallet payment deleted: ' || taka_text(OLD.amount) || ' back to the wallet',
            auth.uid(), current_actor_username());
  END IF;
  RETURN OLD;
END;
$function$;

DROP TRIGGER IF EXISTS store_wallet_payment_guard ON order_payments;
CREATE TRIGGER store_wallet_payment_guard BEFORE INSERT OR UPDATE OR DELETE ON order_payments
  FOR EACH ROW EXECUTE FUNCTION store_wallet_payment_guard();

CREATE OR REPLACE FUNCTION store_wallet_payment_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(current_setting('app.store_wallet_sync', true), '') = 'on' THEN
    RETURN NULL;
  END IF;
  PERFORM store_wallet_sync_order(COALESCE(NEW.order_id, OLD.order_id));
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS store_wallet_payment_changed ON order_payments;
CREATE TRIGGER store_wallet_payment_changed AFTER INSERT OR UPDATE OR DELETE ON order_payments
  FOR EACH ROW EXECUTE FUNCTION store_wallet_payment_changed();

-- An order cancelled, returned, reopened or edited.
CREATE OR REPLACE FUNCTION store_wallet_order_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM store_wallet_sync_order(NEW.id);
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS store_wallet_order_changed ON orders;
CREATE TRIGGER store_wallet_order_changed AFTER UPDATE OF status, total ON orders
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.total IS DISTINCT FROM NEW.total)
  EXECUTE FUNCTION store_wallet_order_changed();

-- An order deleted (Super Admin + Safety Lock): the wallet money on it
-- goes back to the wallet, and money that went into the wallet from it
-- comes out again (its payments are deleted with it).
CREATE OR REPLACE FUNCTION store_wallet_order_deleted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_key  text;
  v_on   numeric;
  v_over numeric;
BEGIN
  SELECT COALESCE(-sum(e.amount) FILTER (WHERE e.kind IN ('order', 'order_back')), 0),
         COALESCE(sum(e.amount) FILTER (WHERE e.kind = 'overpaid'), 0),
         (array_agg(e.customer_key ORDER BY e.created_at DESC))[1]
  INTO v_on, v_over, v_key
  FROM store_wallet_entries e WHERE e.order_id = OLD.id;
  PERFORM set_config('app.store_wallet_deleting', OLD.id::text, true);
  IF v_key IS NULL THEN
    RETURN OLD;
  END IF;
  PERFORM store_wallet_lock(v_key);
  IF v_over >= 0.01 AND store_wallet_balance(v_key) + GREATEST(v_on, 0) < v_over - 0.005 THEN
    RAISE EXCEPTION '% from order % went into the customer''s wallet and is already used, so the order can''t be deleted.',
      taka_text(v_over), OLD.order_number;
  END IF;
  IF abs(v_on) >= 0.01 THEN
    INSERT INTO store_wallet_entries (customer_key, amount, kind, order_id, order_number, entry_date, note,
                                      created_by, created_by_username)
    VALUES (v_key, v_on, 'order_back', OLD.id, OLD.order_number, money_dhaka_date(now()),
            'Order ' || OLD.order_number || ' deleted', auth.uid(), current_actor_username());
  END IF;
  IF abs(v_over) >= 0.01 THEN
    INSERT INTO store_wallet_entries (customer_key, amount, kind, order_id, order_number, entry_date, note,
                                      created_by, created_by_username)
    VALUES (v_key, -v_over, 'overpaid', OLD.id, OLD.order_number, money_dhaka_date(now()),
            'Order ' || OLD.order_number || ' deleted', auth.uid(), current_actor_username());
  END IF;
  RETURN OLD;
END;
$function$;

DROP TRIGGER IF EXISTS store_wallet_order_deleted ON orders;
CREATE TRIGGER store_wallet_order_deleted BEFORE DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION store_wallet_order_deleted();

-- Batch 55 merge: the removed customer's wallet moves to the kept one
-- (phone keys follow their number by themselves).
CREATE OR REPLACE FUNCTION store_wallet_customer_merged()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.kind = 'merge' AND NEW.removed_key IS DISTINCT FROM NEW.kept_key THEN
    UPDATE store_wallet_entries SET customer_key = NEW.kept_key WHERE customer_key = NEW.removed_key;
    UPDATE store_wallet_requests SET customer_key = NEW.kept_key WHERE customer_key = NEW.removed_key;
  END IF;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS store_wallet_customer_merged ON customer_merges;
CREATE TRIGGER store_wallet_customer_merged AFTER INSERT ON customer_merges
  FOR EACH ROW EXECUTE FUNCTION store_wallet_customer_merged();

-- A customer with wallet money can't be deleted (hide them instead). The
-- check sits in admin_delete_customer (a trigger on customers would also
-- stop Batch 55's merge, which deletes the removed customer's row).
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
  -- Batch 60: wallet money is owed to them.
  IF EXISTS (SELECT 1 FROM store_wallet_entries e
             WHERE e.customer_key = p_customer_key OR store_wallet_owner(e.customer_key) = store_wallet_owner(p_customer_key))
     OR EXISTS (SELECT 1 FROM store_wallet_requests r WHERE r.customer_key = p_customer_key) THEN
    RAISE EXCEPTION 'This customer has a wallet. Hide them instead.';
  END IF;
  DELETE FROM customers WHERE customers.customer_key = p_customer_key;
  DELETE FROM customer_phones WHERE customer_phones.customer_key = p_customer_key;
  PERFORM write_activity('customer.deleted', 'customer', p_customer_key, v_row.full_name,
    format('Deleted customer %s (%s)', v_row.full_name, v_row.phone), '{}'::jsonb);
  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION store_wallet_request_check() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION store_wallet_payment_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION store_wallet_payment_changed() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION store_wallet_order_changed() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION store_wallet_order_deleted() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION store_wallet_customer_merged() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------------
-- 6. Existing functions that learn about the wallet
-- ------------------------------------------------------------------

-- A bKash / Nagad order still waiting for its advance to be checked stays
-- "pending verification" when part of it was paid from the wallet.
CREATE OR REPLACE FUNCTION order_payments_sync(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_order orders%ROWTYPE;
  v_net   numeric;
  v_real  numeric;
  v_new   text;
BEGIN
  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  v_net := order_payment_net(p_order_id);
  SELECT COALESCE(sum(CASE WHEN kind = 'refund' THEN -amount ELSE amount END), 0) INTO v_real
  FROM order_payments WHERE order_id = p_order_id AND method <> 'store_wallet';
  v_new := CASE
    WHEN v_net > 0 AND v_net >= v_order.total THEN 'paid'
    WHEN v_order.payment_status = 'pending_verification' AND v_real <= 0 THEN 'pending_verification'
    ELSE 'unpaid'
  END;
  IF v_new IS DISTINCT FROM v_order.payment_status THEN
    PERFORM set_config('app.payments_sync', 'on', true);
    UPDATE orders SET payment_status = v_new, updated_at = now() WHERE id = p_order_id;
    PERFORM set_config('app.payments_sync', 'off', true);
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION payment_method_label(p_method text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT CASE p_method
    WHEN 'bkash' THEN 'bKash'
    WHEN 'nagad' THEN 'Nagad'
    WHEN 'cash' THEN 'Cash'
    WHEN 'bank' THEN 'Bank'
    WHEN 'cod_steadfast' THEN 'COD via Steadfast'
    WHEN 'store_wallet' THEN 'Wallet'
    ELSE 'Other'
  END;
$function$;

CREATE OR REPLACE FUNCTION money_type_label(p_type text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $function$
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
    WHEN 'courier_bill_payment' THEN 'Steadfast bill paid'
    WHEN 'customer_payment' THEN 'Customer payment'
    WHEN 'customer_refund' THEN 'Refund to customer'
    WHEN 'previous_balance_payment' THEN 'Previous balance paid'
    WHEN 'store_wallet_in' THEN 'Added to a customer wallet'
    WHEN 'steadfast_payout_out' THEN 'Paid out by Steadfast'
    WHEN 'courier_fees' THEN 'Courier & COD fees (in order profit)'
    WHEN 'steadfast_unmatched' THEN 'Steadfast parcel not matched to an order'
    WHEN 'steadfast_courier_only' THEN 'Courier only, not a shop sale'
    ELSE p_type
  END;
$function$;

-- The account ledger: wallet payments on orders move no money; money
-- added to a wallet comes into its account.
CREATE OR REPLACE VIEW money_ledger AS
 SELECT source,
    source_id,
    entry_date,
    account_id,
    amount,
    type,
    category_id,
    party_id,
    supplier_id,
    lot_id,
    order_id,
    payout_id,
    note,
    reference,
    created_by_username,
    created_at
   FROM ( SELECT 'movement'::text AS source,
            (m.id)::text AS source_id,
            m.entry_date,
            m.account_id,
            m.amount,
            m.type,
            m.category_id,
            m.party_id,
            m.supplier_id,
            m.lot_id,
            m.order_id,
            m.payout_id,
            m.note,
            m.reference,
            m.created_by_username,
            m.created_at
           FROM money_movements m
          WHERE ((money_start_date() IS NULL) OR (m.entry_date >= money_start_date()))
        UNION ALL
         SELECT 'payout_out'::text AS text,
            (m.id)::text AS id,
            m.entry_date,
            money_steadfast_account() AS money_steadfast_account,
            (- m.amount),
            'steadfast_payout_out'::text AS text,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            m.payout_id,
            m.note,
            m.reference,
            m.created_by_username,
            m.created_at
           FROM money_movements m
          WHERE ((m.type = 'steadfast_payout_in'::text) AND ((money_start_date() IS NULL) OR (m.entry_date >= money_start_date())))
        UNION ALL
         SELECT 'payment'::text AS text,
            (p.id)::text AS id,
            ((p.paid_at AT TIME ZONE 'Asia/Dhaka'::text))::date AS timezone,
            money_account_for_method(p.method) AS money_account_for_method,
                CASE
                    WHEN (p.kind = 'refund'::text) THEN (- p.amount)
                    ELSE p.amount
                END AS amount,
                CASE
                    WHEN (p.kind = 'refund'::text) THEN 'customer_refund'::text
                    ELSE 'customer_payment'::text
                END AS "case",
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            p.order_id,
            NULL::uuid AS uuid,
            p.note,
            o.order_number,
            p.created_by_username,
            p.created_at
           FROM (order_payments p
             JOIN orders o ON ((o.id = p.order_id)))
          WHERE (p.method <> 'store_wallet'::text) AND ((money_start_date() IS NULL) OR (p.paid_at >= money_start_ts()))
        UNION ALL
         SELECT 'due_payment'::text AS text,
            (d.id)::text AS id,
            d.paid_date,
            d.account_id,
            d.amount,
            'previous_balance_payment'::text AS text,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            d.note,
            d.phone_key,
            d.created_by_username,
            d.created_at
           FROM customer_due_payments d
          WHERE ((money_start_date() IS NULL) OR (d.paid_date >= money_start_date()))
        UNION ALL
         SELECT 'store_wallet'::text AS text,
            (w.id)::text AS id,
            w.entry_date,
            w.account_id,
            w.amount,
            'store_wallet_in'::text AS text,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            w.note,
            customer_name_for_key(store_wallet_owner(w.customer_key)) AS reference,
            w.created_by_username,
            w.created_at
           FROM store_wallet_entries w
          WHERE (w.kind = 'added'::text) AND (w.account_id IS NOT NULL)
            AND ((money_start_date() IS NULL) OR (w.entry_date >= money_start_date()))
        UNION ALL
         SELECT 'payout_fees'::text AS text,
            (i.id)::text AS id,
            ((sp.paid_at AT TIME ZONE 'Asia/Dhaka'::text))::date AS timezone,
            money_steadfast_account() AS money_steadfast_account,
            (- ((i.delivery_charge + i.cod_fee) + i.other_deduction)),
            'courier_fees'::text AS text,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            i.order_id,
            sp.id,
            NULL::text AS text,
            o.order_number,
            'steadfast'::text AS text,
            sp.last_synced_at
           FROM ((steadfast_payout_items i
             JOIN steadfast_payouts sp ON ((sp.id = i.payout_id)))
             JOIN orders o ON ((o.id = i.order_id)))
          WHERE ((((i.delivery_charge + i.cod_fee) + i.other_deduction) <> (0)::numeric) AND ((money_start_date() IS NULL) OR ((sp.paid_at >= money_start_ts()) AND (COALESCE(( SELECT max(h.changed_at) AS max
                   FROM order_status_history h
                  WHERE ((h.order_id = o.id) AND (h.new_status = ANY (ARRAY['delivered'::text, 'returned'::text])))), o.created_at) >= money_start_ts()))))
        UNION ALL
         SELECT 'payout_unmatched'::text AS text,
            (i.id)::text AS id,
            ((sp.paid_at AT TIME ZONE 'Asia/Dhaka'::text))::date AS timezone,
            money_steadfast_account() AS money_steadfast_account,
            i.net_paid,
            'steadfast_unmatched'::text AS text,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            sp.id,
            COALESCE(i.invoice, i.consignment_id) AS "coalesce",
            NULL::text AS text,
            'steadfast'::text AS text,
            sp.last_synced_at
           FROM (steadfast_payout_items i
             JOIN steadfast_payouts sp ON ((sp.id = i.payout_id)))
          WHERE ((i.order_id IS NULL) AND (i.line_kind = 'order'::text) AND (i.net_paid <> (0)::numeric) AND (money_start_date() IS NOT NULL) AND (sp.paid_at >= money_start_ts()))
        UNION ALL
         SELECT 'payout_settled'::text AS text,
            (i.id)::text AS id,
            ((sp.paid_at AT TIME ZONE 'Asia/Dhaka'::text))::date AS timezone,
            money_steadfast_account() AS money_steadfast_account,
                CASE
                    WHEN (i.line_kind = 'returned'::text) THEN (- ((i.delivery_charge + i.cod_fee) + i.other_deduction))
                    ELSE i.net_paid
                END AS amount,
                CASE
                    WHEN (i.line_kind = 'returned'::text) THEN 'courier_fees'::text
                    ELSE 'steadfast_courier_only'::text
                END AS "case",
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            NULL::uuid AS uuid,
            sp.id,
            i.note,
            COALESCE(i.invoice, i.consignment_id) AS "coalesce",
            'steadfast'::text AS text,
            sp.last_synced_at
           FROM (steadfast_payout_items i
             JOIN steadfast_payouts sp ON ((sp.id = i.payout_id)))
          WHERE ((i.order_id IS NULL) AND (i.line_kind <> 'order'::text) AND (i.net_paid <> (0)::numeric) AND (money_start_date() IS NOT NULL) AND (sp.paid_at >= money_start_ts()))) ledger
  WHERE money_can_view();

-- To give: "Customer wallets" is its own line (only when not ৳0).
CREATE OR REPLACE FUNCTION money_to_give_rows()
RETURNS TABLE(kind text, id uuid, name text, owed numeric, capital_in numeric, capital_back numeric, share_month numeric, share_year numeric, share_all numeric, lots jsonb)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
                AND m.type = 'investor_profit_share' AND m.entry_date BETWEEN v_month AND v_today
                AND (v_start IS NULL OR m.entry_date >= v_start)), 0) AS v) sm
  CROSS JOIN LATERAL (SELECT COALESCE(-(SELECT sum(amount) FROM money_movements m WHERE m.party_id = p.id
                AND m.type = 'investor_profit_share' AND m.entry_date BETWEEN v_year AND v_today
                AND (v_start IS NULL OR m.entry_date >= v_start)), 0) AS v) sy
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
  WHERE EXISTS (SELECT 1 FROM lots l WHERE l.supplier_id IS NULL AND money_lot_owed(l.id) <> 0)
  UNION ALL
  -- Batch 58: courier fees counted in profit that no account has paid yet.
  SELECT 'courier', NULL::uuid, 'Courier (not billed yet)', x.amt,
         NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, '[]'::jsonb
  FROM (SELECT money_courier_not_billed() AS amt) x
  WHERE x.amt <> 0
  UNION ALL
  SELECT 'courier', NULL::uuid, 'Steadfast bills paid outside a payout', y.amt,
         NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, '[]'::jsonb
  FROM (SELECT money_courier_bills_owed() AS amt) y
  WHERE y.amt <> 0
  UNION ALL
  -- Batch 60: money customers keep in their wallets.
  SELECT 'wallet', NULL::uuid, 'Customer wallets', w.amt,
         NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, '[]'::jsonb
  FROM (SELECT COALESCE(sum(amount), 0)::numeric AS amt FROM store_wallet_entries) w
  WHERE w.amt <> 0;
END;
$function$;

-- The opening: wallet money held on the start date is owed then too.
CREATE OR REPLACE FUNCTION money_opening_net_worth()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_start   date := money_start_date();
  v_ts      timestamptz := money_start_ts();
  v_acc     numeric;
  v_prev    numeric;
  v_stock   numeric;
  v_orders  numeric;
  v_pay     numeric;
  v_wallets numeric;
BEGIN
  IF v_start IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(sum(amount), 0) INTO v_acc FROM money_movements WHERE type = 'opening_balance';
  SELECT COALESCE(sum(amount), 0) INTO v_prev FROM customer_opening_dues;
  SELECT COALESCE(round(sum(li.qty * li.landed_unit_cost_bdt), 2), 0) INTO v_stock
  FROM lot_items li JOIN lots l ON l.id = li.lot_id
  WHERE l.kind = 'opening' OR l.lot_date < v_start;
  -- Site orders placed before the start date: what they were worth then.
  SELECT COALESCE(sum(
           CASE k.kind WHEN 'sold' THEN o.total
                       WHEN 'open' THEN money_order_goods_cost(o.id)
                       ELSE 0 END
           - COALESCE((SELECT sum(CASE WHEN p.kind = 'refund' THEN -p.amount ELSE p.amount END)
                       FROM order_payments p WHERE p.order_id = o.id AND p.paid_at < v_ts), 0)), 0)
  INTO v_orders
  FROM orders o
  CROSS JOIN LATERAL (SELECT money_order_opening_kind(o.id) AS kind) k
  WHERE o.created_at < v_ts;
  SELECT COALESCE(sum(amount), 0) INTO v_pay FROM money_opening_payables;
  -- Batch 60: customer wallets on the start date.
  SELECT COALESCE(sum(amount), 0) INTO v_wallets FROM store_wallet_entries WHERE entry_date < v_start;
  RETURN jsonb_build_object('accounts', v_acc, 'previous_balances', v_prev, 'stock', v_stock,
                            'site_orders', v_orders, 'payables', v_pay, 'customer_wallets', v_wallets,
                            'total', v_acc + v_prev + v_stock + v_orders - v_pay - v_wallets);
END;
$function$;

CREATE OR REPLACE FUNCTION money_position()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
  v_goods_old numeric;
  v_open_val  numeric;
  v_short     numeric;
  v_give      numeric;
  v_give_inv  numeric;
  v_give_sup  numeric;
  v_give_oth  numeric;
  v_give_cour numeric;
  v_give_wal  numeric;
  v_wal_corr  numeric := 0;
  v_have      numeric;
  v_owe       numeric;
  v_open      jsonb;
  v_parts     jsonb;
  v_outside   numeric := 0;
  v_out_orders numeric := 0;
  v_out_unm   numeric := 0;
  v_rhs       numeric;
  v_diff      numeric;
  v_first     date;
  v_last_ok   date;
  v_sf_reported numeric;
  v_sf_at     timestamptz;
  v_unplaced  jsonb;
  v_corr      numeric := 0;
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object('account_id', b.account_id, 'name', b.name, 'kind', b.kind,
                    'archived', b.archived, 'balance', b.balance)), '[]'::jsonb),
         COALESCE(sum(b.balance) FILTER (WHERE b.kind <> 'steadfast'), 0),
         COALESCE(sum(b.balance) FILTER (WHERE b.kind = 'steadfast'), 0)
  INTO v_accounts, v_acc_sum, v_sf
  FROM money_account_balances() b;

  -- Customers (per order: owed − paid; Cancelled / Returned owe nothing),
  -- open orders, and orders whose sale is inside the opening balances.
  WITH per AS (
    SELECT o.id, o.status, o.total, money_order_opening_kind(o.id) AS kind,
           (CASE WHEN o.status IN ('cancelled', 'returned') THEN 0 ELSE o.total END) AS basis,
           COALESCE((SELECT sum(CASE WHEN p.kind = 'refund' THEN -p.amount ELSE p.amount END)
                     FROM order_payments p WHERE p.order_id = o.id), 0) AS paid
    FROM orders o
  ), per2 AS (
    SELECT per.*, CASE WHEN per.kind = 'open' THEN money_order_goods_cost(per.id) ELSE 0 END AS goods
    FROM per
  )
  SELECT COALESCE(sum(GREATEST(basis - paid, 0)), 0),
         COALESCE(sum(GREATEST(paid - basis, 0)), 0),
         COALESCE(sum(total) FILTER (WHERE status IN ('pending', 'confirmed', 'shipped') AND kind NOT IN ('sold', 'closed')), 0),
         COALESCE(sum(goods) FILTER (WHERE status IN ('pending', 'confirmed', 'shipped')), 0),
         -- A sale inside the opening that changed later (e.g. returned).
         COALESCE(sum(basis - total) FILTER (WHERE kind = 'sold'), 0)
         -- Goods of an "open" order that never came back to a lot.
         - COALESCE(sum(goods) FILTER (WHERE status IN ('cancelled', 'returned')), 0)
  INTO v_recv, v_adv, v_open_val, v_goods_old, v_out_orders
  FROM per2;

  SELECT COALESCE(sum(amount), 0) INTO v_prev FROM customer_opening_dues;
  v_prev := v_prev - COALESCE((SELECT sum(amount) FROM customer_due_payments), 0);
  -- Batch 50: previous balances corrected later (no money moved).
  v_corr := COALESCE((SELECT sum(amount_change) FROM customer_previous_corrections), 0);
  v_prev := v_prev + v_corr;

  SELECT COALESCE(round(sum(qty_remaining * landed_unit_cost_bdt), 2), 0) INTO v_stock FROM lot_items;

  -- Goods on orders not delivered yet, at the lot row's landed cost (the
  -- same value the stock had before they were taken).
  SELECT COALESCE(round(sum((x.units - x.units_back) * li.landed_unit_cost_bdt), 2), 0) INTO v_goods
  FROM order_item_lots x
  JOIN lot_items li ON li.id = x.lot_item_id
  JOIN orders o ON o.id = x.order_id
  WHERE o.status IN ('pending', 'confirmed', 'shipped');
  v_goods := v_goods + v_goods_old;

  -- Sold without stock: the same cost profit uses for those units.
  SELECT COALESCE(sum(round(s.units * COALESCE(c.unit_cost_bdt, 0) / GREATEST(inventory_item_factor(oi), 1), 2)), 0)
  INTO v_short
  FROM (SELECT order_item_id, sum(units) AS units FROM stock_shortfalls WHERE status = 'open' GROUP BY order_item_id) s
  JOIN order_items oi ON oi.id = s.order_item_id
  JOIN orders o ON o.id = oi.order_id
  LEFT JOIN order_item_costs c ON c.order_item_id = oi.id
  WHERE o.status = 'delivered';

  SELECT COALESCE(sum(owed) FILTER (WHERE kind = 'investor'), 0),
         COALESCE(sum(owed) FILTER (WHERE kind = 'supplier'), 0),
         COALESCE(sum(owed) FILTER (WHERE kind = 'other'), 0),
         COALESCE(sum(owed) FILTER (WHERE kind = 'courier'), 0),
         COALESCE(sum(owed) FILTER (WHERE kind = 'wallet'), 0)
  INTO v_give_inv, v_give_sup, v_give_oth, v_give_cour, v_give_wal
  FROM money_to_give_rows();
  v_give := v_give_inv + v_give_sup + v_give_oth + v_give_cour + v_give_wal;

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
    -- Outside profit: sales inside the opening that changed later, and
    -- Steadfast parcels that match no order.
    SELECT COALESCE(sum(l.amount), 0) INTO v_out_unm
    FROM money_ledger l WHERE l.type IN ('steadfast_unmatched', 'steadfast_courier_only');
    v_outside := v_out_orders + v_out_unm;
    -- Batch 60: wallet corrections (Super Admin) change what is owed with
    -- no money moving, like Batch 50's previous-balance corrections.
    v_wal_corr := COALESCE((SELECT sum(amount) FROM store_wallet_entries
                            WHERE kind = 'correction' AND entry_date >= v_start), 0);

    v_rhs := (v_open ->> 'total')::numeric + (v_parts ->> 'net_profit')::numeric
             - (v_parts ->> 'profit_share')::numeric - (v_parts ->> 'withdrawals')::numeric
             + (v_parts ->> 'owner_money_in')::numeric + (v_parts ->> 'not_shop_money')::numeric
             + (v_parts ->> 'count_differences')::numeric + v_outside + v_corr - v_wal_corr;
    v_diff := round((v_have - v_owe) - v_rhs, 2);

    INSERT INTO money_check_log (check_date, difference, checked_at) VALUES (v_today, v_diff, now())
    ON CONFLICT (check_date) DO UPDATE SET difference = EXCLUDED.difference, checked_at = now();
    -- Batch 58: to the paisa (was ±৳1).
    IF abs(v_diff) >= 0.01 THEN
      SELECT max(check_date) INTO v_last_ok FROM money_check_log WHERE abs(difference) < 0.01 AND check_date < v_today;
      SELECT min(check_date) INTO v_first FROM money_check_log
      WHERE abs(difference) >= 0.01 AND (v_last_ok IS NULL OR check_date > v_last_ok);
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
    'previous_corrections', v_corr,
    'customer_advances', v_adv,
    'stock_value', v_stock,
    'goods_on_open_orders', v_goods,
    'open_orders_value', v_open_val,
    'sold_without_stock', v_short,
    'to_give', v_give,
    'to_give_investors', v_give_inv,
    'to_give_suppliers', v_give_sup,
    'to_give_others', v_give_oth,
    'to_give_courier', v_give_cour,
    'to_give_wallets', v_give_wal,
    'wallet_corrections', v_wal_corr,
    'have', v_have,
    'owe', v_owe,
    'net_worth', v_have - v_owe,
    'opening', v_open,
    'since_start', v_parts,
    'outside_orders', v_out_orders,
    'outside_fees', 0,
    'outside_unmatched', v_out_unm,
    'outside', v_outside,
    'expected', v_rhs,
    'difference', v_diff,
    'balanced', CASE WHEN v_start IS NULL THEN NULL ELSE abs(v_diff) < 0.01 END,
    'first_wrong', v_first);
END;
$function$;

-- ------------------------------------------------------------------
-- 7. Checkout: place_order with the wallet and the ৳1,000 rule
-- ------------------------------------------------------------------

-- One core does the work. place_order keeps its exact arguments and
-- answer (older test scripts replay older migrations that re-create it;
-- a second place_order with more arguments would make every call
-- ambiguous). Checkout calls place_order_wallet only when the customer
-- switches the wallet on.
CREATE OR REPLACE FUNCTION place_order_core(p_items jsonb, p_full_name text, p_phone text, p_division text, p_district text, p_thana text,
                            p_address_line text, p_delivery_zone text, p_payment_method text,
                            p_bkash_trx_id text DEFAULT NULL::text, p_bkash_sender text DEFAULT NULL::text,
                            p_promo_code text DEFAULT NULL::text, p_customer_note text DEFAULT NULL::text,
                            p_store_wallet numeric DEFAULT 0)
RETURNS TABLE(order_id uuid, order_number text, total numeric, discount numeric, advance_discount numeric, store_wallet numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid              uuid := auth.uid();
  v_item             jsonb;
  v_product_id       uuid;
  v_variant_id       uuid;
  v_quantity         integer;
  v_unit_price       numeric(10,2);
  v_product_name     text;
  v_variant_label    text;
  v_image_url        text;
  v_is_active        boolean;
  v_stock_quantity   integer;
  v_in_stock_flag    boolean;
  v_keep             boolean;
  v_region           text;
  v_size             text;
  v_subtotal         numeric(10,2) := 0;
  v_delivery_fee     numeric(10,2);
  v_discount         numeric(10,2) := 0;
  v_advance          numeric(10,2) := 0;
  v_advance_type     text;
  v_advance_value    numeric(10,2);
  v_total            numeric(10,2);
  v_promo_row        promo_codes%ROWTYPE;
  v_promo_ok         boolean;
  v_order_id         uuid;
  v_order_number     text;
  v_item_count       integer := 0;
  -- Batch 51
  v_mode_on          boolean := inventory_mode_on();
  v_no_limit         boolean := is_wholesaler_or_admin();
  v_limit            integer := order_limit_per_item();
  v_already          integer;
  v_have             integer;
  v_short            integer;
  v_take             integer;
  v_buys_later       boolean := false;
  v_line             record;
  v_item_id          uuid;
  -- Batch 60
  v_method           text := p_payment_method;
  v_trx              text := p_bkash_trx_id;
  v_sender           text := p_bkash_sender;
  v_wallet_key       text;
  v_wallet_ask       numeric(12,2) := round(GREATEST(COALESCE(p_store_wallet, 0), 0), 2);
  v_wallet           numeric(12,2) := 0;
  v_pay_before       numeric(12,2);
  v_left             numeric(12,2);
  v_wallet_taken     numeric(12,2) := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to place an order.';
  END IF;

  IF p_payment_method NOT IN ('cod', 'bkash', 'nagad') THEN
    RAISE EXCEPTION 'Invalid payment method.';
  END IF;
  IF p_payment_method = 'bkash' AND (p_bkash_trx_id IS NULL OR trim(p_bkash_trx_id) = '') THEN
    RAISE EXCEPTION 'A bKash Transaction ID is required for bKash payment.';
  END IF;
  IF p_payment_method = 'nagad' AND (p_bkash_trx_id IS NULL OR trim(p_bkash_trx_id) = '') THEN
    RAISE EXCEPTION 'A Nagad Transaction ID is required for Nagad payment.';
  END IF;
  IF p_delivery_zone NOT IN ('inside_dhaka', 'outside_dhaka') THEN
    RAISE EXCEPTION 'Invalid delivery zone.';
  END IF;
  IF p_full_name IS NULL OR trim(p_full_name) = '' THEN
    RAISE EXCEPTION 'Full name is required.';
  END IF;
  IF p_address_line IS NULL OR trim(p_address_line) = '' THEN
    RAISE EXCEPTION 'Delivery address is required.';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Your cart is empty.';
  END IF;

  -- Batch 60: the wallet is checked again here (the screen is never
  -- trusted). The lock holds until the order is saved.
  IF v_wallet_ask > 0 THEN
    v_wallet_key := store_wallet_my_key();
    IF v_wallet_key IS NULL THEN
      RAISE EXCEPTION 'Your wallet balance changed. Please check and try again.';
    END IF;
    PERFORM store_wallet_lock(v_wallet_key);
    IF v_wallet_ask > store_wallet_balance(v_wallet_key) + 0.004 THEN
      RAISE EXCEPTION 'Your wallet balance changed. Please check and try again.';
    END IF;
  END IF;

  SELECT COALESCE(
    (SELECT value::numeric FROM app_settings WHERE key = 'delivery_fee_' || p_delivery_zone),
    CASE WHEN p_delivery_zone = 'inside_dhaka' THEN 80 ELSE 130 END
  ) INTO v_delivery_fee;

  CREATE TEMP TABLE IF NOT EXISTS _place_lines (
    seq           serial,
    product_id    uuid,
    variant_id    uuid,
    product_name  text,
    variant_label text,
    image_url     text,
    unit_price    numeric(10,2),
    quantity      integer,
    line_total    numeric(10,2),
    keep_selling  boolean,
    short_qty     integer,
    tracked       boolean
  ) ON COMMIT DROP;
  TRUNCATE _place_lines;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_item_count := v_item_count + 1;
    v_product_id := (v_item->>'product_id')::uuid;
    v_variant_id := NULLIF(v_item->>'variant_id', '')::uuid;
    -- Batch 45 Part 3: the product's own size is picked as an option whose
    -- id is the product's id. It is the product row, not an option row.
    IF v_variant_id = v_product_id THEN
      v_variant_id := NULL;
    END IF;
    v_quantity   := (v_item->>'quantity')::integer;

    IF v_product_id IS NULL OR v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Invalid item in your cart.';
    END IF;

    IF v_variant_id IS NOT NULL THEN
      SELECT
        CASE WHEN pv.offer_price IS NOT NULL AND pv.offer_price < pv.retail_price
             THEN pv.offer_price ELSE pv.retail_price END,
        pv.stock_quantity,
        pv.in_stock,
        pv.region,
        pv.size,
        COALESCE(pv.image_url, p.image_url),
        p.name,
        p.is_active,
        p.keep_selling
      INTO v_unit_price, v_stock_quantity, v_in_stock_flag, v_region, v_size,
           v_image_url, v_product_name, v_is_active, v_keep
      FROM product_variants pv
      JOIN products p ON p.id = pv.product_id
      WHERE pv.id = v_variant_id AND pv.product_id = v_product_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'One of the items in your cart is no longer available.';
      END IF;
      v_variant_label := NULLIF(trim(both ' ' from concat_ws(' · ', NULLIF(v_region, ''), NULLIF(v_size, ''))), '');
    ELSE
      SELECT
        CASE WHEN p.offer_price IS NOT NULL AND p.offer_price < p.retail_price
             THEN p.offer_price ELSE p.retail_price END,
        p.stock_quantity,
        (p.stock_status <> 'out_of_stock'),
        p.image_url,
        p.name,
        p.is_active,
        p.keep_selling
      INTO v_unit_price, v_stock_quantity, v_in_stock_flag, v_image_url, v_product_name, v_is_active, v_keep
      FROM products p
      WHERE p.id = v_product_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'One of the items in your cart is no longer available.';
      END IF;
      v_variant_label := NULL;
    END IF;

    IF NOT v_is_active THEN
      RAISE EXCEPTION '"%" is no longer available.', v_product_name;
    END IF;

    SELECT COALESCE(sum(l.quantity), 0) INTO v_already
    FROM _place_lines l
    WHERE l.product_id = v_product_id AND l.variant_id IS NOT DISTINCT FROM v_variant_id;

    -- Batch 51: the order limit (Admin → Settings). Wholesalers have none.
    IF NOT v_no_limit AND v_already + v_quantity > v_limit THEN
      RAISE EXCEPTION 'Limit % per order for "%".', v_limit, v_product_name;
    END IF;

    v_short := 0;
    IF v_keep THEN
      -- Never refused for stock. What stock does not cover is bought
      -- after the order (Shopping list).
      v_have := stock_packs_on_hand(v_product_id, v_variant_id, v_already + v_quantity);
      IF v_mode_on THEN
        v_have := v_have - v_already;
      ELSIF v_stock_quantity IS NOT NULL THEN
        -- Off: the stock number, already lowered by earlier lines.
        v_have := GREATEST(v_stock_quantity, 0);
      END IF;
      v_short := GREATEST(v_quantity - GREATEST(v_have, 0), 0);
      IF v_short > 0 THEN
        v_buys_later := true;
      END IF;
    ELSIF v_stock_quantity IS NOT NULL THEN
      IF v_stock_quantity < v_quantity THEN
        RAISE EXCEPTION 'Only % of "%" left in stock.', v_stock_quantity, v_product_name;
      END IF;
    ELSIF NOT v_in_stock_flag THEN
      RAISE EXCEPTION '"%" is out of stock.', v_product_name;
    END IF;

    INSERT INTO _place_lines (product_id, variant_id, product_name, variant_label, image_url, unit_price,
                              quantity, line_total, keep_selling, short_qty, tracked)
    VALUES (v_product_id, v_variant_id, v_product_name, v_variant_label, v_image_url, v_unit_price,
            v_quantity, v_unit_price * v_quantity, v_keep, v_short, v_stock_quantity IS NOT NULL);

    v_subtotal := v_subtotal + (v_unit_price * v_quantity);

    IF v_stock_quantity IS NOT NULL THEN
      -- Off: the stock number goes down only by what it covers. On: the
      -- number follows the lots anyway (inventory_force_*_stock).
      v_take := CASE WHEN v_mode_on THEN v_quantity ELSE v_quantity - v_short END;
      IF v_variant_id IS NOT NULL THEN
        UPDATE product_variants SET stock_quantity = GREATEST(stock_quantity - v_take, 0) WHERE id = v_variant_id;
      ELSE
        UPDATE products SET stock_quantity = GREATEST(stock_quantity - v_take, 0) WHERE id = v_product_id;
      END IF;
    END IF;
  END LOOP;

  IF p_promo_code IS NOT NULL AND trim(p_promo_code) <> '' THEN
    SELECT * INTO v_promo_row FROM promo_codes WHERE lower(code) = lower(trim(p_promo_code));
    IF NOT FOUND OR NOT v_promo_row.active
       OR (v_promo_row.max_uses IS NOT NULL AND v_promo_row.times_used >= v_promo_row.max_uses)
       OR (v_promo_row.expires_at IS NOT NULL AND v_promo_row.expires_at <= now()) THEN
      RAISE EXCEPTION 'This promo code is no longer valid.';
    END IF;

    v_discount := CASE WHEN v_promo_row.discount_type = 'percent'
                        THEN v_subtotal * v_promo_row.discount_amount / 100
                        ELSE v_promo_row.discount_amount END;
    v_discount := LEAST(GREATEST(v_discount, 0), v_subtotal);

    SELECT increment_promo_usage(p_promo_code) INTO v_promo_ok;
    IF NOT v_promo_ok THEN
      RAISE EXCEPTION 'This promo code is no longer valid.';
    END IF;
  END IF;

  -- Batch 60: the wallet part comes off first. What is left is paid on
  -- delivery or in advance. Fully paid from the wallet: nothing is left to
  -- pay, so there is no bKash / Nagad payment at all.
  v_pay_before := GREATEST(v_subtotal + v_delivery_fee - v_discount, 0);
  v_wallet := LEAST(v_wallet_ask, v_pay_before);
  v_left := v_pay_before - v_wallet;
  IF v_wallet > 0 AND v_left < 0.01 THEN
    v_method := 'cod';
    v_trx := NULL;
    v_sender := NULL;
  END IF;

  -- Batch 48: paying in advance (bKash / Nagad) takes the advance discount
  -- off the products after the promo code. Delivery is never discounted.
  -- Worked out here from the setting; the browser sends no amount. It is
  -- not a promo code and never touches times_used.
  -- Batch 60: only when the part paid in advance is ৳1,000 or more, and
  -- never on the wallet part (the base is the products' part of what is
  -- left to pay).
  IF v_method IN ('bkash', 'nagad') AND v_left >= 1000 THEN
    SELECT a.amount, a.rule_type, a.rule_value
      INTO v_advance, v_advance_type, v_advance_value
      FROM advance_discount_amount(v_method, LEAST(v_subtotal - v_discount, v_left)) a;
  END IF;
  v_advance := COALESCE(v_advance, 0);
  IF v_advance <= 0 THEN
    v_advance := 0;
    v_advance_type := NULL;
    v_advance_value := NULL;
  END IF;

  v_total := GREATEST(v_subtotal + v_delivery_fee - v_discount - v_advance, 0);
  v_order_number := next_order_number();

  INSERT INTO orders (
    order_number, customer_id, customer_name, customer_phone,
    division, district, thana, address_line,
    delivery_zone, delivery_fee, subtotal, discount, list_value,
    promo_code, total, payment_method, bkash_trx_id, bkash_sender,
    payment_status, customer_note,
    advance_discount, advance_discount_type, advance_discount_value,
    buys_later
  ) VALUES (
    v_order_number, v_uid, trim(p_full_name), p_phone,
    p_division, p_district, p_thana, trim(p_address_line),
    p_delivery_zone, v_delivery_fee, v_subtotal, v_discount + v_advance, v_subtotal,
    NULLIF(trim(COALESCE(p_promo_code, '')), ''), v_total, v_method,
    NULLIF(trim(COALESCE(v_trx, '')), ''), NULLIF(trim(COALESCE(v_sender, '')), ''),
    CASE WHEN v_method IN ('bkash', 'nagad') THEN 'pending_verification' ELSE 'unpaid' END,
    NULLIF(trim(COALESCE(p_customer_note, '')), ''),
    v_advance, v_advance_type, v_advance_value,
    v_buys_later
  )
  RETURNING id INTO v_order_id;

  -- One line at a time, in cart order. Inventory mode On: a keep-selling
  -- line may take more than the lots hold; the rest is recorded as "sold
  -- without stock" (Batch 39). Every other line is refused when short.
  FOR v_line IN SELECT * FROM _place_lines ORDER BY seq LOOP
    PERFORM set_config('inventory.short_ok', CASE WHEN v_line.keep_selling THEN 'on' ELSE '' END, true);
    INSERT INTO order_items (order_id, product_id, variant_id, product_name, variant_label, image_url, unit_price, quantity, line_total, list_price)
    VALUES (v_order_id, v_line.product_id, v_line.variant_id, v_line.product_name, v_line.variant_label,
            v_line.image_url, v_line.unit_price, v_line.quantity, v_line.line_total, v_line.unit_price)
    RETURNING id INTO v_item_id;
    IF NOT v_mode_on AND v_line.tracked AND v_line.short_qty > 0 THEN
      INSERT INTO order_item_unstocked (order_item_id, qty) VALUES (v_item_id, v_line.short_qty);
      UPDATE order_items
      SET pre_inventory_units = (v_line.quantity - v_line.short_qty) * inventory_pack_size(v_line.product_id, v_line.variant_id)
      WHERE id = v_item_id;
    END IF;
  END LOOP;
  PERFORM set_config('inventory.short_ok', '', true);

  INSERT INTO order_status_history (order_id, old_status, new_status, changed_by)
  VALUES (v_order_id, NULL, 'pending', v_uid);

  IF v_wallet > 0 THEN
    v_wallet_taken := store_wallet_take(v_order_id, v_wallet, v_wallet_key);
    IF v_wallet_taken < v_wallet - 0.004 THEN
      RAISE EXCEPTION 'Your wallet balance changed. Please check and try again.';
    END IF;
  END IF;

  RETURN QUERY SELECT v_order_id, v_order_number, v_total, v_discount + v_advance, v_advance, v_wallet_taken;
END;
$function$;

REVOKE ALL ON FUNCTION place_order_core(jsonb, text, text, text, text, text, text, text, text, text, text, text, text, numeric) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION place_order(p_items jsonb, p_full_name text, p_phone text, p_division text, p_district text, p_thana text,
                                       p_address_line text, p_delivery_zone text, p_payment_method text,
                                       p_bkash_trx_id text DEFAULT NULL::text, p_bkash_sender text DEFAULT NULL::text,
                                       p_promo_code text DEFAULT NULL::text, p_customer_note text DEFAULT NULL::text)
RETURNS TABLE(order_id uuid, order_number text, total numeric, discount numeric, advance_discount numeric)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT c.order_id, c.order_number, c.total, c.discount, c.advance_discount
  FROM place_order_core(p_items, p_full_name, p_phone, p_division, p_district, p_thana, p_address_line, p_delivery_zone,
                        p_payment_method, p_bkash_trx_id, p_bkash_sender, p_promo_code, p_customer_note, 0) c;
$function$;

CREATE OR REPLACE FUNCTION place_order_wallet(p_items jsonb, p_full_name text, p_phone text, p_division text, p_district text,
                                              p_thana text, p_address_line text, p_delivery_zone text, p_payment_method text,
                                              p_bkash_trx_id text DEFAULT NULL::text, p_bkash_sender text DEFAULT NULL::text,
                                              p_promo_code text DEFAULT NULL::text, p_customer_note text DEFAULT NULL::text,
                                              p_store_wallet numeric DEFAULT 0)
RETURNS TABLE(order_id uuid, order_number text, total numeric, discount numeric, advance_discount numeric, store_wallet numeric)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT * FROM place_order_core(p_items, p_full_name, p_phone, p_division, p_district, p_thana, p_address_line,
                                 p_delivery_zone, p_payment_method, p_bkash_trx_id, p_bkash_sender, p_promo_code,
                                 p_customer_note, p_store_wallet);
$function$;

REVOKE ALL ON FUNCTION place_order(jsonb, text, text, text, text, text, text, text, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION place_order(jsonb, text, text, text, text, text, text, text, text, text, text, text, text) TO authenticated;
REVOKE ALL ON FUNCTION place_order_wallet(jsonb, text, text, text, text, text, text, text, text, text, text, text, text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION place_order_wallet(jsonb, text, text, text, text, text, text, text, text, text, text, text, text, numeric) TO authenticated;

-- ------------------------------------------------------------------
-- 8. The customer's own wallet
-- ------------------------------------------------------------------

-- Everything the Account card, the Wallet page and checkout need.
CREATE OR REPLACE FUNCTION store_wallet_my()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_key text := store_wallet_my_key();
  v_due numeric;
BEGIN
  IF v_key IS NULL THEN
    RETURN jsonb_build_object('available', false, 'balance', 0, 'due', 0, 'waiting', '[]'::jsonb,
                              'results', '[]'::jsonb, 'history', '[]'::jsonb);
  END IF;
  SELECT COALESCE(sum(k.due), 0) INTO v_due FROM order_customer_keys() k WHERE k.customer_key = v_key;
  v_due := v_due + COALESCE(customer_previous_balance(), 0);
  RETURN jsonb_build_object(
    'available', true,
    'balance', store_wallet_balance(v_key),
    'due', v_due,
    'waiting', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', r.id, 'amount', r.amount, 'method', r.method, 'trx_id', r.trx_id,
                                          'created_at', r.created_at) ORDER BY r.created_at DESC)
      FROM store_wallet_requests r WHERE r.profile_id = auth.uid() AND r.status = 'waiting'), '[]'::jsonb),
    'results', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', r.id, 'amount', r.amount, 'method', r.method, 'status', r.status,
                                          'decided_at', r.decided_at) ORDER BY r.decided_at DESC)
      FROM store_wallet_requests r
      WHERE r.profile_id = auth.uid() AND r.status IN ('confirmed', 'rejected') AND r.seen_at IS NULL), '[]'::jsonb),
    'history', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', h.id, 'date', h.entry_date, 'at', h.created_at, 'kind', h.kind,
                                          'amount', h.amount, 'order_id', h.order_id, 'order_number', h.order_number,
                                          'by_shop', h.kind = 'added' AND h.request_id IS NULL)
                       ORDER BY h.created_at DESC, h.id)
      FROM (SELECT e.* FROM store_wallet_entries e
            WHERE store_wallet_owner(e.customer_key) = store_wallet_owner(v_key)
            ORDER BY e.created_at DESC LIMIT 200) h), '[]'::jsonb));
END;
$function$;

-- "I sent money" (bKash / Nagad).
CREATE OR REPLACE FUNCTION store_wallet_request(p_amount numeric, p_method text, p_trx_id text, p_sender text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_key text := store_wallet_my_key();
  v_row store_wallet_requests%ROWTYPE;
BEGIN
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'Sign in to add money to your wallet.';
  END IF;
  IF p_amount IS NULL OR round(p_amount, 2) < 500 THEN
    RAISE EXCEPTION 'Minimum ৳500';
  END IF;
  IF round(p_amount, 2) > 10000000 THEN
    RAISE EXCEPTION 'That amount is too large.';
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('bkash', 'nagad') THEN
    RAISE EXCEPTION 'Choose bKash or Nagad.';
  END IF;
  IF p_trx_id IS NULL OR btrim(p_trx_id) = '' THEN
    RAISE EXCEPTION 'Transaction ID is required';
  END IF;
  INSERT INTO store_wallet_requests (customer_key, profile_id, amount, method, trx_id, sender)
  VALUES (v_key, auth.uid(), round(p_amount, 2), p_method, p_trx_id, COALESCE(p_sender, ''))
  RETURNING * INTO v_row;
  PERFORM write_activity('wallet.requested', 'customer', v_key, COALESCE(v_row.customer_name, v_key),
    format('Wallet: %s sent by %s, TrxID %s (waiting)', money_short(v_row.amount), payment_method_label(v_row.method), v_row.trx_id),
    jsonb_build_object('request_id', v_row.id, 'amount', v_row.amount, 'method', v_row.method));
  RETURN jsonb_build_object('id', v_row.id, 'amount', v_row.amount, 'method', v_row.method, 'trx_id', v_row.trx_id,
                            'status', v_row.status, 'created_at', v_row.created_at);
END;
$function$;

-- The customer saw the answer to a request (toast shown, or dismissed).
CREATE OR REPLACE FUNCTION store_wallet_seen(p_request_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH u AS (
    UPDATE store_wallet_requests SET seen_at = now()
    WHERE id = p_request_id AND profile_id = auth.uid() AND status <> 'waiting' AND seen_at IS NULL
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u);
$function$;

-- What the wallet paid on orders (My Orders, the order page, the invoice).
CREATE OR REPLACE FUNCTION store_wallet_order_paid(p_order_ids uuid[])
RETURNS TABLE(order_id uuid, from_wallet numeric)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT o.id, COALESCE(-sum(e.amount) FILTER (WHERE e.kind IN ('order', 'order_back')), 0)::numeric
  FROM orders o
  JOIN store_wallet_entries e ON e.order_id = o.id
  WHERE o.id = ANY (p_order_ids)
    AND (o.customer_id = auth.uid() OR staff_can('view_orders'))
  GROUP BY o.id;
$function$;

REVOKE ALL ON FUNCTION store_wallet_my() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION store_wallet_request(numeric, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION store_wallet_seen(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION store_wallet_order_paid(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION store_wallet_my() TO authenticated;
GRANT EXECUTE ON FUNCTION store_wallet_request(numeric, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION store_wallet_seen(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION store_wallet_order_paid(uuid[]) TO authenticated;

-- ------------------------------------------------------------------
-- 9. Staff: the customer page, Confirm / Reject, Add, Correct, orders
-- ------------------------------------------------------------------

-- A customer's wallet on their admin page (money access).
CREATE OR REPLACE FUNCTION store_wallet_customer(p_customer_key text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_owner text := store_wallet_owner(p_customer_key);
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  RETURN jsonb_build_object(
    'balance', store_wallet_balance(p_customer_key),
    'waiting', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', r.id, 'amount', r.amount, 'method', r.method, 'trx_id', r.trx_id,
                                          'sender', r.sender, 'created_at', r.created_at) ORDER BY r.created_at)
      FROM store_wallet_requests r WHERE store_wallet_owner(r.customer_key) = v_owner AND r.status = 'waiting'), '[]'::jsonb),
    'requests', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', r.id, 'amount', r.amount, 'method', r.method, 'trx_id', r.trx_id,
                                          'status', r.status, 'reason', r.reject_reason, 'by', r.decided_by_username,
                                          'decided_at', r.decided_at, 'created_at', r.created_at) ORDER BY r.created_at DESC)
      FROM store_wallet_requests r WHERE store_wallet_owner(r.customer_key) = v_owner AND r.status <> 'waiting'), '[]'::jsonb),
    'history', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', e.id, 'date', e.entry_date, 'at', e.created_at, 'kind', e.kind,
                                          'amount', e.amount, 'order_id', e.order_id, 'order_number', e.order_number,
                                          'account', a.name, 'note', e.note, 'by', e.created_by_username,
                                          'by_shop', e.kind = 'added' AND e.request_id IS NULL)
                       ORDER BY e.created_at DESC, e.id)
      FROM store_wallet_entries e LEFT JOIN money_accounts a ON a.id = e.account_id
      WHERE store_wallet_owner(e.customer_key) = v_owner), '[]'::jsonb));
END;
$function$;

-- Every waiting request (Home "Needs attention").
CREATE OR REPLACE FUNCTION store_wallet_waiting()
RETURNS TABLE(id uuid, customer_key text, name text, amount numeric, method text, trx_id text, created_at timestamptz)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT money_can_view() THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT r.id, store_wallet_owner(r.customer_key), COALESCE(r.customer_name, customer_name_for_key(store_wallet_owner(r.customer_key))),
         r.amount, r.method, r.trx_id, r.created_at
  FROM store_wallet_requests r WHERE r.status = 'waiting'
  ORDER BY r.created_at;
END;
$function$;

-- The account money is received in by default: bKash for bKash, Nagad
-- (or bKash when there is no Nagad account) for Nagad.
CREATE OR REPLACE FUNCTION store_wallet_default_account(p_method text)
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT a.id FROM money_accounts a WHERE a.payment_method = p_method AND NOT a.archived AND a.kind <> 'steadfast'
     ORDER BY a.sort_order, a.created_at LIMIT 1),
    (SELECT a.id FROM money_accounts a WHERE a.payment_method = 'bkash' AND NOT a.archived AND a.kind <> 'steadfast'
     ORDER BY a.sort_order, a.created_at LIMIT 1));
$function$;

CREATE OR REPLACE FUNCTION store_wallet_confirm(p_request_id uuid, p_account_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_req   store_wallet_requests%ROWTYPE;
  v_acc   money_accounts%ROWTYPE;
  v_today date := inventory_dhaka_today();
  v_entry uuid;
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  SELECT * INTO v_req FROM store_wallet_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request not found.';
  END IF;
  IF v_req.status <> 'waiting' THEN
    RAISE EXCEPTION 'This request is already %.', v_req.status;
  END IF;
  v_acc := money_check_account(COALESCE(p_account_id, store_wallet_default_account(v_req.method)));
  PERFORM money_check_entry_date(v_today);
  PERFORM money_lock_refuse(v_today, 'wallet money');
  PERFORM store_wallet_lock(v_req.customer_key);
  INSERT INTO store_wallet_entries (customer_key, amount, kind, account_id, request_id, entry_date, note,
                                    created_by, created_by_username)
  VALUES (v_req.customer_key, v_req.amount, 'added', v_acc.id, v_req.id, v_today,
          payment_method_label(v_req.method) || ', TrxID ' || v_req.trx_id, auth.uid(), current_actor_username())
  RETURNING id INTO v_entry;
  UPDATE store_wallet_requests
  SET status = 'confirmed', account_id = v_acc.id, decided_by = auth.uid(), decided_by_username = current_actor_username(),
      decided_at = now()
  WHERE id = v_req.id;
  PERFORM write_activity('wallet.confirmed', 'customer', store_wallet_owner(v_req.customer_key),
    COALESCE(v_req.customer_name, customer_name_for_key(store_wallet_owner(v_req.customer_key))),
    format('Wallet: %s confirmed into %s (%s, TrxID %s)', money_short(v_req.amount), v_acc.name,
           payment_method_label(v_req.method), v_req.trx_id),
    jsonb_build_object('request_id', v_req.id, 'amount', v_req.amount, 'account', v_acc.name));
  RETURN jsonb_build_object('entry_id', v_entry, 'balance', store_wallet_balance(v_req.customer_key));
END;
$function$;

CREATE OR REPLACE FUNCTION store_wallet_reject(p_request_id uuid, p_reason text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_req    store_wallet_requests%ROWTYPE;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF v_reason IS NOT NULL AND char_length(v_reason) > 300 THEN
    RAISE EXCEPTION 'Keep the reason under 300 letters.';
  END IF;
  SELECT * INTO v_req FROM store_wallet_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Request not found.';
  END IF;
  IF v_req.status <> 'waiting' THEN
    RAISE EXCEPTION 'This request is already %.', v_req.status;
  END IF;
  UPDATE store_wallet_requests
  SET status = 'rejected', reject_reason = v_reason, decided_by = auth.uid(),
      decided_by_username = current_actor_username(), decided_at = now()
  WHERE id = v_req.id;
  PERFORM write_activity('wallet.rejected', 'customer', store_wallet_owner(v_req.customer_key),
    COALESCE(v_req.customer_name, customer_name_for_key(store_wallet_owner(v_req.customer_key))),
    format('Wallet: %s not confirmed (TrxID %s)%s', money_short(v_req.amount), v_req.trx_id,
           CASE WHEN v_reason IS NOT NULL THEN ': ' || v_reason ELSE '' END),
    jsonb_build_object('request_id', v_req.id, 'amount', v_req.amount, 'reason', v_reason));
  RETURN true;
END;
$function$;

-- "Add to wallet": money a customer sent on WhatsApp.
CREATE OR REPLACE FUNCTION store_wallet_add(p_customer_key text, p_amount numeric, p_account_id uuid, p_date date,
                                            p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_key    text := NULLIF(btrim(COALESCE(p_customer_key, '')), '');
  v_amount numeric(12,2) := round(p_amount, 2);
  v_acc    money_accounts%ROWTYPE;
  v_note   text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_entry  uuid;
BEGIN
  IF NOT money_can_view() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF v_key IS NULL OR NOT customer_key_known(v_key) THEN
    RAISE EXCEPTION 'Customer not found.';
  END IF;
  IF v_amount IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION 'Type an amount above 0.';
  END IF;
  IF v_amount > 10000000 THEN
    RAISE EXCEPTION 'That amount is too large.';
  END IF;
  IF v_note IS NOT NULL AND char_length(v_note) > 300 THEN
    RAISE EXCEPTION 'Keep the note under 300 letters.';
  END IF;
  PERFORM money_check_entry_date(p_date);
  PERFORM money_lock_refuse(p_date, 'wallet money');
  v_acc := money_check_account(p_account_id);
  v_key := store_wallet_owner(v_key);
  PERFORM store_wallet_lock(v_key);
  INSERT INTO store_wallet_entries (customer_key, amount, kind, account_id, entry_date, note, created_by, created_by_username)
  VALUES (v_key, v_amount, 'added', v_acc.id, p_date, v_note, auth.uid(), current_actor_username())
  RETURNING id INTO v_entry;
  PERFORM write_activity('wallet.added', 'customer', v_key, customer_name_for_key(v_key),
    format('Wallet: %s added into %s, %s%s', money_short(v_amount), v_acc.name, to_char(p_date, 'DD Mon YYYY'),
           CASE WHEN v_note IS NOT NULL THEN ' (' || v_note || ')' ELSE '' END),
    jsonb_build_object('amount', v_amount, 'account', v_acc.name, 'date', p_date));
  RETURN jsonb_build_object('entry_id', v_entry, 'balance', store_wallet_balance(v_key));
END;
$function$;

-- Super Admin: set the balance to a new amount (no money moves), with a
-- note, password typed again (like Batch 50's previous balance).
CREATE OR REPLACE FUNCTION store_wallet_correct(p_customer_key text, p_new_balance numeric, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_key  text := store_wallet_owner(NULLIF(btrim(COALESCE(p_customer_key, '')), ''));
  v_new  numeric(12,2) := round(p_new_balance, 2);
  v_old  numeric(12,2);
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Only the Super Admin can correct a wallet.';
  END IF;
  IF NOT money_password_recent() THEN
    RAISE EXCEPTION 'Type your password again to confirm.';
  END IF;
  IF v_key IS NULL OR NOT customer_key_known(v_key) THEN
    RAISE EXCEPTION 'Customer not found.';
  END IF;
  IF v_new IS NULL OR v_new < 0 THEN
    RAISE EXCEPTION 'Type an amount of 0 or more.';
  END IF;
  IF v_new > 10000000 THEN
    RAISE EXCEPTION 'That amount is too large.';
  END IF;
  IF v_note IS NULL THEN
    RAISE EXCEPTION 'Write why it is corrected.';
  END IF;
  IF char_length(v_note) > 300 THEN
    RAISE EXCEPTION 'Keep the note under 300 letters.';
  END IF;
  PERFORM money_lock_refuse(inventory_dhaka_today(), 'a wallet correction');
  PERFORM store_wallet_lock(v_key);
  v_old := round(store_wallet_balance(v_key), 2);
  IF v_old = v_new THEN
    RAISE EXCEPTION 'The wallet is already %.', money_short(v_new);
  END IF;
  INSERT INTO store_wallet_entries (customer_key, amount, kind, entry_date, note, created_by, created_by_username)
  VALUES (v_key, v_new - v_old, 'correction', inventory_dhaka_today(), v_note, auth.uid(), current_actor_username());
  PERFORM write_activity('wallet.corrected', 'customer', v_key, customer_name_for_key(v_key),
    format('Wallet corrected from %s to %s (%s)', money_short(v_old), money_short(v_new), v_note),
    jsonb_build_object('old', v_old, 'new', v_new, 'note', v_note));
  RETURN jsonb_build_object('old', v_old, 'new', v_new);
END;
$function$;

-- Admin New order / Edit order: "Use wallet balance".
CREATE OR REPLACE FUNCTION store_wallet_use(p_order_id uuid, p_amount numeric)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_key   text;
  v_taken numeric;
  v_order orders%ROWTYPE;
BEGIN
  IF NOT (staff_can('create_orders') OR staff_can('edit_orders')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;
  v_key := store_wallet_order_key(p_order_id);
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'This order has no customer.';
  END IF;
  v_taken := store_wallet_take(p_order_id, p_amount, v_key);
  IF v_taken > 0 THEN
    PERFORM write_activity('order.payment_added', 'order', p_order_id::text, v_order.order_number,
      format('%s: %s paid from the customer''s wallet', v_order.order_number, money_short(v_taken)),
      jsonb_build_object('kind', 'payment', 'amount', v_taken, 'method', 'store_wallet'));
  END IF;
  RETURN v_taken;
END;
$function$;

-- The wallet as the New order / Edit order screens see it.
CREATE OR REPLACE FUNCTION store_wallet_for_order(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_key   text;
  v_order orders%ROWTYPE;
BEGIN
  IF NOT (staff_can('create_orders') OR staff_can('edit_orders') OR money_can_view()) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  v_key := store_wallet_order_key(p_order_id);
  RETURN jsonb_build_object(
    'customer_key', v_key,
    'balance', CASE WHEN v_key IS NULL THEN 0 ELSE store_wallet_balance(v_key) END,
    'on_order', COALESCE((SELECT -sum(e.amount) FROM store_wallet_entries e
                          WHERE e.order_id = p_order_id AND e.kind IN ('order', 'order_back')), 0),
    'due', GREATEST(v_order.total - order_payment_net(p_order_id), 0));
END;
$function$;

CREATE OR REPLACE FUNCTION store_wallet_for_customer(p_profile_id uuid, p_phone text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_key text;
BEGIN
  IF NOT (staff_can('create_orders') OR staff_can('edit_orders') OR money_can_view()) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_profile_id IS NOT NULL AND EXISTS (SELECT 1 FROM profiles p WHERE p.id = p_profile_id AND p.role = 'customer') THEN
    v_key := 'p:' || p_profile_id;
  ELSIF bd_phone_key(p_phone) IS NOT NULL THEN
    v_key := money_customer_key_for_phone(bd_phone_key(p_phone));
  END IF;
  RETURN jsonb_build_object('customer_key', v_key,
                            'balance', CASE WHEN v_key IS NULL THEN 0 ELSE store_wallet_balance(v_key) END);
END;
$function$;

REVOKE ALL ON FUNCTION store_wallet_customer(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION store_wallet_waiting() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION store_wallet_default_account(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION store_wallet_confirm(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION store_wallet_reject(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION store_wallet_add(text, numeric, uuid, date, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION store_wallet_correct(text, numeric, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION store_wallet_use(uuid, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION store_wallet_for_order(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION store_wallet_for_customer(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION store_wallet_customer(text) TO authenticated;
GRANT EXECUTE ON FUNCTION store_wallet_waiting() TO authenticated;
GRANT EXECUTE ON FUNCTION store_wallet_default_account(text) TO authenticated;
GRANT EXECUTE ON FUNCTION store_wallet_confirm(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION store_wallet_reject(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION store_wallet_add(text, numeric, uuid, date, text) TO authenticated;
GRANT EXECUTE ON FUNCTION store_wallet_correct(text, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION store_wallet_use(uuid, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION store_wallet_for_order(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION store_wallet_for_customer(uuid, text) TO authenticated;

-- ------------------------------------------------------------------
-- 10. Batch 58's customer "credit" becomes the wallet
-- ------------------------------------------------------------------
-- Every order paid more than it asks today moves the extra into its
-- customer's wallet ('overpaid'). Run again: nothing is left to move.
DO $do$
DECLARE
  v_id uuid;
BEGIN
  FOR v_id IN
    SELECT o.id FROM orders o
    WHERE order_payment_net(o.id) - CASE WHEN o.status IN ('cancelled', 'returned') THEN 0 ELSE o.total END >= 0.01
    ORDER BY o.created_at
  LOOP
    PERFORM store_wallet_sync_order(v_id);
  END LOOP;
END;
$do$;

COMMIT;
