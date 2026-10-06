-- Batch 31 Part 1: prepares the THROW-AWAY Postgres inside the backup job
-- (never the live database) so a Supabase backup can be restored into it.
-- Plain Postgres lacks Supabase's built-in roles and extensions; this adds
-- the ones the backup refers to, so the restore test checks our data
-- instead of failing on Supabase's own plumbing.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role', 'authenticator',
    'supabase_admin', 'supabase_auth_admin', 'supabase_storage_admin', 'dashboard_user',
    'supabase_realtime_admin', 'supabase_replication_admin', 'pgbouncer']
  loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
  end loop;
end $$;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;

-- The orders Database Webhook (Telegram alert) calls this Supabase function.
-- In the test database it does nothing.
create schema if not exists supabase_functions;
create or replace function supabase_functions.http_request() returns trigger
language plpgsql as $$ begin return coalesce(new, old); end $$;
