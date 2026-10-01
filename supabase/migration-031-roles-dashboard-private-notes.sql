-- ============================================================
-- Naeem's Price Hub — Migration 031 (Batch 25: admin redesign)
-- Run this in the Supabase SQL Editor after migration-030. Safe to re-run.
--
-- ADDITIVE ONLY. No table or column is dropped or renamed, and every
-- existing function keeps its exact name and argument list, so the live
-- site (built from main) keeps working the moment this runs.
--
-- What it adds:
--   PART 1  Staff roles (Moderator, Manager, Accounts ...). A staff member
--           gets their permissions from their role; changing a role's
--           switches changes everyone with it at once. staff_can() reads
--           the role. Two new permissions: see_sales, view_wholesalers.
--   PART 2  Role functions for the Team → Roles tab (all Super Admin only,
--           all written to the Activity Log).
--   PART 3  Admin notes and internal order-history notes move to staff-only
--           tables, so a customer can never read them by any route.
--   PART 4  Home dashboard numbers in one call (admin_dashboard), the
--           low-stock threshold setting, and the Customers list.
-- ============================================================


-- ============================================================
-- PART 1 — roles
-- ============================================================

CREATE TABLE IF NOT EXISTS staff_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 40),
  permissions text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_roles_name_unique ON staff_roles (lower(trim(name)));

-- A member with a role gets the role's permissions. NULL = the Batch 24
-- per-person switches (still honoured, so the live site's Team page keeps
-- working until this batch is merged).
ALTER TABLE staff_members
  ADD COLUMN IF NOT EXISTS role_id uuid REFERENCES staff_roles(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_staff_members_role ON staff_members (role_id);

ALTER TABLE staff_roles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_roles_admin_read" ON staff_roles;
CREATE POLICY "staff_roles_admin_read"
  ON staff_roles FOR SELECT TO authenticated
  USING (is_admin());

-- A staff member may read their own role (for "NAEEM'S <ROLE>" in the header).
DROP POLICY IF EXISTS "staff_roles_own_read" ON staff_roles;
CREATE POLICY "staff_roles_own_read"
  ON staff_roles FOR SELECT TO authenticated
  USING (id = (SELECT s.role_id FROM staff_members s WHERE s.id = auth.uid()));

-- Reads only. Every write goes through a SECURITY DEFINER function below.
REVOKE ALL ON staff_roles FROM anon, authenticated;
GRANT SELECT ON staff_roles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON staff_roles TO service_role;

-- The permission names a staff member can be given. Anything else is refused.
CREATE OR REPLACE FUNCTION staff_permission_names()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ARRAY[
    'view_orders', 'change_order_status', 'create_orders', 'book_steadfast',
    'edit_products', 'edit_categories', 'view_customers', 'delete_early_orders',
    'view_wholesalers', 'see_sales'
  ];
$$;

-- The permissions a staff row actually has: the role's when it has one,
-- otherwise its own Batch 24 list.
CREATE OR REPLACE FUNCTION staff_effective_permissions(p_user_id uuid)
RETURNS text[]
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT CASE WHEN s.role_id IS NULL THEN s.permissions ELSE COALESCE(r.permissions, '{}'::text[]) END
  FROM staff_members s
  LEFT JOIN staff_roles r ON r.id = s.role_id
  WHERE s.id = p_user_id;
$$;

REVOKE ALL ON FUNCTION staff_effective_permissions(uuid) FROM PUBLIC, anon, authenticated;

-- The ONE server-side check (same name and meaning as Batch 24). The Super
-- Admin always passes; a moderator passes only while active, approved, and
-- the permission is in their role (or their own list when they have none).
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
    LEFT JOIN staff_roles r ON r.id = s.role_id
    WHERE p.id = auth.uid()
      AND p.role = 'moderator'
      AND p.status = 'approved'
      AND NOT s.is_disabled
      AND p_perm = ANY (CASE WHEN s.role_id IS NULL THEN s.permissions ELSE COALESCE(r.permissions, '{}'::text[]) END)
  );
$$;

