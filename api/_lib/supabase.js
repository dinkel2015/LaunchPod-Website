import { createClient } from "@supabase/supabase-js";
import { requireEnv } from "./http.js";

/* service_role bypasses RLS. Only ever constructed inside /api — if this
   module is ever imported from client-side code the build should be
   treated as compromised. */
export function serviceClient() {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/* Verifies a caller's Supabase access token and returns their user.
   Every authenticated /api route funnels through this — the client_id a
   route writes always comes from the verified token, never from the
   request body, so a caller cannot write rows for someone else. */
export async function requireUser(req) {
  const { bearerToken } = await import("./http.js");
  const token = bearerToken(req);
  if (!token) return { error: "Missing bearer token" };

  const anon = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data, error } = await anon.auth.getUser(token);
  if (error || !data?.user) return { error: "Invalid or expired session" };
  return { user: data.user };
}
