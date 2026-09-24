/* =====================================================================
   POST /api/webicast-calc

   Records one use of the Webicast page's cost/value calculator. The page
   sends this when a visitor presses Calculate. Anonymous by design: no
   name, email, or IP is stored, only the inputs, the quote shown, and a
   random per-browser visitor id so repeat uses group together.

   Public (no auth), so every field is type-checked and clamped before it
   touches the database. Failures return a generic error; the page never
   waits on this call.
   ===================================================================== */

import { serviceClient } from "./_lib/supabase.js";
import { json, fail, methodGuard, readBody } from "./_lib/http.js";

const CADENCES = new Set(["biweekly", "weekly", "twice"]);

function int(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function text(v, max) {
  if (typeof v !== "string" || !v.length) return null;
  return v.slice(0, max);
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, "POST")) return;

  let body;
  try {
    body = readBody(req);
  } catch (e) {
    return json(res, 400, { error: e.message });
  }

  const row = {
    visitor_id: text(body.visitor_id, 64),
    webinar_minutes: int(body.webinar_minutes, 1, 600),
    webinars_per_month: int(body.webinars_per_month, 1, 31),
    release_cadence: CADENCES.has(body.release_cadence) ? body.release_cadence : null,
    registrants: int(body.registrants, 0, 1_000_000),
    lead_value: int(body.lead_value, 0, 10_000_000),
    episodes_per_month: int(body.episodes_per_month, 0, 500),
    quoted_price: body.quoted_price == null ? null : int(body.quoted_price, 0, 1_000_000),
    is_custom: body.is_custom === true,
    break_even_leads: body.break_even_leads == null ? null : int(body.break_even_leads, 0, 1_000_000),
    page_path: text(body.page_path, 200),
    referrer: text(body.referrer, 500),
    user_agent: text(req.headers["user-agent"], 300),
  };

  if (!row.webinar_minutes || !row.webinars_per_month || !row.release_cadence) {
    return json(res, 400, { error: "Missing calculator inputs" });
  }

  try {
    const { error } = await serviceClient().from("webicast_calculations").insert(row);
    if (error) throw error;
    return json(res, 201, { ok: true });
  } catch (e) {
    return fail(res, 500, "Could not record calculation", e);
  }
}