GRANT EXECUTE ON FUNCTION staff_can(text) TO authenticated;

-- Same rule for the wholesale-price column lock (Batch 24 read the list
-- directly).
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
  ) OR staff_can('edit_products');
$$;

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

-- Batch 24 mapped "View customers" to the Wholesalers list. Wholesalers now
-- have their own switch; anyone who had "View customers" keeps seeing
-- wholesalers (so nobody loses access they have today).
UPDATE staff_members
SET permissions = normalize_staff_permissions(permissions || ARRAY['view_wholesalers'])
WHERE 'view_customers' = ANY (permissions)
  AND NOT ('view_wholesalers' = ANY (permissions))
  AND role_id IS NULL;

-- Migrate Batch 24 moderators: one role per distinct set of permissions
-- (the first is "Moderator", then "Moderator 2", ...). Everyone keeps
-- exactly the permissions they have today.
DO $$
DECLARE
  v_set   record;
  v_n     integer := 0;
  v_name  text;
  v_role  uuid;
BEGIN
  FOR v_set IN
    SELECT s.permissions, min(s.created_at) AS first_at
    FROM staff_members s
    JOIN profiles p ON p.id = s.id
    WHERE p.role = 'moderator' AND s.role_id IS NULL
    GROUP BY s.permissions
    ORDER BY min(s.created_at)
  LOOP
    LOOP
      v_n := v_n + 1;
      v_name := CASE WHEN v_n = 1 THEN 'Moderator' ELSE 'Moderator ' || v_n END;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM staff_roles WHERE lower(trim(name)) = lower(v_name));
    END LOOP;
    INSERT INTO staff_roles (name, permissions) VALUES (v_name, v_set.permissions) RETURNING id INTO v_role;
    UPDATE staff_members s SET role_id = v_role
    FROM profiles p
    WHERE p.id = s.id AND p.role = 'moderator' AND s.role_id IS NULL AND s.permissions = v_set.permissions;
  END LOOP;
END $$;

-- Customer accounts vs wholesaler accounts, each behind its own switch.
DROP POLICY IF EXISTS "profiles_staff_read_customers" ON profiles;
CREATE POLICY "profiles_staff_read_customers"
  ON profiles FOR SELECT TO authenticated
  USING (
    (role = 'customer' AND staff_can('view_customers'))
    OR (role = 'wholesaler' AND staff_can('view_wholesalers'))
  );

-- The Wholesalers list (read only for a moderator with "View wholesalers").
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
  WHERE (is_admin() OR staff_can('view_wholesalers')) AND p.role = 'wholesaler'
  ORDER BY p.created_at DESC;
$$;


-- ============================================================
-- PART 2 — role functions (Super Admin only)
-- ============================================================

