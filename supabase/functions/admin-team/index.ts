// Supabase Edge Function: the Super Admin's Team page (Batch 24 Part 1).
// Adds, edits, disables/enables, resets the password of, and deletes
// moderator accounts.
//
// Only this function ever holds the service-role key (Supabase provides
// SUPABASE_SERVICE_ROLE_KEY here automatically), and it only uses it for
// the one thing the browser can never do: create / change / delete a login
// in Supabase Auth. Every change to this project's own tables goes through
// the Super Admin's own session and the admin_team_* database functions
// (migration-030), which check is_admin() themselves and write the
// Activity Log.
//
// A moderator never sees or types their internal email: it is always
// <username>@staff.naeems.internal.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS: HeadersInit = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const STAFF_EMAIL_DOMAIN = 'staff.naeems.internal';
const USERNAME_PATTERN = /^[a-z0-9._]{3,30}$/;
const PASSWORD_MIN_LENGTH = 8;
// A disabled moderator's login is blocked in Supabase Auth for 100 years
// (until re-enabled). Their database access is also cut on their very next
// action by staff_can(), even before their current login token expires.
const BAN_DURATION = '876000h';

interface RequestBody {
  action?: 'create' | 'update' | 'reset_password' | 'delete';
  userId?: string;
  username?: string;
  fullName?: string;
  phone?: string;
  password?: string;
  permissions?: string[];
  disabled?: boolean;
}

function json(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function staffEmail(username: string): string {
  return `${username}@${STAFF_EMAIL_DOMAIN}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json({ ok: false, error: 'Method not allowed.' });
  }

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return json({ ok: false, error: 'Invalid request.' });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const authHeader = req.headers.get('Authorization') ?? '';

  // The caller's own session: every database write below runs as them.
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: isAdmin, error: adminErr } = await userClient.rpc('is_admin');
  if (adminErr || isAdmin !== true) {
    return json({ ok: false, error: 'Not authorized.' });
  }

  const serviceClient = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  if (body.action === 'create') {
    const username = (body.username ?? '').trim().toLowerCase();
    const password = body.password ?? '';
    if (!USERNAME_PATTERN.test(username)) {
      return json({
        ok: false,
        error: 'Username must be 3–30 characters: lowercase letters, numbers, "." and "_".',
      });
    }
    if (password.length < PASSWORD_MIN_LENGTH) {
      return json({ ok: false, error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` });
    }

    const { data: taken } = await serviceClient
      .from('staff_members')
      .select('id')
      .eq('username', username)
      .maybeSingle();
    if (taken) {
      return json({ ok: false, error: 'That username is already taken.' });
    }

    const { data: created, error: createErr } = await serviceClient.auth.admin.createUser({
      email: staffEmail(username),
      password,
      email_confirm: true,
      user_metadata: { staff_username: username },
    });
    if (createErr || !created.user) {
      const message = /already/i.test(createErr?.message ?? '')
        ? 'That username is already taken.'
        : 'Could not create the login. Please try again.';
      return json({ ok: false, error: message });
    }

    const { error: registerErr } = await userClient.rpc('admin_team_register', {
      p_user_id: created.user.id,
      p_username: username,
      p_full_name: body.fullName ?? '',
      p_phone: body.phone ?? '',
    });
    if (registerErr) {
      // Never leave a half-made login behind.
      await serviceClient.auth.admin.deleteUser(created.user.id);
      return json({ ok: false, error: registerErr.message });
    }
    return json({ ok: true, userId: created.user.id });
  }

  const userId = body.userId ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(userId)) {
    return json({ ok: false, error: 'Invalid request.' });
  }

  if (body.action === 'update') {
    const { data: perms, error: updateErr } = await userClient.rpc('admin_team_update', {
      p_user_id: userId,
      p_full_name: body.fullName ?? '',
      p_phone: body.phone ?? '',
      p_permissions: body.permissions ?? [],
      p_disabled: body.disabled === true,
    });
    if (updateErr) {
      return json({ ok: false, error: updateErr.message });
    }
    const { error: banErr } = await serviceClient.auth.admin.updateUserById(userId, {
      ban_duration: body.disabled === true ? BAN_DURATION : 'none',
    });
    if (banErr) {
      console.error('admin-team: ban update failed:', banErr.message);
      return json({
        ok: false,
        error: 'Saved, but could not update the login block. Please try again.',
      });
    }
    return json({ ok: true, permissions: perms });
  }

  if (body.action === 'reset_password') {
    const password = body.password ?? '';
    if (password.length < PASSWORD_MIN_LENGTH) {
      return json({ ok: false, error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.` });
    }
    const { error: logErr } = await userClient.rpc('admin_team_log', {
      p_user_id: userId,
      p_action: 'team.password_reset',
    });
    if (logErr) {
      return json({ ok: false, error: logErr.message });
    }
    const { error: pwErr } = await serviceClient.auth.admin.updateUserById(userId, { password });
    if (pwErr) {
      return json({ ok: false, error: 'Could not reset the password. Please try again.' });
    }
    return json({ ok: true });
  }

  if (body.action === 'delete') {
    // Recorded first (with the username), so the log keeps it after the
    // login is gone. admin_team_log also refuses anyone who isn't a
    // moderator — this can never delete the Super Admin or a customer.
    const { error: logErr } = await userClient.rpc('admin_team_log', {
      p_user_id: userId,
      p_action: 'team.moderator_deleted',
    });
    if (logErr) {
      return json({ ok: false, error: logErr.message });
    }
    const { error: delErr } = await serviceClient.auth.admin.deleteUser(userId);
    if (delErr) {
      return json({ ok: false, error: 'Could not delete the login. Please try again.' });
    }
    return json({ ok: true });
  }

  return json({ ok: false, error: 'Invalid request.' });
});
