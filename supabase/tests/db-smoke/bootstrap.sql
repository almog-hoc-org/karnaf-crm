-- Supabase platform objects the migrations expect, for a plain Postgres.
-- Only enough to apply every migration and exercise the lead path.

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit;
create role supabase_admin login superuser;
create role supabase_auth_admin login;
create role supabase_storage_admin login;
grant anon, authenticated, service_role to authenticator;
grant anon, authenticated, service_role to postgres;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
alter database postgres set search_path = public, extensions;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;
create schema auth;
create table auth.users (instance_id uuid, id uuid primary key default gen_random_uuid(), aud text, role text, email text, encrypted_password text, email_confirmed_at timestamptz, raw_app_meta_data jsonb default '{}', raw_user_meta_data jsonb default '{}', created_at timestamptz default now(), updated_at timestamptz default now(), last_sign_in_at timestamptz, phone text, is_anonymous boolean default false, deleted_at timestamptz);
create table auth.audit_log_entries (instance_id uuid, id uuid primary key, payload json, created_at timestamptz, ip_address text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role', true), '')::text $$;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.email() returns text language sql stable as $$ select auth.jwt()->>'email' $$;
grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to service_role;
create schema storage;
create table storage.buckets (id text primary key, name text unique, owner uuid, public boolean default false, file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now(), updated_at timestamptz default now());
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, owner uuid, metadata jsonb, created_at timestamptz default now(), updated_at timestamptz default now(), last_accessed_at timestamptz);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/') $$;
grant usage on schema storage to anon, authenticated, service_role;
create schema vault;
create table vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, description text, secret text, created_at timestamptz default now(), updated_at timestamptz default now());
create view vault.decrypted_secrets as select id, name, description, secret, secret as decrypted_secret, created_at, updated_at from vault.secrets;
create function vault.create_secret(new_secret text, new_name text default null, new_description text default '') returns uuid language sql as $$ insert into vault.secrets(name, secret, description) values (new_name, new_secret, new_description) returning id $$;
create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null) returns void language sql as $$ update vault.secrets set secret = coalesce(new_secret, secret), name = coalesce(new_name, name) where id = secret_id $$;
create publication supabase_realtime;
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Created in production outside the migrations; 029 publishes it.
create table if not exists public.conversation_claims (id uuid primary key default gen_random_uuid());
