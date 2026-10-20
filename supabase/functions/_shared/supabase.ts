import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.117.2';
import { env } from './env.ts';

export function getServiceSupabase(): SupabaseClient {
  return createClient(env.supabaseUrl(), env.serviceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-client-info': 'karnaf-crm-edge' } },
  });
}

export function getRequestSupabase(jwt: string): SupabaseClient {
  return createClient(env.supabaseUrl(), env.anonKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}