-- Copies a role's permissions onto its members' own rows, so every screen
-- that reads staff_members.permissions (including the live site's) sees
-- the same thing staff_can() checks.
CREATE OR REPLACE FUNCTION staff_roles_sync_members()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.permissions IS DISTINCT FROM OLD.permissions THEN
    UPDATE staff_members SET permissions = NEW.permissions, updated_at = now()
    WHERE role_id = NEW.id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS staff_roles_sync ON staff_roles;
CREATE TRIGGER staff_roles_sync
  AFTER UPDATE ON staff_roles
  FOR EACH ROW EXECUTE FUNCTION staff_roles_sync_members();

CREATE OR REPLACE FUNCTION admin_role_list()
RETURNS TABLE (id uuid, name text, permissions text[], member_count bigint, created_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT r.id, r.name, r.permissions,
         (SELECT count(*) FROM staff_members s WHERE s.role_id = r.id),
         r.created_at
  FROM staff_roles r
  WHERE is_admin()
  ORDER BY r.created_at, r.name;
$$;

GRANT EXECUTE ON FUNCTION admin_role_list() TO authenticated;

-- Create (p_id NULL) or update a role. Returns the role id.
CREATE OR REPLACE FUNCTION admin_role_save(p_id uuid, p_name text, p_permissions text[])
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name  text := trim(COALESCE(p_name, ''));
  v_perms text[] := normalize_staff_permissions(p_permissions);
  v_old   staff_roles%ROWTYPE;
  v_id    uuid;
  v_diff  jsonb := '{}'::jsonb;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  IF length(v_name) < 1 OR length(v_name) > 40 THEN
    RAISE EXCEPTION 'Role name must be 1 to 40 characters.';
  END IF;
  IF EXISTS (SELECT 1 FROM staff_roles WHERE lower(trim(name)) = lower(v_name) AND id IS DISTINCT FROM p_id) THEN
    RAISE EXCEPTION 'A role with that name already exists.';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO staff_roles (name, permissions) VALUES (v_name, v_perms) RETURNING id INTO v_id;
    PERFORM write_activity('team.role_created', 'role', v_id::text, v_name,
      format('Created role "%s"', v_name),
      jsonb_build_object('permissions', to_jsonb(v_perms)));
    RETURN v_id;
  END IF;

  SELECT * INTO v_old FROM staff_roles WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Role not found.';
  END IF;
  IF v_old.name IS DISTINCT FROM v_name THEN
    v_diff := v_diff || jsonb_build_object('name', jsonb_build_object('from', v_old.name, 'to', v_name));
  END IF;
  IF v_old.permissions IS DISTINCT FROM v_perms THEN
    v_diff := v_diff || jsonb_build_object('permissions', jsonb_build_object('from', to_jsonb(v_old.permissions), 'to', to_jsonb(v_perms)));
  END IF;
  UPDATE staff_roles SET name = v_name, permissions = v_perms, updated_at = now() WHERE id = p_id;
  IF v_diff <> '{}'::jsonb THEN
    PERFORM write_activity('team.role_updated', 'role', p_id::text, v_name,
      format('Role "%s": changed %s', v_name,
             (SELECT string_agg(k, ', ' ORDER BY k) FROM jsonb_object_keys(v_diff) k)),
      v_diff);
  END IF;
  RETURN p_id;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_role_save(uuid, text, text[]) TO authenticated;

-- Deleting is only allowed when nobody has the role.
CREATE OR REPLACE FUNCTION admin_role_delete(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  SELECT name INTO v_name FROM staff_roles WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Role not found.';
  END IF;
  IF EXISTS (SELECT 1 FROM staff_members WHERE role_id = p_id) THEN
    RAISE EXCEPTION 'This role is still given to someone. Move them to another role first.';
  END IF;
  DELETE FROM staff_roles WHERE id = p_id;
  PERFORM write_activity('team.role_deleted', 'role', p_id::text, v_name,
    format('Deleted role "%s"', v_name), '{}'::jsonb);
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_role_delete(uuid) TO authenticated;

-- Give a staff member a role. Their permissions follow it from now on.
CREATE OR REPLACE FUNCTION admin_team_set_role(p_user_id uuid, p_role_id uuid)
RETURNS text[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member  staff_members%ROWTYPE;
  v_role    staff_roles%ROWTYPE;
  v_oldname text;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  SELECT s.* INTO v_member FROM staff_members s JOIN profiles p ON p.id = s.id
  WHERE s.id = p_user_id AND p.role = 'moderator' FOR UPDATE OF s;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Staff member not found.';
  END IF;
  SELECT * INTO v_role FROM staff_roles WHERE id = p_role_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Role not found.';
  END IF;
  IF v_member.role_id IS NOT DISTINCT FROM p_role_id THEN
    RETURN v_role.permissions;
  END IF;
  SELECT name INTO v_oldname FROM staff_roles WHERE id = v_member.role_id;

  UPDATE staff_members SET role_id = p_role_id, permissions = v_role.permissions, updated_at = now()
  WHERE id = p_user_id;

  PERFORM write_activity('team.role_assigned', 'team', p_user_id::text, v_member.username,
    format('"%s": role %s → %s', v_member.username, COALESCE(v_oldname, '(own switches)'), v_role.name),
    jsonb_build_object('role', jsonb_build_object('from', v_oldname, 'to', v_role.name),
                       'permissions', jsonb_build_object('from', to_jsonb(v_member.permissions), 'to', to_jsonb(v_role.permissions))));
  RETURN v_role.permissions;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_team_set_role(uuid, uuid) TO authenticated;

-- Batch 24's update (name, phone, permissions, disabled), same signature.
-- A member with a role keeps the role's permissions; if the (older) Team
-- page sends a different list, the member leaves the role and keeps
-- exactly that list, so what was saved is what applies.
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
  v_old     staff_members%ROWTYPE;
  v_perms   text[] := normalize_staff_permissions(p_permissions);
  v_diff    jsonb := '{}'::jsonb;
  v_role_id uuid;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;
  SELECT s.* INTO v_old FROM staff_members s JOIN profiles p ON p.id = s.id
  WHERE s.id = p_user_id AND p.role = 'moderator' FOR UPDATE OF s;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Moderator not found.';
  END IF;

  v_role_id := v_old.role_id;
  IF v_role_id IS NOT NULL
     AND v_perms IS DISTINCT FROM (SELECT r.permissions FROM staff_roles r WHERE r.id = v_role_id) THEN
    v_role_id := NULL;
    v_diff := v_diff || jsonb_build_object('role', jsonb_build_object(
      'from', (SELECT r.name FROM staff_roles r WHERE r.id = v_old.role_id), 'to', NULL));
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
    role_id = v_role_id,
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

-- The Team list with each member's role (admin_team_list stays as it was
-- for the live site).
CREATE OR REPLACE FUNCTION admin_team_members()
RETURNS TABLE (
  id          uuid,
  username    text,
  full_name   text,
  phone       text,
  permissions text[],
  is_disabled boolean,
  created_at  timestamptz,
  last_login  timestamptz,
  role_id     uuid,
  role_name   text
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT s.id, s.username, s.full_name, s.phone,
         staff_effective_permissions(s.id), s.is_disabled, s.created_at,
         (SELECT max(a.created_at) FROM activity_log a
           WHERE a.actor_id = s.id AND a.action = 'staff.login'),
         s.role_id, r.name
  FROM staff_members s
  JOIN profiles p ON p.id = s.id
  LEFT JOIN staff_roles r ON r.id = s.role_id
  WHERE is_admin() AND p.role = 'moderator'
  ORDER BY s.created_at;
$$;

GRANT EXECUTE ON FUNCTION admin_team_members() TO authenticated;

-- The signed-in staff member's own role name (NULL for the Super Admin or
-- a member without a role).
CREATE OR REPLACE FUNCTION staff_my_role()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT r.name FROM staff_members s JOIN staff_roles r ON r.id = s.role_id WHERE s.id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION staff_my_role() TO authenticated;


-- ============================================================
-- PART 3 — admin notes are staff-only
-- A customer can read their own orders row and its history rows (RLS
-- works per row, not per column). So the admin note and the internal
-- history notes (and who on the team wrote each step) now live in two
-- tables only staff can read. Triggers move anything written to the old
-- columns, so every existing function keeps working unchanged.
-- ============================================================

CREATE TABLE IF NOT EXISTS order_private_notes (
  order_id   uuid PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  admin_note text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_history_private (
  history_id          uuid PRIMARY KEY REFERENCES order_status_history(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  order_id            uuid NOT NULL,
  note                text,
  changed_by_username text
);

CREATE INDEX IF NOT EXISTS idx_order_history_private_order ON order_history_private (order_id);

ALTER TABLE order_private_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_history_private ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "order_private_notes_staff_read" ON order_private_notes;
CREATE POLICY "order_private_notes_staff_read"
  ON order_private_notes FOR SELECT TO authenticated
  USING (staff_can('view_orders'));

DROP POLICY IF EXISTS "order_history_private_staff_read" ON order_history_private;
CREATE POLICY "order_history_private_staff_read"
  ON order_history_private FOR SELECT TO authenticated
  USING (staff_can('view_orders'));

REVOKE ALL ON order_private_notes FROM anon, authenticated;
REVOKE ALL ON order_history_private FROM anon, authenticated;
GRANT SELECT ON order_private_notes TO authenticated;
GRANT SELECT ON order_history_private TO authenticated;
GRANT ALL ON order_private_notes TO service_role;
GRANT ALL ON order_history_private TO service_role;

-- Sets (or clears, with NULL/blank) an order's private admin note, and logs
-- the change. Internal: used by the trigger and admin_update_order_fields.
CREATE OR REPLACE FUNCTION set_order_private_note(p_order_id uuid, p_order_number text, p_note text, p_log boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old  text;
  v_note text := NULLIF(trim(COALESCE(p_note, '')), '');
BEGIN
  SELECT admin_note INTO v_old FROM order_private_notes WHERE order_id = p_order_id;
  IF v_old IS NOT DISTINCT FROM v_note THEN
    RETURN;
  END IF;
  INSERT INTO order_private_notes (order_id, admin_note, updated_at)
  VALUES (p_order_id, v_note, now())
  ON CONFLICT (order_id) DO UPDATE SET admin_note = EXCLUDED.admin_note, updated_at = now();
  IF p_log THEN
    PERFORM write_activity(
      'order.note', 'order', p_order_id::text, p_order_number, 'Admin note changed',
      jsonb_build_object('admin_note', jsonb_build_object('from', v_old, 'to', v_note))
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION set_order_private_note(uuid, text, text, boolean) FROM PUBLIC, anon, authenticated;

-- orders.admin_note: any explicit write of the column (a new order, or the
-- old plain UPDATE fallback) goes to order_private_notes — NULL clears it —
-- and the column itself stays empty.
CREATE OR REPLACE FUNCTION orders_move_admin_note()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.admin_note IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM set_order_private_note(NEW.id, NEW.order_number, NEW.admin_note, TG_OP = 'UPDATE');
  NEW.admin_note := NULL;
  RETURN NEW;
END;
$$;

-- Same name and arguments as Batch 24. The note is written straight to the
-- private table, and admin_note is left out of the UPDATE, so changing only
-- the payment status can never touch the note.
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

  IF p_fields ? 'admin_note' THEN
    PERFORM set_order_private_note(p_order_id, v_order.order_number, p_fields ->> 'admin_note', true);
  END IF;

  UPDATE orders SET
    payment_status  = CASE WHEN p_fields ? 'payment_status' THEN p_fields ->> 'payment_status' ELSE payment_status END,
    tracking_number = CASE WHEN p_fields ? 'tracking_number' THEN NULLIF(trim(COALESCE(p_fields ->> 'tracking_number', '')), '') ELSE tracking_number END,
    updated_at      = now()
  WHERE id = p_order_id;
  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_update_order_fields(uuid, jsonb) TO authenticated;

DROP TRIGGER IF EXISTS orders_private_note ON orders;
CREATE TRIGGER orders_private_note
  BEFORE INSERT OR UPDATE OF admin_note ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_move_admin_note();

-- order_status_history: the note and the team username go to
-- order_history_private. Named to run AFTER order_history_username (BEFORE
-- triggers run in name order), which fills in the username first.
CREATE OR REPLACE FUNCTION order_history_move_private()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.note IS NOT NULL OR NEW.changed_by_username IS NOT NULL THEN
    INSERT INTO order_history_private (history_id, order_id, note, changed_by_username)
    VALUES (NEW.id, NEW.order_id, NEW.note, NEW.changed_by_username)
    ON CONFLICT (history_id) DO UPDATE SET note = EXCLUDED.note, changed_by_username = EXCLUDED.changed_by_username;
    NEW.note := NULL;
    NEW.changed_by_username := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS order_history_zz_private ON order_status_history;
CREATE TRIGGER order_history_zz_private
  BEFORE INSERT OR UPDATE OF note, changed_by_username ON order_status_history
  FOR EACH ROW EXECUTE FUNCTION order_history_move_private();

-- Existing rows: copy, then empty the public columns. The order triggers
-- (activity log, Telegram webhook, courier time) are paused for this one
-- clean-up so it doesn't look like a real change to any order.
INSERT INTO order_private_notes (order_id, admin_note, updated_at)
SELECT o.id, o.admin_note, now() FROM orders o WHERE o.admin_note IS NOT NULL
ON CONFLICT (order_id) DO UPDATE SET admin_note = EXCLUDED.admin_note;

INSERT INTO order_history_private (history_id, order_id, note, changed_by_username)
SELECT h.id, h.order_id, h.note, h.changed_by_username FROM order_status_history h
WHERE h.note IS NOT NULL OR h.changed_by_username IS NOT NULL
ON CONFLICT (history_id) DO UPDATE SET note = EXCLUDED.note, changed_by_username = EXCLUDED.changed_by_username;

ALTER TABLE orders DISABLE TRIGGER orders_activity_log;
ALTER TABLE orders DISABLE TRIGGER orders_courier_time;
ALTER TABLE orders DISABLE TRIGGER orders_private_note;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'orders'::regclass AND tgname = 'order-telegram') THEN
    EXECUTE 'ALTER TABLE orders DISABLE TRIGGER "order-telegram"';
  END IF;
END $$;

UPDATE orders SET admin_note = NULL WHERE admin_note IS NOT NULL;

ALTER TABLE orders ENABLE TRIGGER orders_activity_log;
ALTER TABLE orders ENABLE TRIGGER orders_courier_time;
ALTER TABLE orders ENABLE TRIGGER orders_private_note;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'orders'::regclass AND tgname = 'order-telegram') THEN
    EXECUTE 'ALTER TABLE orders ENABLE TRIGGER "order-telegram"';
  END IF;
END $$;

ALTER TABLE order_status_history DISABLE TRIGGER order_history_zz_private;
UPDATE order_status_history SET note = NULL, changed_by_username = NULL
WHERE note IS NOT NULL OR changed_by_username IS NOT NULL;
ALTER TABLE order_status_history ENABLE TRIGGER order_history_zz_private;


-- ============================================================
-- PART 4 — dashboard, low-stock threshold, customers
-- ============================================================

INSERT INTO app_settings (key, value) VALUES ('low_stock_threshold', '5')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION low_stock_threshold()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT CASE WHEN trim(value) ~ '^[0-9]{1,6}$' THEN trim(value)::integer END
       FROM app_settings WHERE key = 'low_stock_threshold'),
    5);
$$;

GRANT EXECUTE ON FUNCTION low_stock_threshold() TO authenticated;

-- Every Home number in one call. A number is only included when the
-- caller may see that section; money only with "See sales figures" (the
-- Super Admin always). Days and months are Bangladesh time. Cancelled
-- orders never count towards orders or money.
CREATE OR REPLACE FUNCTION admin_dashboard()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_sales       boolean := staff_can('see_sales');
  v_today_start timestamptz := (date_trunc('day', now() AT TIME ZONE 'Asia/Dhaka')) AT TIME ZONE 'Asia/Dhaka';
  v_month_start timestamptz := (date_trunc('month', now() AT TIME ZONE 'Asia/Dhaka')) AT TIME ZONE 'Asia/Dhaka';
  v_result      jsonb := jsonb_build_object('can_see_sales', staff_can('see_sales'), 'low_stock_threshold', low_stock_threshold());
  v_orders      jsonb;
BEGIN
  IF NOT is_staff() THEN
    RAISE EXCEPTION 'Not authorized.';
  END IF;

  IF staff_can('view_orders') THEN
    SELECT jsonb_build_object(
      'today_orders', count(*) FILTER (WHERE o.created_at >= v_today_start AND o.status <> 'cancelled'),
      'to_confirm',   count(*) FILTER (WHERE o.status = 'pending'),
      'on_the_way',   count(*) FILTER (WHERE o.status = 'shipped' AND o.steadfast_consignment_id IS NOT NULL),
      'month_orders', count(*) FILTER (WHERE o.created_at >= v_month_start AND o.status <> 'cancelled'),
      'today_total',  CASE WHEN v_sales THEN COALESCE(sum(o.total) FILTER (WHERE o.created_at >= v_today_start AND o.status <> 'cancelled'), 0) END,
      'month_total',  CASE WHEN v_sales THEN COALESCE(sum(o.total) FILTER (WHERE o.created_at >= v_month_start AND o.status <> 'cancelled'), 0) END
    ) INTO v_orders
    FROM orders o;
    v_result := v_result || jsonb_strip_nulls(v_orders);
  END IF;

  IF staff_can('edit_products') THEN
    v_result := v_result || jsonb_build_object('low_stock', (
      SELECT count(*) FROM products p
      WHERE p.is_active AND p.stock_quantity IS NOT NULL AND p.stock_quantity <= low_stock_threshold()));
  END IF;

  IF is_admin() THEN
    v_result := v_result || jsonb_build_object('reviews_pending', (
      SELECT count(*) FROM reviews r WHERE NOT r.is_approved));
  END IF;

  IF staff_can('view_wholesalers') THEN
    v_result := v_result || jsonb_build_object('wholesalers_pending', (
      SELECT count(*) FROM profiles p WHERE p.role = 'wholesaler' AND p.status = 'pending'));
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_dashboard() TO authenticated;

-- Customers page (read only) — "View customers". Total spent only with
-- "See sales figures".
CREATE OR REPLACE FUNCTION admin_customers()
RETURNS TABLE (
  id            uuid,
  full_name     text,
  email         text,
  phone         text,
  order_count   bigint,
  total_spent   numeric,
  last_order_at timestamptz,
  joined_at     timestamptz
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT p.id, COALESCE(p.full_name, ''), u.email::text, COALESCE(p.phone, ''),
         count(o.id) FILTER (WHERE o.status <> 'cancelled'),
         CASE WHEN staff_can('see_sales')
              THEN COALESCE(sum(o.total) FILTER (WHERE o.status <> 'cancelled'), 0) END,
         max(o.created_at),
         p.created_at
  FROM profiles p
  JOIN auth.users u ON u.id = p.id
  LEFT JOIN orders o ON o.customer_id = p.id
  WHERE staff_can('view_customers') AND p.role = 'customer'
  GROUP BY p.id, p.full_name, u.email, p.phone, p.created_at
  ORDER BY max(o.created_at) DESC NULLS LAST, p.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION admin_customers() TO authenticated;

-- One customer's orders, for the Customers page.
CREATE OR REPLACE FUNCTION admin_customer_orders(p_customer_id uuid)
RETURNS TABLE (id uuid, order_number text, created_at timestamptz, status text, item_count bigint, total numeric)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT o.id, o.order_number, o.created_at, o.status,
         (SELECT COALESCE(sum(i.quantity), 0) FROM order_items i WHERE i.order_id = o.id),
         CASE WHEN staff_can('see_sales') OR staff_can('view_orders') THEN o.total END
  FROM orders o
  WHERE staff_can('view_customers') AND o.customer_id = p_customer_id
  ORDER BY o.created_at DESC;
$$;

GRANT EXECUTE ON FUNCTION admin_customer_orders(uuid) TO authenticated;

-- Item counts for the Orders list (one call for every order).
CREATE OR REPLACE FUNCTION admin_order_item_counts()
RETURNS TABLE (order_id uuid, item_count bigint)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT i.order_id, sum(i.quantity) FROM order_items i
  WHERE staff_can('view_orders')
  GROUP BY i.order_id;
$$;

GRANT EXECUTE ON FUNCTION admin_order_item_counts() TO authenticated;

-- ============================================================
-- ---------- Verify ----------
-- 1. SELECT name, permissions FROM staff_roles;        → one row per old permission set
-- 2. SELECT count(*) FROM orders WHERE admin_note IS NOT NULL;              → 0
-- 3. SELECT count(*) FROM order_status_history WHERE note IS NOT NULL;      → 0
-- 4. SELECT key, value FROM app_settings WHERE key = 'low_stock_threshold'; → 5
-- ============================================================
