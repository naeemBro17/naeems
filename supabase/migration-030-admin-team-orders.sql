-- ============================================================
-- Naeem's Price Hub — Migration 030 (Batch 24: admin team, activity log,
-- safety lock, order deletes, price edits, order number format, texts)
-- Run this in the Supabase SQL Editor after migration-029. Safe to re-run.
--
-- ADDITIVE ONLY. No table or column is dropped or renamed. Existing
-- functions keep their exact names and argument lists (so the live site,
-- built from main, keeps working the moment this runs); a few get extra
-- permission checks or English notes.
--
-- What it adds:
--   PART 1  'moderator' role + staff_members (username, permissions,
--           disabled) + staff_can(permission), the ONE server-side check
--           every moderator action goes through. The Super Admin (role
--           'admin') always passes it.
--   PART 2  activity_log — insert-only, written by triggers and functions
--           inside the database, never by the browser directly.
--   PART 3  Moderator access rules (RLS) — orders, products, categories,
--           customers — each tied to one permission.
--   PART 4  Order number format (prefix / next number / suffix).
--   PART 5  Order functions re-created with permission checks, the new
--           order number, and "stock_released" so stock is only ever put
--           back once.
--   PART 6  Safety Lock + admin_delete_orders().
--   PART 7  Super Admin item price edit.
--   PART 8  Team management functions (called by the admin-team Edge
--           Function) and small read helpers.
-- ============================================================


-- ============================================================
-- PART 1 — roles, staff members, permission check
-- ============================================================

DO $$
DECLARE
  v_constraint text;
BEGIN
  SELECT con.conname INTO v_constraint
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'profiles'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) ILIKE '%role%IN%';

  IF v_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE profiles DROP CONSTRAINT %I', v_constraint);
  END IF;

  ALTER TABLE profiles ADD CONSTRAINT profiles_role_check
    CHECK (role IN ('customer', 'wholesaler', 'admin', 'moderator'));
END $$;

-- One row per admin-panel login (the Super Admin and every moderator).
-- The ROLE still lives in profiles.role (the one source of truth every
-- existing check uses); this table only adds the username, the on/off
-- permission list, and the disabled switch.
CREATE TABLE IF NOT EXISTS staff_members (
  id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username    text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9._]{3,30}$'),
  full_name   text NOT NULL DEFAULT '',
  phone       text NOT NULL DEFAULT '',
  permissions text[] NOT NULL DEFAULT '{}',
  is_disabled boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE staff_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_members_self_read" ON staff_members;
CREATE POLICY "staff_members_self_read"
  ON staff_members FOR SELECT TO authenticated
  USING (id = auth.uid());

DROP POLICY IF EXISTS "staff_members_admin_read" ON staff_members;
CREATE POLICY "staff_members_admin_read"
  ON staff_members FOR SELECT TO authenticated
  USING (is_admin());

-- Reads only. Every write goes through a SECURITY DEFINER function below.
REVOKE ALL ON staff_members FROM anon, authenticated;
GRANT SELECT ON staff_members TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON staff_members TO service_role;

-- The Super Admin's username. The first admin account becomes 'naeem'.
INSERT INTO staff_members (id, username, full_name, phone)
SELECT a.id,
       CASE WHEN a.rn = 1 THEN 'naeem' ELSE 'admin' || a.rn END,
       COALESCE(a.full_name, ''), COALESCE(a.phone, '')
FROM (
  SELECT p.id, p.full_name, p.phone,
         row_number() OVER (ORDER BY p.created_at, p.id) AS rn
  FROM profiles p
  WHERE p.role = 'admin'
) a
ON CONFLICT (id) DO NOTHING;

-- The permission names a moderator can be given. Anything else is refused.
CREATE OR REPLACE FUNCTION staff_permission_names()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'view_orders', 'change_order_status', 'create_orders', 'book_steadfast',
    'edit_products', 'edit_categories', 'view_customers', 'delete_early_orders'
  ];
$$;

-- True for the Super Admin, or for an active (not disabled) moderator who
-- has this permission switched on. Checked on EVERY moderator action, so a
-- moderator who is disabled or deleted loses access on their next click,
-- even if their browser still holds a login.
CREATE OR REPLACE FUNCTION staff_can(p_perm text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT is_admin() OR EXISTS (
    SELECT 1
    FROM profiles p
    JOIN staff_members s ON s.id = p.id
    WHERE p.id = auth.uid()
      AND p.role = 'moderator'
      AND p.status = 'approved'
      AND NOT s.is_disabled
      AND p_perm = ANY (s.permissions)
  );
$$;

-- True for the Super Admin or any active moderator.
CREATE OR REPLACE FUNCTION is_staff()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT is_admin() OR EXISTS (
    SELECT 1
    FROM profiles p
    JOIN staff_members s ON s.id = p.id
    WHERE p.id = auth.uid()
      AND p.role = 'moderator'
      AND p.status = 'approved'
      AND NOT s.is_disabled
  );
$$;

GRANT EXECUTE ON FUNCTION staff_can(text) TO authenticated;
GRANT EXECUTE ON FUNCTION is_staff() TO authenticated;

-- The name shown for whoever is doing something right now.
CREATE OR REPLACE FUNCTION current_actor_username()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT s.username FROM staff_members s WHERE s.id = auth.uid()),
    (SELECT CASE WHEN p.role = 'admin' THEN 'naeem'
                 WHEN p.role = 'moderator' THEN 'moderator'
                 ELSE 'customer' END
       FROM profiles p WHERE p.id = auth.uid()),
    CASE WHEN auth.uid() IS NULL
         THEN COALESCE(NULLIF(current_setting('app.actor_label', true), ''), 'system')
         ELSE 'customer' END
  );
$$;

-- Moderators with "Edit products and stock" see (and so keep) the wholesale
-- price in the product editor — without this the editor would load an
-- empty wholesale price and save it back as empty.
CREATE OR REPLACE FUNCTION is_wholesaler_or_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
      AND status = 'approved'
      AND role IN ('wholesaler', 'admin')
  ) OR EXISTS (
    SELECT 1
    FROM profiles p
    JOIN staff_members s ON s.id = p.id
    WHERE p.id = auth.uid()
      AND p.role = 'moderator'
      AND p.status = 'approved'
      AND NOT s.is_disabled
      AND 'edit_products' = ANY (s.permissions)
  );
$$;


-- ============================================================
-- PART 2 — activity log (insert-only)
-- ============================================================

