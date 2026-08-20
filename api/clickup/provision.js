/* =====================================================================
   POST /api/clickup/provision

   Thin HTTP wrapper around provisionClient() in _lib/clickup.js, kept as
   a route so a failed provisioning can be retried by hand without
   re-running checkout. The real logic — and the notes on ClickUp's
   folder-template and dashboard API limits — live in the lib.
   ===================================================================== */

import { serviceClient } from "../_lib/supabase.js";
import { provisionClient } from "../_lib/clickup.js";
import { json, fail, methodGuard, readBody, requireEnv, bearerToken } from "../_lib/http.js";

export default async function handler(req, res) {
  if (!methodGuard(req, res, "POST")) return;

  /* Called server-to-server, not from the browser, so it authenticates
     with the same shared secret as the cron route rather than a session. */
  if (bearerToken(req) !== requireEnv("CRON_SECRET")) {
    return json(res, 401, { error: "Unauthorized" });
  }

  let body;
  try {
    body = readBody(req);
  } catch (e) {
    return json(res, 400, { error: e.message });
  }

  if (!body.subscriptionId) return json(res, 400, { error: "Missing subscriptionId" });

  try {
    return json(res, 200, await provisionClient(serviceClient(), body.subscriptionId));
  } catch (e) {
    if (e.status) console.error("ClickUp API error body:", e.body);
    return fail(res, 502, "Could not provision the ClickUp workspace", e);
  }
}
