import { createClient } from "@supabase/supabase-js";

let hasWarnedMissingPublicEnv = false;

function readSupabaseEnv() {
  return {
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY
  };
}

function warnMissingPublicEnvOnce(supabaseUrl?: string, supabaseAnonKey?: string) {
  if ((!supabaseUrl || !supabaseAnonKey) && !hasWarnedMissingPublicEnv) {
    // Runtime guard for local/dev misconfiguration.
    console.warn("Supabase public env vars are missing.");
    hasWarnedMissingPublicEnv = true;
  }
}

export function getSupabaseBrowserClient() {
  const { supabaseUrl, supabaseAnonKey } = readSupabaseEnv();
  warnMissingPublicEnvOnce(supabaseUrl, supabaseAnonKey);

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }

  return createClient(supabaseUrl, supabaseAnonKey);
}

export function getSupabaseAnonClient() {
  const { supabaseUrl, supabaseAnonKey } = readSupabaseEnv();
  warnMissingPublicEnvOnce(supabaseUrl, supabaseAnonKey);

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }

  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

export function getSupabaseServiceClient() {
  const { supabaseUrl, supabaseServiceRoleKey } = readSupabaseEnv();

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY or NEXT_PUBLIC_SUPABASE_URL");
  }

  return createClient(supabaseUrl, supabaseServiceRoleKey);
}

export function getSupabaseUserClient(accessToken: string) {
  const { supabaseUrl, supabaseAnonKey } = readSupabaseEnv();
  warnMissingPublicEnvOnce(supabaseUrl, supabaseAnonKey);

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }

  return createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}