CREATE TABLE IF NOT EXISTS activity_log (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- No foreign key on purpose: deleting a moderator must never touch or
  -- remove their past entries. actor_username is a snapshot.
  actor_id       uuid,
  actor_username text NOT NULL,
  action         text NOT NULL,
  entity_type    text,
  entity_id      text,
  entity_label   text,
  summary        text NOT NULL DEFAULT '',
  details        jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_actor ON activity_log (actor_username);
CREATE INDEX IF NOT EXISTS idx_activity_log_action ON activity_log (action);

ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "activity_log_admin_read" ON activity_log;
CREATE POLICY "activity_log_admin_read"
  ON activity_log FOR SELECT TO authenticated
  USING (is_admin());

REVOKE ALL ON activity_log FROM anon, authenticated;
GRANT SELECT ON activity_log TO authenticated;
GRANT SELECT ON activity_log TO service_role;

-- Nobody can edit or delete an entry, whatever role they have.
CREATE OR REPLACE FUNCTION activity_log_block_changes()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'The activity log cannot be changed or deleted.';
END;
$$;

DROP TRIGGER IF EXISTS activity_log_no_update ON activity_log;
CREATE TRIGGER activity_log_no_update
  BEFORE UPDATE OR DELETE ON activity_log
  FOR EACH ROW EXECUTE FUNCTION activity_log_block_changes();

DROP TRIGGER IF EXISTS activity_log_no_truncate ON activity_log;
CREATE TRIGGER activity_log_no_truncate
  BEFORE TRUNCATE ON activity_log
  FOR EACH STATEMENT EXECUTE FUNCTION activity_log_block_changes();

-- Internal writer. Not callable from the browser (EXECUTE revoked below);
-- only the database's own triggers/functions use it.
CREATE OR REPLACE FUNCTION write_activity(
  p_action       text,
  p_entity_type  text,
  p_entity_id    text,
  p_entity_label text,
  p_summary      text,
  p_details      jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO activity_log (actor_id, actor_username, action, entity_type, entity_id, entity_label, summary, details)
  VALUES (auth.uid(), current_actor_username(), p_action, p_entity_type, p_entity_id,
          p_entity_label, COALESCE(p_summary, ''), COALESCE(p_details, '{}'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION write_activity(text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;

-- Shortens long values (banner JSON, descriptions) before they go in the log.
CREATE OR REPLACE FUNCTION activity_short(p_value jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_value IS NULL THEN 'null'::jsonb
    WHEN jsonb_typeof(p_value) = 'string' AND length(p_value #>> '{}') > 200
      THEN to_jsonb(left(p_value #>> '{}', 200) || '…')
    WHEN jsonb_typeof(p_value) IN ('array', 'object') AND length(p_value::text) > 200
      THEN to_jsonb(left(p_value::text, 200) || '…')
    ELSE p_value
  END;
$$;

-- Staff can record their own login / password change / logout. Nothing
-- else can be written this way.
CREATE OR REPLACE FUNCTION log_staff_event(p_action text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_action NOT IN ('staff.login', 'staff.logout', 'staff.password_changed') THEN
    RAISE EXCEPTION 'Invalid event.';
  END IF;
  IF NOT is_staff() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  PERFORM write_activity(
    p_action, 'staff', auth.uid()::text, current_actor_username(),
    CASE p_action
      WHEN 'staff.login' THEN 'Signed in'
      WHEN 'staff.logout' THEN 'Signed out'
      ELSE 'Changed own password'
    END
  );
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION log_staff_event(text) TO authenticated;

-- A diff of two rows as {"field": {"from": .., "to": ..}}, skipping the
-- bookkeeping columns.
CREATE OR REPLACE FUNCTION activity_row_diff(p_old jsonb, p_new jsonb, p_skip text[])
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(jsonb_object_agg(k, jsonb_build_object(
           'from', activity_short(p_old -> k),
           'to',   activity_short(p_new -> k))), '{}'::jsonb)
  FROM (
    SELECT k FROM jsonb_object_keys(COALESCE(p_new, '{}'::jsonb)) AS k
    UNION
    SELECT k FROM jsonb_object_keys(COALESCE(p_old, '{}'::jsonb)) AS k
  ) keys
  WHERE NOT (k = ANY (p_skip))
    AND (p_old -> k) IS DISTINCT FROM (p_new -> k);
$$;

-- ---------- order_status_history: remember WHO by username ----------
ALTER TABLE order_status_history
  ADD COLUMN IF NOT EXISTS changed_by_username text;

CREATE OR REPLACE FUNCTION order_history_set_username()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.changed_by_username IS NULL THEN
    NEW.changed_by_username := CASE
      WHEN NEW.changed_by IS NULL THEN COALESCE(NULLIF(current_setting('app.actor_label', true), ''), 'system')
      WHEN NEW.changed_by = auth.uid() THEN current_actor_username()
      ELSE COALESCE(
        (SELECT s.username FROM staff_members s WHERE s.id = NEW.changed_by),
        (SELECT CASE WHEN p.role = 'admin' THEN 'naeem' ELSE 'customer' END
           FROM profiles p WHERE p.id = NEW.changed_by),
        'customer')
    END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS order_history_username ON order_status_history;
CREATE TRIGGER order_history_username
  BEFORE INSERT ON order_status_history
  FOR EACH ROW EXECUTE FUNCTION order_history_set_username();

-- Existing rows: fill in the name once.
UPDATE order_status_history h
SET changed_by_username = COALESCE(
  (SELECT s.username FROM staff_members s WHERE s.id = h.changed_by),
  (SELECT CASE WHEN p.role = 'admin' THEN 'naeem' ELSE 'customer' END
     FROM profiles p WHERE p.id = h.changed_by),
  CASE WHEN h.changed_by IS NULL THEN 'system' ELSE 'customer' END)
WHERE h.changed_by_username IS NULL;

-- ---------- orders: new bookkeeping columns ----------
-- stock_released: true once this order's stock has been put back (it was
-- cancelled). Deleting an order restores stock only when this is false, so
-- stock is never put back twice.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS stock_released boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS steadfast_status_updated_at timestamptz;

UPDATE orders SET stock_released = true
WHERE status = 'cancelled' AND stock_released = false;

UPDATE orders SET steadfast_status_updated_at = updated_at
WHERE steadfast_status IS NOT NULL AND steadfast_status_updated_at IS NULL;

CREATE OR REPLACE FUNCTION orders_track_courier_time()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.steadfast_status IS DISTINCT FROM OLD.steadfast_status THEN
    NEW.steadfast_status_updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_courier_time ON orders;
CREATE TRIGGER orders_courier_time
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_track_courier_time();

-- ---------- orders: activity trigger ----------
-- Logs what staff (and the automatic Steadfast refresh) do to an order.
-- Customer actions (placing, cancelling their own order) are not admin
-- actions and are not logged here — they are in the order's own history.
CREATE OR REPLACE FUNCTION orders_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT is_staff() THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM write_activity(
      'order.deleted', 'order', OLD.id::text, OLD.order_number,
      format('Deleted order %s (%s, ৳%s, was %s)', OLD.order_number, OLD.customer_name, OLD.total, OLD.status),
      jsonb_build_object(
        'order_number', OLD.order_number,
        'customer_name', OLD.customer_name,
        'customer_phone', OLD.customer_phone,
        'total', OLD.total,
        'status', OLD.status,
        'steadfast_consignment_id', OLD.steadfast_consignment_id
      )
    );
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.source <> 'web' THEN
      PERFORM write_activity(
        'order.created', 'order', NEW.id::text, NEW.order_number,
        format('Created manual order %s for %s (৳%s)', NEW.order_number, NEW.customer_name, NEW.total),
        jsonb_build_object('source', NEW.source, 'total', NEW.total)
      );
    END IF;
    RETURN NULL;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM write_activity(
      'order.status', 'order', NEW.id::text, NEW.order_number,
      format('Status %s → %s', OLD.status, NEW.status),
      jsonb_build_object('status', jsonb_build_object('from', OLD.status, 'to', NEW.status))
    );
  END IF;
  IF NEW.payment_status IS DISTINCT FROM OLD.payment_status THEN
    PERFORM write_activity(
      'order.payment', 'order', NEW.id::text, NEW.order_number,
      format('Payment %s → %s', OLD.payment_status, NEW.payment_status),
      jsonb_build_object('payment_status', jsonb_build_object('from', OLD.payment_status, 'to', NEW.payment_status))
    );
  END IF;
  IF NEW.tracking_number IS DISTINCT FROM OLD.tracking_number
     AND NEW.steadfast_consignment_id IS NOT DISTINCT FROM OLD.steadfast_consignment_id THEN
    PERFORM write_activity(
      'order.tracking', 'order', NEW.id::text, NEW.order_number,
      format('Tracking number %s → %s', COALESCE(OLD.tracking_number, '(none)'), COALESCE(NEW.tracking_number, '(none)')),
      jsonb_build_object('tracking_number', jsonb_build_object('from', OLD.tracking_number, 'to', NEW.tracking_number))
    );
  END IF;
  IF NEW.admin_note IS DISTINCT FROM OLD.admin_note THEN
    PERFORM write_activity(
      'order.note', 'order', NEW.id::text, NEW.order_number, 'Admin note changed',
      jsonb_build_object('admin_note', jsonb_build_object('from', OLD.admin_note, 'to', NEW.admin_note))
    );
  END IF;
  IF NEW.delivery_fee IS DISTINCT FROM OLD.delivery_fee THEN
    PERFORM write_activity(
      'order.delivery_fee', 'order', NEW.id::text, NEW.order_number,
      format('Delivery fee ৳%s → ৳%s', OLD.delivery_fee, NEW.delivery_fee),
      jsonb_build_object('delivery_fee', jsonb_build_object('from', OLD.delivery_fee, 'to', NEW.delivery_fee))
    );
  END IF;
  IF OLD.steadfast_consignment_id IS NULL AND NEW.steadfast_consignment_id IS NOT NULL THEN
    PERFORM write_activity(
      'order.steadfast_booked', 'order', NEW.id::text, NEW.order_number,
      format('Booked on Steadfast (consignment %s)', NEW.steadfast_consignment_id),
      jsonb_build_object('consignment_id', NEW.steadfast_consignment_id, 'tracking_code', NEW.steadfast_tracking_code)
    );
  ELSIF NEW.steadfast_status IS DISTINCT FROM OLD.steadfast_status THEN
    PERFORM write_activity(
      'order.steadfast_status', 'order', NEW.id::text, NEW.order_number,
      format('Courier status %s → %s', COALESCE(OLD.steadfast_status, '(none)'), COALESCE(NEW.steadfast_status, '(none)')),
      jsonb_build_object('steadfast_status', jsonb_build_object('from', OLD.steadfast_status, 'to', NEW.steadfast_status))
    );
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS orders_activity_log ON orders;
CREATE TRIGGER orders_activity_log
  AFTER INSERT OR UPDATE OR DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_activity();

-- ---------- products: "last updated by" + activity ----------
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS last_edited_by text,
  ADD COLUMN IF NOT EXISTS last_edited_at timestamptz;

-- Stock that moves because of an ORDER (created, cancelled, deleted) is
-- not a product edit — the order functions switch this flag on around
-- their stock updates so it isn't logged as one.
CREATE OR REPLACE FUNCTION order_stock_change_in_progress()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(current_setting('app.order_stock_change', true), '') = 'on';
$$;

CREATE OR REPLACE FUNCTION products_stamp_editor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF is_staff() AND NOT order_stock_change_in_progress() THEN
    NEW.last_edited_by := current_actor_username();
    NEW.last_edited_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS products_stamp_editor ON products;
CREATE TRIGGER products_stamp_editor
  BEFORE INSERT OR UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION products_stamp_editor();

CREATE OR REPLACE FUNCTION products_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_diff jsonb;
  v_skip text[] := ARRAY['updated_at', 'created_at', 'last_edited_by', 'last_edited_at', 'image_urls_thumb'];
BEGIN
  IF NOT is_staff() OR order_stock_change_in_progress() THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM write_activity('product.created', 'product', NEW.id::text, NEW.name,
      format('Added product "%s"', NEW.name), '{}'::jsonb);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM write_activity('product.deleted', 'product', OLD.id::text, OLD.name,
      format('Deleted product "%s"', OLD.name), '{}'::jsonb);
  ELSE
    v_diff := activity_row_diff(to_jsonb(OLD), to_jsonb(NEW), v_skip);
    IF v_diff <> '{}'::jsonb THEN
      PERFORM write_activity('product.updated', 'product', NEW.id::text, NEW.name,
        format('Edited "%s": %s', NEW.name,
               (SELECT string_agg(k, ', ' ORDER BY k) FROM jsonb_object_keys(v_diff) k)),
        v_diff);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS products_activity_log ON products;
CREATE TRIGGER products_activity_log
  AFTER INSERT OR UPDATE OR DELETE ON products
  FOR EACH ROW EXECUTE FUNCTION products_activity();

CREATE OR REPLACE FUNCTION product_variants_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product_id uuid;
  v_product_name text;
  v_label text;
  v_diff jsonb;
BEGIN
  IF NOT is_staff() OR order_stock_change_in_progress() THEN
    RETURN NULL;
  END IF;

  v_product_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.product_id ELSE NEW.product_id END;
  SELECT name INTO v_product_name FROM products WHERE id = v_product_id;
  IF NOT FOUND THEN
    -- The whole product is being deleted; that is logged once, on the product.
    RETURN NULL;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_label := concat_ws(' · ', OLD.region, OLD.size);
    PERFORM write_activity('product.variant_deleted', 'product', v_product_id::text, v_product_name,
      format('Removed option %s from "%s"', v_label, v_product_name), '{}'::jsonb);
  ELSIF TG_OP = 'INSERT' THEN
    v_label := concat_ws(' · ', NEW.region, NEW.size);
    PERFORM write_activity('product.variant_added', 'product', v_product_id::text, v_product_name,
      format('Added option %s to "%s"', v_label, v_product_name), '{}'::jsonb);
  ELSE
    v_label := concat_ws(' · ', NEW.region, NEW.size);
    v_diff := activity_row_diff(to_jsonb(OLD), to_jsonb(NEW), ARRAY['created_at', 'updated_at']);
    IF v_diff = '{}'::jsonb THEN
      RETURN NULL;
    END IF;
    PERFORM write_activity('product.variant_updated', 'product', v_product_id::text, v_product_name,
      format('Edited option %s of "%s": %s', v_label, v_product_name,
             (SELECT string_agg(k, ', ' ORDER BY k) FROM jsonb_object_keys(v_diff) k)),
      v_diff);
  END IF;

  -- "Last updated by" on the product itself.
  UPDATE products
  SET last_edited_by = current_actor_username(), last_edited_at = now()
  WHERE id = v_product_id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS product_variants_activity_log ON product_variants;
CREATE TRIGGER product_variants_activity_log
  AFTER INSERT OR UPDATE OR DELETE ON product_variants
  FOR EACH ROW EXECUTE FUNCTION product_variants_activity();

-- ---------- categories, settings, promo codes, reviews, bento, wholesalers ----------
-- One shared trigger for the simpler tables: logs who added / changed /
-- removed a row, with before → after for changes.
CREATE OR REPLACE FUNCTION generic_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old jsonb := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END;
  v_new jsonb := CASE WHEN TG_OP IN ('UPDATE', 'INSERT') THEN to_jsonb(NEW) END;
  v_row jsonb := COALESCE(v_new, v_old);
  v_label text;
  v_entity_id text;
  v_diff jsonb;
  v_kind text := TG_ARGV[0];
BEGIN
  IF NOT is_staff() THEN
    RETURN NULL;
  END IF;

  v_label := COALESCE(v_row ->> 'name', v_row ->> 'code', v_row ->> 'key',
                      v_row ->> 'business_name', v_row ->> 'reviewer_name', v_row ->> 'title',
                      v_row ->> 'id');
  v_entity_id := COALESCE(v_row ->> 'id', v_row ->> 'key');

  IF TG_OP = 'UPDATE' THEN
    v_diff := activity_row_diff(v_old, v_new, ARRAY['updated_at', 'created_at']);
    IF v_diff = '{}'::jsonb THEN
      RETURN NULL;
    END IF;
    PERFORM write_activity(v_kind || '.updated', v_kind, v_entity_id, v_label,
      format('Changed %s "%s"', v_kind, v_label), v_diff);
  ELSIF TG_OP = 'INSERT' THEN
    PERFORM write_activity(v_kind || '.created', v_kind, v_entity_id, v_label,
      format('Added %s "%s"', v_kind, v_label),
      CASE WHEN v_kind = 'setting'
           THEN jsonb_build_object('value', jsonb_build_object('from', NULL, 'to', activity_short(v_new -> 'value')))
           ELSE '{}'::jsonb END);
  ELSE
    PERFORM write_activity(v_kind || '.deleted', v_kind, v_entity_id, v_label,
      format('Removed %s "%s"', v_kind, v_label), '{}'::jsonb);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS categories_activity_log ON categories;
CREATE TRIGGER categories_activity_log
  AFTER INSERT OR UPDATE OR DELETE ON categories
  FOR EACH ROW EXECUTE FUNCTION generic_activity('category');

DROP TRIGGER IF EXISTS app_settings_activity_log ON app_settings;
CREATE TRIGGER app_settings_activity_log
  AFTER INSERT OR UPDATE OR DELETE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION generic_activity('setting');

DROP TRIGGER IF EXISTS promo_codes_activity_log ON promo_codes;
CREATE TRIGGER promo_codes_activity_log
  AFTER INSERT OR UPDATE OR DELETE ON promo_codes
  FOR EACH ROW EXECUTE FUNCTION generic_activity('promo_code');

DROP TRIGGER IF EXISTS reviews_activity_log ON reviews;
CREATE TRIGGER reviews_activity_log
  AFTER INSERT OR UPDATE OR DELETE ON reviews
  FOR EACH ROW EXECUTE FUNCTION generic_activity('review');

DO $$
BEGIN
  IF to_regclass('public.bento_tiles') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS bento_tiles_activity_log ON bento_tiles';
    EXECUTE 'CREATE TRIGGER bento_tiles_activity_log AFTER INSERT OR UPDATE OR DELETE ON bento_tiles
             FOR EACH ROW EXECUTE FUNCTION generic_activity(''bento_tile'')';
  END IF;
END $$;

-- Wholesaler approve / reject / revoke (Super Admin, Wholesalers tab).
CREATE OR REPLACE FUNCTION profiles_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_staff() THEN
    RETURN NULL;
  END IF;
  IF NEW.role = 'wholesaler'
     AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.business_name IS DISTINCT FROM OLD.business_name) THEN
    PERFORM write_activity('wholesaler.updated', 'wholesaler', NEW.id::text,
      COALESCE(NEW.business_name, NEW.id::text),
      format('Wholesaler "%s": %s → %s', COALESCE(NEW.business_name, ''), OLD.status, NEW.status),
      activity_row_diff(to_jsonb(OLD), to_jsonb(NEW), ARRAY['created_at']));
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS profiles_activity_log ON profiles;
CREATE TRIGGER profiles_activity_log
  AFTER UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION profiles_activity();


-- ============================================================
-- PART 3 — what moderators may read and write (RLS)
-- Every policy here is ADDED next to the existing admin ones; nothing the
-- Super Admin could do before is taken away.
-- ============================================================

DROP POLICY IF EXISTS "orders_staff_read" ON orders;
CREATE POLICY "orders_staff_read"
  ON orders FOR SELECT TO authenticated
  USING (staff_can('view_orders'));

DROP POLICY IF EXISTS "order_items_staff_read" ON order_items;
CREATE POLICY "order_items_staff_read"
  ON order_items FOR SELECT TO authenticated
  USING (staff_can('view_orders'));

DROP POLICY IF EXISTS "order_status_history_staff_read" ON order_status_history;
CREATE POLICY "order_status_history_staff_read"
  ON order_status_history FOR SELECT TO authenticated
  USING (staff_can('view_orders'));

-- Customer accounts (read only) — "View customers".
DROP POLICY IF EXISTS "profiles_staff_read_customers" ON profiles;
CREATE POLICY "profiles_staff_read_customers"
  ON profiles FOR SELECT TO authenticated
  USING (role IN ('customer', 'wholesaler') AND staff_can('view_customers'));

-- Products: add and edit (not delete) — "Edit products and stock".
DROP POLICY IF EXISTS "products_staff_read" ON products;
CREATE POLICY "products_staff_read"
  ON products FOR SELECT TO authenticated
  USING (staff_can('edit_products'));

DROP POLICY IF EXISTS "products_staff_insert" ON products;
CREATE POLICY "products_staff_insert"
  ON products FOR INSERT TO authenticated
  WITH CHECK (staff_can('edit_products'));

DROP POLICY IF EXISTS "products_staff_update" ON products;
CREATE POLICY "products_staff_update"
  ON products FOR UPDATE TO authenticated
  USING (staff_can('edit_products'))
  WITH CHECK (staff_can('edit_products'));

DROP POLICY IF EXISTS "product_variants_staff_all" ON product_variants;
CREATE POLICY "product_variants_staff_all"
  ON product_variants FOR ALL TO authenticated
  USING (staff_can('edit_products'))
  WITH CHECK (staff_can('edit_products'));

DROP POLICY IF EXISTS "product_images_staff_insert" ON storage.objects;
CREATE POLICY "product_images_staff_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'product-images' AND staff_can('edit_products'));

DROP POLICY IF EXISTS "product_images_staff_update" ON storage.objects;
CREATE POLICY "product_images_staff_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'product-images' AND staff_can('edit_products'))
  WITH CHECK (bucket_id = 'product-images' AND staff_can('edit_products'));

DROP POLICY IF EXISTS "product_images_staff_delete" ON storage.objects;
CREATE POLICY "product_images_staff_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'product-images' AND staff_can('edit_products'));

-- Categories — "Edit categories".
DROP POLICY IF EXISTS "categories_staff_write" ON categories;
CREATE POLICY "categories_staff_write"
  ON categories FOR ALL TO authenticated
  USING (staff_can('edit_categories'))
  WITH CHECK (staff_can('edit_categories'));

-- The Wholesalers list (read only for a moderator with "View customers").
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
  WHERE (is_admin() OR staff_can('view_customers')) AND p.role = 'wholesaler'
  ORDER BY p.created_at DESC;
$$;


-- ============================================================
-- PART 4 — order number format
-- ============================================================

-- Defaults are exactly today's format ("NM-1037"), so nothing changes
-- until Naeem edits them in Admin → Settings → Orders.
INSERT INTO app_settings (key, value) VALUES
  ('order_number_prefix', 'NM-'),
  ('order_number_suffix', '')
ON CONFLICT (key) DO NOTHING;

-- The only place an order number is made. The sequence hands out each
-- number once, even for orders placed at the same instant; the loop is a
-- last safety net in case a prefix/suffix change ever spells an old number.
CREATE OR REPLACE FUNCTION next_order_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prefix    text;
  v_suffix    text;
  v_candidate text;
BEGIN
  SELECT COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_prefix'), 'NM-') INTO v_prefix;
  SELECT COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_suffix'), '') INTO v_suffix;
  LOOP
    v_candidate := v_prefix || nextval('order_number_seq') || v_suffix;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM orders WHERE order_number = v_candidate);
  END LOOP;
  RETURN v_candidate;
END;
$$;

REVOKE ALL ON FUNCTION next_order_number() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION order_number_next_value()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END FROM order_number_seq;
$$;

REVOKE ALL ON FUNCTION order_number_next_value() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION admin_order_number_info()
RETURNS TABLE (prefix text, next_number bigint, suffix text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  RETURN QUERY SELECT
    COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_prefix'), 'NM-'),
    order_number_next_value(),
    COALESCE((SELECT value FROM app_settings WHERE key = 'order_number_suffix'), '');
END;
$$;

GRANT EXECUTE ON FUNCTION admin_order_number_info() TO authenticated;

CREATE OR REPLACE FUNCTION admin_set_order_number_format(p_prefix text, p_next_number bigint, p_suffix text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current bigint;
  v_prefix  text := COALESCE(p_prefix, '');
  v_suffix  text := COALESCE(p_suffix, '');
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF v_prefix !~ '^[A-Za-z0-9._/#-]{0,12}$' OR v_suffix !~ '^[A-Za-z0-9._/#-]{0,12}$' THEN
    RAISE EXCEPTION 'Prefix and suffix may use letters, numbers and - _ . / # (up to 12 characters).';
  END IF;
  IF p_next_number IS NULL OR p_next_number < 1 THEN
    RAISE EXCEPTION 'Next number must be 1 or more.';
  END IF;

  -- One change at a time.
  PERFORM pg_advisory_xact_lock(hashtext('order_number_format'));
  v_current := order_number_next_value();
  IF p_next_number < v_current THEN
    RAISE EXCEPTION 'The next number can only go up. It is now %.', v_current;
  END IF;
  IF p_next_number > v_current THEN
    PERFORM setval('order_number_seq', p_next_number, false);
    PERFORM write_activity('settings.order_number', 'setting', 'order_number_seq', 'Next order number',
      format('Next order number %s → %s', v_current, p_next_number),
      jsonb_build_object('next_number', jsonb_build_object('from', v_current, 'to', p_next_number)));
  END IF;

  INSERT INTO app_settings (key, value) VALUES
    ('order_number_prefix', v_prefix),
    ('order_number_suffix', v_suffix)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_set_order_number_format(text, bigint, text) TO authenticated;


-- ============================================================
-- PART 5 — order functions (same names and arguments as before)
-- ============================================================

-- place_order: identical to migration-022, except the order number comes
-- from next_order_number() (prefix/suffix setting).
CREATE OR REPLACE FUNCTION place_order(
  p_items          jsonb,
  p_full_name      text,
  p_phone          text,
  p_division       text,
  p_district       text,
  p_thana          text,
  p_address_line   text,
  p_delivery_zone  text,
  p_payment_method text,
  p_bkash_trx_id   text DEFAULT NULL,
  p_bkash_sender   text DEFAULT NULL,
  p_promo_code     text DEFAULT NULL,
  p_customer_note  text DEFAULT NULL
)
RETURNS TABLE (order_id uuid, order_number text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  v_region           text;
  v_size             text;
  v_subtotal         numeric(10,2) := 0;
  v_delivery_fee     numeric(10,2);
  v_discount         numeric(10,2) := 0;
  v_total            numeric(10,2);
  v_promo_row        promo_codes%ROWTYPE;
  v_promo_ok         boolean;
  v_order_id         uuid;
  v_order_number     text;
  v_item_count       integer := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to place an order.';
  END IF;

  IF p_payment_method NOT IN ('cod', 'bkash') THEN
    RAISE EXCEPTION 'Invalid payment method.';
  END IF;
  IF p_payment_method = 'bkash' AND (p_bkash_trx_id IS NULL OR trim(p_bkash_trx_id) = '') THEN
    RAISE EXCEPTION 'A bKash Transaction ID is required for bKash payment.';
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

  SELECT COALESCE(
    (SELECT value::numeric FROM app_settings WHERE key = 'delivery_fee_' || p_delivery_zone),
    CASE WHEN p_delivery_zone = 'inside_dhaka' THEN 80 ELSE 130 END
  ) INTO v_delivery_fee;

  CREATE TEMP TABLE IF NOT EXISTS _order_lines (
    product_id    uuid,
    variant_id    uuid,
    product_name  text,
    variant_label text,
    image_url     text,
    unit_price    numeric(10,2),
    quantity      integer,
    line_total    numeric(10,2)
  ) ON COMMIT DROP;
  TRUNCATE _order_lines;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_item_count := v_item_count + 1;
    v_product_id := (v_item->>'product_id')::uuid;
    v_variant_id := NULLIF(v_item->>'variant_id', '')::uuid;
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
        p.is_active
      INTO v_unit_price, v_stock_quantity, v_in_stock_flag, v_region, v_size,
           v_image_url, v_product_name, v_is_active
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
        p.is_active
      INTO v_unit_price, v_stock_quantity, v_in_stock_flag, v_image_url, v_product_name, v_is_active
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

    IF v_stock_quantity IS NOT NULL THEN
      IF v_stock_quantity < v_quantity THEN
        RAISE EXCEPTION 'Only % of "%" left in stock.', v_stock_quantity, v_product_name;
      END IF;
    ELSIF NOT v_in_stock_flag THEN
      RAISE EXCEPTION '"%" is out of stock.', v_product_name;
    END IF;

    INSERT INTO _order_lines (product_id, variant_id, product_name, variant_label, image_url, unit_price, quantity, line_total)
    VALUES (v_product_id, v_variant_id, v_product_name, v_variant_label, v_image_url, v_unit_price, v_quantity, v_unit_price * v_quantity);

    v_subtotal := v_subtotal + (v_unit_price * v_quantity);

    IF v_stock_quantity IS NOT NULL THEN
      IF v_variant_id IS NOT NULL THEN
        UPDATE product_variants SET stock_quantity = stock_quantity - v_quantity WHERE id = v_variant_id;
      ELSE
        UPDATE products SET stock_quantity = stock_quantity - v_quantity WHERE id = v_product_id;
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

  v_total := GREATEST(v_subtotal + v_delivery_fee - v_discount, 0);
  v_order_number := next_order_number();

  INSERT INTO orders (
    order_number, customer_id, customer_name, customer_phone,
    division, district, thana, address_line,
    delivery_zone, delivery_fee, subtotal, discount, list_value,
    promo_code, total, payment_method, bkash_trx_id, bkash_sender,
    payment_status, customer_note
  ) VALUES (
    v_order_number, v_uid, trim(p_full_name), p_phone,
    p_division, p_district, p_thana, trim(p_address_line),
    p_delivery_zone, v_delivery_fee, v_subtotal, v_discount, v_subtotal,
    NULLIF(trim(COALESCE(p_promo_code, '')), ''), v_total, p_payment_method,
    NULLIF(trim(COALESCE(p_bkash_trx_id, '')), ''), NULLIF(trim(COALESCE(p_bkash_sender, '')), ''),
    CASE WHEN p_payment_method = 'bkash' THEN 'pending_verification' ELSE 'unpaid' END,
    NULLIF(trim(COALESCE(p_customer_note, '')), '')
  )
  RETURNING id INTO v_order_id;

  INSERT INTO order_items (order_id, product_id, variant_id, product_name, variant_label, image_url, unit_price, quantity, line_total, list_price)
  SELECT v_order_id, product_id, variant_id, product_name, variant_label, image_url, unit_price, quantity, line_total, unit_price
  FROM _order_lines;

  INSERT INTO order_status_history (order_id, old_status, new_status, changed_by)
  VALUES (v_order_id, NULL, 'pending', v_uid);

  RETURN QUERY SELECT v_order_id, v_order_number;
END;
$$;

-- Website orders placed since migration-028 saved list price ৳0 (the old
-- place_order didn't fill it in), which made the admin screen show
-- "List ৳0" under normal items. Fix those rows once.
UPDATE order_items SET list_price = unit_price WHERE list_price = 0 AND unit_price > 0;
UPDATE orders SET list_value = subtotal WHERE list_value = 0 AND subtotal > 0;

GRANT EXECUTE ON FUNCTION place_order(jsonb, text, text, text, text, text, text, text, text, text, text, text, text) TO authenticated;

-- cancel_order: same as migration-028, plus
--   - a moderator with "Change order status" can cancel like the admin;
--   - stock_released is set, so a later delete never restores stock again.
CREATE OR REPLACE FUNCTION cancel_order(p_order_id uuid, p_note text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_order    orders%ROWTYPE;
  v_line     record;
  v_is_staff boolean := staff_can('change_order_status');
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'You must be signed in.';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;

  IF (v_order.customer_id IS NULL OR v_order.customer_id <> v_uid) AND NOT v_is_staff THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;

  IF v_is_staff THEN
    IF v_order.status NOT IN ('pending', 'confirmed') THEN
      RAISE EXCEPTION 'Only a pending or confirmed order can be cancelled.';
    END IF;
  ELSE
    IF v_order.status <> 'pending' THEN
      RAISE EXCEPTION 'This order can no longer be cancelled — please contact us.';
    END IF;
  END IF;

  IF NOT v_order.stock_released THEN
    PERFORM set_config('app.order_stock_change', 'on', true);
    FOR v_line IN SELECT * FROM order_items WHERE order_id = p_order_id
    LOOP
      IF v_line.variant_id IS NOT NULL THEN
        UPDATE product_variants SET stock_quantity = stock_quantity + v_line.quantity
          WHERE id = v_line.variant_id AND stock_quantity IS NOT NULL;
      ELSIF v_line.product_id IS NOT NULL THEN
        UPDATE products SET stock_quantity = stock_quantity + v_line.quantity
          WHERE id = v_line.product_id AND stock_quantity IS NOT NULL;
      END IF;
    END LOOP;
    PERFORM set_config('app.order_stock_change', 'off', true);
  END IF;

  UPDATE orders SET status = 'cancelled', stock_released = true, updated_at = now() WHERE id = p_order_id;
  INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, note)
  VALUES (p_order_id, v_order.status, 'cancelled', v_uid, p_note);

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION cancel_order(uuid, text) TO authenticated;

-- admin_set_order_status: "Change order status" permission.
CREATE OR REPLACE FUNCTION admin_set_order_status(p_order_id uuid, p_new_status text, p_note text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_status text;
BEGIN
  IF NOT staff_can('change_order_status') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_new_status NOT IN ('pending', 'confirmed', 'shipped', 'delivered', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid status.';
  END IF;

  SELECT status INTO v_old_status FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;

  IF p_new_status = 'cancelled' AND v_old_status <> 'cancelled' THEN
    PERFORM cancel_order(p_order_id, p_note);
    RETURN true;
  END IF;

  UPDATE orders SET status = p_new_status, updated_at = now() WHERE id = p_order_id;
  INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, note)
  VALUES (p_order_id, v_old_status, p_new_status, auth.uid(), p_note);

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_set_order_status(uuid, text, text) TO authenticated;

-- Payment status / tracking number / admin note. Replaces the admin
-- panel's plain UPDATE in the new code, so a moderator can be allowed to do
-- this without being able to change the status column directly.
CREATE OR REPLACE FUNCTION admin_update_order_fields(p_order_id uuid, p_fields jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order orders%ROWTYPE;
BEGIN
  IF NOT staff_can('change_order_status') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;
  IF p_fields ? 'payment_status'
     AND (p_fields ->> 'payment_status') NOT IN ('unpaid', 'pending_verification', 'paid') THEN
    RAISE EXCEPTION 'Invalid payment status.';
  END IF;

  UPDATE orders SET
    payment_status  = CASE WHEN p_fields ? 'payment_status' THEN p_fields ->> 'payment_status' ELSE payment_status END,
    tracking_number = CASE WHEN p_fields ? 'tracking_number' THEN NULLIF(trim(COALESCE(p_fields ->> 'tracking_number', '')), '') ELSE tracking_number END,
    admin_note      = CASE WHEN p_fields ? 'admin_note' THEN NULLIF(trim(COALESCE(p_fields ->> 'admin_note', '')), '') ELSE admin_note END,
    updated_at      = now()
  WHERE id = p_order_id;
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_update_order_fields(uuid, jsonb) TO authenticated;

-- admin_create_order: same as migration-028, plus
--   - "Create manual orders" permission;
--   - a moderator can only sell at the real price (no custom prices, no
--     free items, no order discount — money changes are Super Admin only);
--   - the order number comes from next_order_number().
CREATE OR REPLACE FUNCTION admin_create_order(
  p_source              text,
  p_items               jsonb,
  p_full_name           text,
  p_phone               text,
  p_division            text,
  p_district            text,
  p_thana               text,
  p_address_line        text,
  p_delivery_zone       text,
  p_delivery_fee        numeric,
  p_order_discount      numeric DEFAULT 0,
  p_discount_reason     text DEFAULT NULL,
  p_discount_note       text DEFAULT NULL,
  p_payment_method      text DEFAULT 'cod',
  p_bkash_trx_id        text DEFAULT NULL,
  p_bkash_sender        text DEFAULT NULL,
  p_linked_customer_id  uuid DEFAULT NULL,
  p_mark_delivered      boolean DEFAULT false,
  p_admin_note          text DEFAULT NULL,
  p_allow_negative_stock boolean DEFAULT false
)
RETURNS TABLE (order_id uuid, order_number text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item             jsonb;
  v_product_id       uuid;
  v_variant_id       uuid;
  v_quantity         integer;
  v_sold_price_in    numeric(10,2);
  v_list_price       numeric(10,2);
  v_unit_price       numeric(10,2);
  v_product_name     text;
  v_variant_label    text;
  v_image_url        text;
  v_is_active        boolean;
  v_stock_quantity   integer;
  v_region           text;
  v_size             text;
  v_reason           text;
  v_reason_note      text;
  v_subtotal         numeric(10,2) := 0;
  v_list_value       numeric(10,2) := 0;
  v_free_value       numeric(10,2) := 0;
  v_delivery_fee     numeric(10,2);
  v_discount         numeric(10,2);
  v_total            numeric(10,2);
  v_order_id         uuid;
  v_order_number     text;
  v_item_count       integer := 0;
  v_warnings         jsonb := '[]'::jsonb;
  v_payment_status   text;
  v_initial_status   text;
  v_is_admin         boolean := is_admin();
BEGIN
  IF NOT staff_can('create_orders') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  IF p_source NOT IN ('web', 'facebook', 'whatsapp', 'phone', 'shop', 'family', 'other') THEN
    RAISE EXCEPTION 'Invalid order source.';
  END IF;
  IF p_delivery_zone NOT IN ('inside_dhaka', 'outside_dhaka', 'hand_delivered') THEN
    RAISE EXCEPTION 'Invalid delivery zone.';
  END IF;
  IF p_payment_method NOT IN ('cod', 'bkash', 'cash', 'due') THEN
    RAISE EXCEPTION 'Invalid payment method.';
  END IF;
  IF p_full_name IS NULL OR trim(p_full_name) = '' THEN
    RAISE EXCEPTION 'Customer name is required.';
  END IF;
  IF p_address_line IS NULL OR trim(p_address_line) = '' THEN
    RAISE EXCEPTION 'Delivery address is required.';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Add at least one item.';
  END IF;
  IF NOT v_is_admin AND COALESCE(p_order_discount, 0) <> 0 THEN
    RAISE EXCEPTION 'Only the Super Admin can give a discount.';
  END IF;

  v_delivery_fee := CASE WHEN p_delivery_zone = 'hand_delivered' THEN 0
                          ELSE GREATEST(COALESCE(p_delivery_fee, 0), 0) END;
  v_discount := GREATEST(COALESCE(p_order_discount, 0), 0);

  CREATE TEMP TABLE IF NOT EXISTS _admin_order_lines (
    product_id        uuid,
    variant_id        uuid,
    product_name      text,
    variant_label     text,
    image_url         text,
    list_price        numeric(10,2),
    unit_price        numeric(10,2),
    quantity          integer,
    line_total        numeric(10,2),
    reason            text,
    reason_note       text,
    is_tracked_stock  boolean,
    stock_available   integer
  ) ON COMMIT DROP;
  TRUNCATE _admin_order_lines;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_item_count := v_item_count + 1;
    v_product_id := (v_item->>'product_id')::uuid;
    v_variant_id := NULLIF(v_item->>'variant_id', '')::uuid;
    v_quantity   := (v_item->>'quantity')::integer;
    v_sold_price_in := NULLIF(v_item->>'sold_price', '')::numeric;
    v_reason      := NULLIF(trim(COALESCE(v_item->>'reason', '')), '');
    v_reason_note := NULLIF(trim(COALESCE(v_item->>'reason_note', '')), '');

    IF v_reason IS NOT NULL AND v_reason NOT IN
      ('family', 'gift', 'free_sample', 'personal_use', 'promotion', 'other') THEN
      v_reason := 'other';
    END IF;

    IF v_product_id IS NULL OR v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Invalid item at position %.', v_item_count;
    END IF;

    IF v_variant_id IS NOT NULL THEN
      SELECT
        CASE WHEN pv.offer_price IS NOT NULL AND pv.offer_price < pv.retail_price
             THEN pv.offer_price ELSE pv.retail_price END,
        pv.stock_quantity, pv.region, pv.size,
        COALESCE(pv.image_url, p.image_url), p.name, p.is_active
      INTO v_list_price, v_stock_quantity, v_region, v_size,
           v_image_url, v_product_name, v_is_active
      FROM product_variants pv
      JOIN products p ON p.id = pv.product_id
      WHERE pv.id = v_variant_id AND pv.product_id = v_product_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'One of the chosen items no longer exists.';
      END IF;
      v_variant_label := NULLIF(trim(both ' ' from concat_ws(' · ', NULLIF(v_region, ''), NULLIF(v_size, ''))), '');
    ELSE
      SELECT
        CASE WHEN p.offer_price IS NOT NULL AND p.offer_price < p.retail_price
             THEN p.offer_price ELSE p.retail_price END,
        p.stock_quantity, p.image_url, p.name, p.is_active
      INTO v_list_price, v_stock_quantity, v_image_url, v_product_name, v_is_active
      FROM products p
      WHERE p.id = v_product_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'One of the chosen items no longer exists.';
      END IF;
      v_variant_label := NULL;
    END IF;

    IF NOT v_is_active THEN
      RAISE EXCEPTION '"%" is not active — reactivate it first if you really want to sell it.', v_product_name;
    END IF;

    IF NOT v_is_admin AND v_sold_price_in IS NOT NULL AND v_sold_price_in <> v_list_price THEN
      RAISE EXCEPTION 'Only the Super Admin can change prices.';
    END IF;

    v_unit_price := COALESCE(v_sold_price_in, v_list_price);
    IF v_unit_price < 0 THEN
      RAISE EXCEPTION 'Price cannot be negative.';
    END IF;
    IF v_unit_price < v_list_price AND v_reason IS NULL THEN
      v_reason := 'other';
    END IF;

    IF v_stock_quantity IS NOT NULL AND v_stock_quantity < v_quantity THEN
      v_warnings := v_warnings || jsonb_build_object(
        'product_name', v_product_name,
        'variant_label', v_variant_label,
        'available', v_stock_quantity,
        'requested', v_quantity
      );
    END IF;

    INSERT INTO _admin_order_lines (
      product_id, variant_id, product_name, variant_label, image_url,
      list_price, unit_price, quantity, line_total, reason, reason_note,
      is_tracked_stock, stock_available
    ) VALUES (
      v_product_id, v_variant_id, v_product_name, v_variant_label, v_image_url,
      v_list_price, v_unit_price, v_quantity, v_unit_price * v_quantity, v_reason, v_reason_note,
      (v_stock_quantity IS NOT NULL), v_stock_quantity
    );

    v_subtotal   := v_subtotal + (v_unit_price * v_quantity);
    v_list_value := v_list_value + (v_list_price * v_quantity);
    IF v_unit_price = 0 THEN
      v_free_value := v_free_value + (v_list_price * v_quantity);
    END IF;
  END LOOP;

  IF jsonb_array_length(v_warnings) > 0 AND NOT p_allow_negative_stock THEN
    RAISE EXCEPTION 'STOCK_WARNING:%', v_warnings::text;
  END IF;

  v_total := GREATEST(v_subtotal + v_delivery_fee - v_discount, 0);

  v_payment_status := CASE
    WHEN p_payment_method = 'cash' THEN 'paid'
    WHEN p_payment_method = 'bkash' AND p_bkash_trx_id IS NOT NULL AND trim(p_bkash_trx_id) <> '' THEN 'paid'
    WHEN p_payment_method = 'bkash' THEN 'pending_verification'
    ELSE 'unpaid'
  END;

  v_initial_status := CASE WHEN p_mark_delivered THEN 'delivered' ELSE 'confirmed' END;

  INSERT INTO orders (
    order_number, customer_id, source, customer_name, customer_phone,
    division, district, thana, address_line,
    delivery_zone, delivery_fee, subtotal, discount, discount_reason, discount_note,
    list_value, free_value, total,
    payment_method, bkash_trx_id, bkash_sender, payment_status,
    status, admin_note
  ) VALUES (
    next_order_number(), p_linked_customer_id, p_source, trim(p_full_name), COALESCE(p_phone, ''),
    COALESCE(p_division, ''), COALESCE(p_district, ''), COALESCE(p_thana, ''), trim(p_address_line),
    p_delivery_zone, v_delivery_fee, v_subtotal, v_discount,
    NULLIF(trim(COALESCE(p_discount_reason, '')), ''), NULLIF(trim(COALESCE(p_discount_note, '')), ''),
    v_list_value, v_free_value, v_total,
    p_payment_method, NULLIF(trim(COALESCE(p_bkash_trx_id, '')), ''), NULLIF(trim(COALESCE(p_bkash_sender, '')), ''),
    v_payment_status,
    v_initial_status, NULLIF(trim(COALESCE(p_admin_note, '')), '')
  )
  RETURNING id, orders.order_number INTO v_order_id, v_order_number;

  INSERT INTO order_items (
    order_id, product_id, variant_id, product_name, variant_label, image_url,
    list_price, unit_price, quantity, line_total, reason, reason_note
  )
  SELECT
    v_order_id, product_id, variant_id, product_name, variant_label, image_url,
    list_price, unit_price, quantity, line_total, reason, reason_note
  FROM _admin_order_lines;

  PERFORM set_config('app.order_stock_change', 'on', true);
  UPDATE product_variants pv SET stock_quantity = pv.stock_quantity - l.quantity
    FROM _admin_order_lines l
    WHERE l.variant_id IS NOT NULL AND l.is_tracked_stock AND pv.id = l.variant_id;
  UPDATE products p SET stock_quantity = p.stock_quantity - l.quantity
    FROM _admin_order_lines l
    WHERE l.variant_id IS NULL AND l.is_tracked_stock AND p.id = l.product_id;
  PERFORM set_config('app.order_stock_change', 'off', true);

  INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, note)
  VALUES (
    v_order_id, NULL, v_initial_status, auth.uid(),
    format('Entered manually — source: %s', p_source)
  );

  RETURN QUERY SELECT v_order_id, v_order_number;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_create_order(
  text, jsonb, text, text, text, text, text, text, text, numeric,
  numeric, text, text, text, text, text, uuid, boolean, text, boolean
) TO authenticated;

-- Steadfast booking: "Book on Steadfast" permission. Otherwise identical to
-- migration-029.
CREATE OR REPLACE FUNCTION admin_record_steadfast_shipment(
  p_order_id        uuid,
  p_consignment_id  text,
  p_tracking_code   text,
  p_tracking_link   text,
  p_courier_status  text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order orders%ROWTYPE;
BEGIN
  IF NOT staff_can('book_steadfast') THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;
  IF v_order.status <> 'confirmed' THEN
    RAISE EXCEPTION 'Order is not confirmed.';
  END IF;
  IF v_order.steadfast_consignment_id IS NOT NULL THEN
    RAISE EXCEPTION 'This order has already been booked with Steadfast.';
  END IF;

  UPDATE orders SET
    steadfast_consignment_id = p_consignment_id,
    steadfast_tracking_code  = p_tracking_code,
    steadfast_tracking_link  = NULLIF(p_tracking_link, ''),
    steadfast_status         = p_courier_status,
    tracking_number          = p_tracking_code,
    status                   = 'shipped',
    updated_at               = now()
  WHERE id = p_order_id;

  INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, note)
  VALUES (p_order_id, v_order.status, 'shipped', auth.uid(), 'Sent to Steadfast');

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_record_steadfast_shipment(uuid, text, text, text, text) TO authenticated;

-- "Check delivery status": anyone who can book on Steadfast or change the
-- order status.
CREATE OR REPLACE FUNCTION admin_update_steadfast_status(
  p_order_id       uuid,
  p_courier_status text,
  p_mark_delivered boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_status text;
BEGIN
  IF NOT (staff_can('book_steadfast') OR staff_can('change_order_status')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  SELECT status INTO v_old_status FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found.';
  END IF;

  UPDATE orders SET steadfast_status = p_courier_status, updated_at = now()
  WHERE id = p_order_id;

  IF p_mark_delivered AND v_old_status NOT IN ('delivered', 'cancelled') THEN
    UPDATE orders SET status = 'delivered', updated_at = now() WHERE id = p_order_id;
    INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, note)
    VALUES (p_order_id, v_old_status, 'delivered', auth.uid(), 'Steadfast: delivered');
  END IF;

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_update_steadfast_status(uuid, text, boolean) TO authenticated;


-- ============================================================
-- PART 6 — Safety Lock + deleting orders
-- ============================================================

-- One row while a Super Admin has "Allow deleting orders at any stage"
-- switched on. It is only ever open until delete_any_until (15 minutes at
-- most); after that it counts as locked again, row or no row.
CREATE TABLE IF NOT EXISTS admin_safety_locks (
  user_id          uuid PRIMARY KEY,
  delete_any_until timestamptz NOT NULL,
  opened_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE admin_safety_locks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_safety_locks_own_read" ON admin_safety_locks;
CREATE POLICY "admin_safety_locks_own_read"
  ON admin_safety_locks FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND is_admin());

REVOKE ALL ON admin_safety_locks FROM anon, authenticated;
GRANT SELECT ON admin_safety_locks TO authenticated;

-- Opens the lock. The caller must have typed their password in the last
-- 5 minutes: Supabase puts the time of the last password sign-in in the
-- login token ("amr"), and it does NOT change when the token is refreshed,
-- so this cannot be satisfied by an old login.
-- p_seconds: 900 (15 minutes) normally; the e2e tests pass a few seconds
-- to prove it switches itself off. It can never be longer than 15 minutes.
CREATE OR REPLACE FUNCTION admin_open_delete_lock(p_seconds integer DEFAULT 900)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_password_at bigint;
  v_seconds     integer := LEAST(GREATEST(COALESCE(p_seconds, 900), 5), 900);
  v_until       timestamptz;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  SELECT max((e ->> 'timestamp')::bigint) INTO v_password_at
  FROM jsonb_array_elements(COALESCE(auth.jwt() -> 'amr', '[]'::jsonb)) e
  WHERE e ->> 'method' = 'password';

  IF v_password_at IS NULL OR v_password_at < extract(epoch FROM now())::bigint - 300 THEN
    RAISE EXCEPTION 'Please confirm your password again.';
  END IF;

  v_until := now() + make_interval(secs => v_seconds);
  INSERT INTO admin_safety_locks (user_id, delete_any_until, opened_at)
  VALUES (auth.uid(), v_until, now())
  ON CONFLICT (user_id) DO UPDATE SET delete_any_until = EXCLUDED.delete_any_until, opened_at = now();

  PERFORM write_activity('safety.delete_lock_off', 'safety', auth.uid()::text, 'Safety Lock',
    format('Turned OFF the safety lock: orders can be deleted at any stage until %s',
           to_char(v_until AT TIME ZONE 'Asia/Dhaka', 'HH24:MI:SS')),
    jsonb_build_object('until', v_until, 'seconds', v_seconds));

  RETURN v_until;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_open_delete_lock(integer) TO authenticated;

CREATE OR REPLACE FUNCTION admin_close_delete_lock()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_was_open boolean;
BEGIN
  IF NOT is_admin() THEN
    RETURN false;
  END IF;
  SELECT delete_any_until > now() INTO v_was_open
  FROM admin_safety_locks WHERE user_id = auth.uid();

  DELETE FROM admin_safety_locks WHERE user_id = auth.uid();

  IF COALESCE(v_was_open, false) THEN
    PERFORM write_activity('safety.delete_lock_on', 'safety', auth.uid()::text, 'Safety Lock',
      'Turned the safety lock back ON', '{}'::jsonb);
  END IF;
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_close_delete_lock() TO authenticated;

-- When the lock is currently open for the caller, or NULL.
CREATE OR REPLACE FUNCTION admin_delete_lock_until()
RETURNS timestamptz
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT delete_any_until FROM admin_safety_locks
  WHERE user_id = auth.uid() AND is_admin() AND delete_any_until > now();
$$;

GRANT EXECUTE ON FUNCTION admin_delete_lock_until() TO authenticated;

-- Deletes orders. The rule, checked here for every order:
--   - Early stage = Pending, or Cancelled and never booked on Steadfast.
--     The Super Admin, and moderators with "Delete early orders", may
--     delete these.
--   - Any later stage: only the Super Admin, and only while his Safety
--     Lock is open.
-- Stock is put back for every item whose stock was taken and not already
-- returned (stock_released), exactly once.
CREATE OR REPLACE FUNCTION admin_delete_orders(p_order_ids uuid[])
RETURNS TABLE (order_id uuid, order_number text, deleted boolean, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id        uuid;
  v_order     orders%ROWTYPE;
  v_line      record;
  v_is_admin  boolean := is_admin();
  v_lock_open boolean := false;
  v_early     boolean;
BEGIN
  IF NOT (v_is_admin OR staff_can('delete_early_orders')) THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  IF v_is_admin THEN
    v_lock_open := EXISTS (
      SELECT 1 FROM admin_safety_locks
      WHERE user_id = auth.uid() AND delete_any_until > now()
    );
  END IF;

  FOREACH v_id IN ARRAY COALESCE(p_order_ids, '{}'::uuid[])
  LOOP
    SELECT * INTO v_order FROM orders WHERE id = v_id FOR UPDATE;

    IF NOT FOUND THEN
      order_id := v_id; order_number := NULL; deleted := false; reason := 'Order not found.';
      RETURN NEXT;
      CONTINUE;
    END IF;

    v_early := v_order.status = 'pending'
               OR (v_order.status = 'cancelled' AND v_order.steadfast_consignment_id IS NULL);

    IF NOT v_early AND NOT v_lock_open THEN
      order_id := v_id; order_number := v_order.order_number; deleted := false;
      reason := CASE WHEN v_is_admin
        THEN 'Locked: turn on "Allow deleting orders at any stage" in Safety Locks.'
        ELSE 'Only Pending orders, or Cancelled orders never booked on Steadfast, can be deleted.' END;
      RETURN NEXT;
      CONTINUE;
    END IF;

    IF NOT v_order.stock_released AND v_order.status <> 'cancelled' THEN
      PERFORM set_config('app.order_stock_change', 'on', true);
      FOR v_line IN SELECT * FROM order_items oi WHERE oi.order_id = v_id
      LOOP
        IF v_line.variant_id IS NOT NULL THEN
          UPDATE product_variants SET stock_quantity = stock_quantity + v_line.quantity
            WHERE id = v_line.variant_id AND stock_quantity IS NOT NULL;
        ELSIF v_line.product_id IS NOT NULL THEN
          UPDATE products SET stock_quantity = stock_quantity + v_line.quantity
            WHERE id = v_line.product_id AND stock_quantity IS NOT NULL;
        END IF;
      END LOOP;
      PERFORM set_config('app.order_stock_change', 'off', true);
    END IF;

    DELETE FROM order_status_history h WHERE h.order_id = v_id;
    DELETE FROM order_items oi WHERE oi.order_id = v_id;
    DELETE FROM orders o WHERE o.id = v_id;

    order_id := v_id; order_number := v_order.order_number; deleted := true; reason := NULL;
    RETURN NEXT;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_delete_orders(uuid[]) TO authenticated;

-- The older delete function (still called by the live site until this
-- branch is merged) now follows exactly the same rule — it can no longer
-- be used to get around the Safety Lock.
CREATE OR REPLACE FUNCTION admin_delete_cancelled_orders(p_order_ids uuid[])
RETURNS TABLE (order_id uuid, order_number text, deleted boolean, reason text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM admin_delete_orders(p_order_ids);
$$;

GRANT EXECUTE ON FUNCTION admin_delete_cancelled_orders(uuid[]) TO authenticated;


-- ============================================================
-- PART 7 — Super Admin: change an item's price on an order
-- ============================================================

-- Works at any status. The database recalculates line total, subtotal,
-- discount (never more than the subtotal), free value and total — nothing
-- is taken from the browser except the one new price.
CREATE OR REPLACE FUNCTION admin_update_order_item_price(
  p_item_id        uuid,
  p_new_unit_price numeric,
  p_reason         text DEFAULT NULL
)
RETURNS TABLE (new_total numeric, steadfast_consignment_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item      order_items%ROWTYPE;
  v_order     orders%ROWTYPE;
  v_price     numeric(10,2);
  v_reason    text := NULLIF(trim(COALESCE(p_reason, '')), '');
  v_subtotal  numeric(10,2);
  v_free      numeric(10,2);
  v_discount  numeric(10,2);
  v_total     numeric(10,2);
  v_label     text;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_new_unit_price IS NULL OR p_new_unit_price < 0 THEN
    RAISE EXCEPTION 'Price must be 0 or more.';
  END IF;
  v_price := round(p_new_unit_price, 2);
  IF v_reason IS NOT NULL AND v_reason NOT IN ('family', 'gift', 'free_sample', 'personal_use', 'promotion', 'other') THEN
    v_reason := 'other';
  END IF;

  SELECT * INTO v_item FROM order_items WHERE id = p_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Item not found.';
  END IF;
  SELECT * INTO v_order FROM orders WHERE id = v_item.order_id FOR UPDATE;

  IF v_price = v_item.unit_price THEN
    RETURN QUERY SELECT v_order.total, v_order.steadfast_consignment_id;
    RETURN;
  END IF;

  UPDATE order_items SET
    unit_price = v_price,
    line_total = v_price * quantity,
    reason = CASE WHEN v_price < list_price THEN COALESCE(v_reason, reason, 'other') ELSE NULL END
  WHERE id = p_item_id;

  SELECT COALESCE(sum(line_total), 0),
         COALESCE(sum(CASE WHEN unit_price = 0 THEN list_price * quantity ELSE 0 END), 0)
  INTO v_subtotal, v_free
  FROM order_items WHERE order_items.order_id = v_order.id;

  v_discount := LEAST(v_order.discount, v_subtotal);
  v_total := GREATEST(v_subtotal + v_order.delivery_fee - v_discount, 0);

  UPDATE orders SET
    subtotal = v_subtotal,
    discount = v_discount,
    free_value = v_free,
    total = v_total,
    updated_at = now()
  WHERE id = v_order.id;

  v_label := v_item.product_name || COALESCE(' (' || v_item.variant_label || ')', '');

  INSERT INTO order_status_history (order_id, old_status, new_status, changed_by, note)
  VALUES (v_order.id, v_order.status, v_order.status, auth.uid(),
          format('Price of %s changed ৳%s → ৳%s (total ৳%s → ৳%s)',
                 v_label, v_item.unit_price, v_price, v_order.total, v_total));

  PERFORM write_activity('order.price_changed', 'order', v_order.id::text, v_order.order_number,
    format('%s: price of %s ৳%s → ৳%s (total ৳%s → ৳%s)',
           v_order.order_number, v_label, v_item.unit_price, v_price, v_order.total, v_total),
    jsonb_build_object(
      'item', v_label,
      'unit_price', jsonb_build_object('from', v_item.unit_price, 'to', v_price),
      'total', jsonb_build_object('from', v_order.total, 'to', v_total),
      'steadfast_consignment_id', v_order.steadfast_consignment_id));

  RETURN QUERY SELECT v_total::numeric, v_order.steadfast_consignment_id;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_update_order_item_price(uuid, numeric, text) TO authenticated;


-- ============================================================
-- PART 8 — team management + read helpers
-- The admin-team Edge Function creates/deletes the login itself (that needs
-- the service key, which only lives inside the function). Everything that
-- touches this database's own tables happens here, as the Super Admin,
-- through these checks.
-- ============================================================

-- Keeps only known permissions, and switches on "View orders" whenever an
-- order permission is on (the others are useless without it).
CREATE OR REPLACE FUNCTION normalize_staff_permissions(p_permissions text[])
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  WITH cleaned AS (
    SELECT DISTINCT p FROM unnest(COALESCE(p_permissions, '{}'::text[])) p
    WHERE p = ANY (staff_permission_names())
  ),
  with_view AS (
    SELECT p FROM cleaned
    UNION
    SELECT 'view_orders' WHERE EXISTS (
      SELECT 1 FROM cleaned
      WHERE p IN ('change_order_status', 'create_orders', 'book_steadfast', 'delete_early_orders'))
  )
  SELECT COALESCE(array_agg(p ORDER BY array_position(staff_permission_names(), p)), '{}'::text[])
  FROM with_view;
$$;

CREATE OR REPLACE FUNCTION admin_team_register(
  p_user_id   uuid,
  p_username  text,
  p_full_name text,
  p_phone     text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_username !~ '^[a-z0-9._]{3,30}$' THEN
    RAISE EXCEPTION 'Invalid username.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'Login not found.';
  END IF;
  IF EXISTS (SELECT 1 FROM profiles WHERE id = p_user_id AND role <> 'moderator') THEN
    RAISE EXCEPTION 'This login already belongs to someone else.';
  END IF;

  INSERT INTO profiles (id, role, status, full_name, phone)
  VALUES (p_user_id, 'moderator', 'approved', trim(p_full_name), trim(p_phone))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO staff_members (id, username, full_name, phone, permissions)
  VALUES (p_user_id, p_username, trim(COALESCE(p_full_name, '')), trim(COALESCE(p_phone, '')), '{}');

  PERFORM write_activity('team.moderator_added', 'team', p_user_id::text, p_username,
    format('Added moderator "%s" (%s)', p_username, trim(COALESCE(p_full_name, ''))),
    jsonb_build_object('username', p_username, 'full_name', p_full_name, 'phone', p_phone));
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_team_register(uuid, text, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION admin_team_update(
  p_user_id     uuid,
  p_full_name   text,
  p_phone       text,
  p_permissions text[],
  p_disabled    boolean
)
RETURNS text[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old   staff_members%ROWTYPE;
  v_perms text[] := normalize_staff_permissions(p_permissions);
  v_diff  jsonb := '{}'::jsonb;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  SELECT s.* INTO v_old FROM staff_members s JOIN profiles p ON p.id = s.id
  WHERE s.id = p_user_id AND p.role = 'moderator' FOR UPDATE OF s;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Moderator not found.';
  END IF;

  IF v_old.full_name IS DISTINCT FROM trim(COALESCE(p_full_name, '')) THEN
    v_diff := v_diff || jsonb_build_object('full_name', jsonb_build_object('from', v_old.full_name, 'to', trim(COALESCE(p_full_name, ''))));
  END IF;
  IF v_old.phone IS DISTINCT FROM trim(COALESCE(p_phone, '')) THEN
    v_diff := v_diff || jsonb_build_object('phone', jsonb_build_object('from', v_old.phone, 'to', trim(COALESCE(p_phone, ''))));
  END IF;
  IF v_old.permissions IS DISTINCT FROM v_perms THEN
    v_diff := v_diff || jsonb_build_object('permissions', jsonb_build_object('from', to_jsonb(v_old.permissions), 'to', to_jsonb(v_perms)));
  END IF;
  IF v_old.is_disabled IS DISTINCT FROM COALESCE(p_disabled, false) THEN
    v_diff := v_diff || jsonb_build_object('disabled', jsonb_build_object('from', v_old.is_disabled, 'to', COALESCE(p_disabled, false)));
  END IF;

  UPDATE staff_members SET
    full_name = trim(COALESCE(p_full_name, '')),
    phone = trim(COALESCE(p_phone, '')),
    permissions = v_perms,
    is_disabled = COALESCE(p_disabled, false),
    updated_at = now()
  WHERE id = p_user_id;

  UPDATE profiles SET full_name = trim(COALESCE(p_full_name, '')), phone = trim(COALESCE(p_phone, ''))
  WHERE id = p_user_id;

  IF v_diff <> '{}'::jsonb THEN
    PERFORM write_activity(
      CASE
        WHEN v_diff ? 'disabled' AND COALESCE(p_disabled, false) THEN 'team.moderator_disabled'
        WHEN v_diff ? 'disabled' THEN 'team.moderator_enabled'
        WHEN v_diff ? 'permissions' THEN 'team.permissions_changed'
        ELSE 'team.moderator_updated'
      END,
      'team', p_user_id::text, v_old.username,
      format('Moderator "%s": changed %s', v_old.username,
             (SELECT string_agg(k, ', ' ORDER BY k) FROM jsonb_object_keys(v_diff) k)),
      v_diff);
  END IF;
  RETURN v_perms;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_team_update(uuid, text, text, text[], boolean) TO authenticated;

-- Password reset / deletion happen in the Edge Function; this records them
-- (as the Super Admin) before the login changes.
CREATE OR REPLACE FUNCTION admin_team_log(p_user_id uuid, p_action text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_username text;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF p_action NOT IN ('team.password_reset', 'team.moderator_deleted') THEN
    RAISE EXCEPTION 'Invalid action.';
  END IF;
  SELECT s.username INTO v_username FROM staff_members s JOIN profiles p ON p.id = s.id
  WHERE s.id = p_user_id AND p.role = 'moderator';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Moderator not found.';
  END IF;
  PERFORM write_activity(p_action, 'team', p_user_id::text, v_username,
    CASE p_action
      WHEN 'team.password_reset' THEN format('Reset the password of "%s"', v_username)
      ELSE format('Deleted moderator "%s"', v_username)
    END, '{}'::jsonb);
  RETURN v_username;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_team_log(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION admin_team_list()
RETURNS TABLE (
  id          uuid,
  username    text,
  full_name   text,
  phone       text,
  permissions text[],
  is_disabled boolean,
  created_at  timestamptz,
  last_login  timestamptz
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT s.id, s.username, s.full_name, s.phone, s.permissions, s.is_disabled, s.created_at,
         (SELECT max(a.created_at) FROM activity_log a
           WHERE a.actor_id = s.id AND a.action = 'staff.login')
  FROM staff_members s
  JOIN profiles p ON p.id = s.id
  WHERE is_admin() AND p.role = 'moderator'
  ORDER BY s.created_at;
$$;

GRANT EXECUTE ON FUNCTION admin_team_list() TO authenticated;

-- Usernames for the Activity Log's "person" filter.
CREATE OR REPLACE FUNCTION admin_activity_people()
RETURNS TABLE (username text)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT DISTINCT a.actor_username FROM activity_log a WHERE is_admin() ORDER BY 1;
$$;

GRANT EXECUTE ON FUNCTION admin_activity_people() TO authenticated;

-- "Last updated by <username> · <time>" for the admin product list.
CREATE OR REPLACE FUNCTION admin_product_edit_info()
RETURNS TABLE (id uuid, last_edited_by text, last_edited_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT p.id, p.last_edited_by, p.last_edited_at
  FROM products p
  WHERE is_staff() AND p.last_edited_at IS NOT NULL;
$$;

GRANT EXECUTE ON FUNCTION admin_product_edit_info() TO authenticated;

-- ============================================================
-- ---------- Verify ----------
-- 1. SELECT username FROM staff_members;            → 'naeem' (your account)
-- 2. SELECT key, value FROM app_settings WHERE key LIKE 'order_number_%';
--                                                    → prefix 'NM-', suffix ''
-- 3. As a customer (not admin): SELECT * FROM activity_log;   → no rows
-- 4. UPDATE activity_log SET summary = 'x';          → error "cannot be changed"
-- ============================================================
