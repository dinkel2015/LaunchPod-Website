/* =====================================================================
   GET /api/config

   Serves the PUBLIC (non-secret) ids the portal needs at runtime.

   The site is static, so there is no build step to substitute these in.
   Serving them from here instead of hardcoding them means sandbox and
   production deployments differ only by Vercel env vars, and there is no
   copy of a Square Application ID sitting in git waiting to go stale.

   Only values that are safe in the browser may ever be added here.
   ===================================================================== */

import { json, methodGuard, requireEnv } from "./_lib/http.js";

export default function handler(req, res) {
  if (!methodGuard(req, res, "GET")) return;

  try {
    // Short cache: these effectively never change, but a stale value
    // after a key rotation should not outlive a page reload for long.
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300");

    return json(res, 200, {
      supabaseUrl: requireEnv("SUPABASE_URL"),
      supabaseAnonKey: requireEnv("SUPABASE_ANON_KEY"),
      squareApplicationId: requireEnv("SQUARE_APPLICATION_ID"),
      squareLocationId: requireEnv("SQUARE_LOCATION_ID"),
      squareEnv: requireEnv("SQUARE_ENV"),
    });
  } catch (e) {
    // A missing public id is a deployment error, not a user error — say
    // so plainly so it is obvious in the browser console during setup.
    console.error("/api/config is missing an environment variable:", e.message);
    return json(res, 500, { error: e.message });
  }
}
