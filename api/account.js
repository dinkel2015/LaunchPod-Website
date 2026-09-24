/* =====================================================================
   POST /api/account

   Creates a client account at checkout, so a new visitor never meets a
   sign-up wall. The portal calls this with the name, company, email and
   password typed on the checkout screen, then signs in with the same
   credentials and runs /api/checkout as that user as before.

   The account is created already confirmed. Payment is what verifies a
   new client here; making them click an email link before they can pay
   would put the wall straight back.

   If the email already has an account this returns 409 and creates
   nothing. The portal then tries the typed password: that succeeds for a
   visitor retrying after a declined card, and anyone else is asked to
   sign in. It never signs anyone in or reveals anything beyond "exists".
   ===================================================================== */

import { serviceClient } from "./_lib/supabase.js";
import { json, fail, methodGuard, readBody } from "./_lib/http.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function field(v, max) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, "POST")) return;

  let body;
  try {
    body = readBody(req);
  } catch (e) {
    return json(res, 400, { error: e.message });
  }

  const name = field(body.name, 200);
  const company = field(body.company, 200);
  const email = field(body.email, 320).toLowerCase();
  const password = typeof body.password === "string" ? body.password : "";

  if (!name || !company) return json(res, 400, { error: "Enter your name and company." });
  if (!EMAIL.test(email)) return json(res, 400, { error: "Enter a valid email address." });
  if (password.length < 8 || password.length > 72) {
    return json(res, 400, { error: "Your password needs 8 to 72 characters." });
  }

  try {
    const { error } = await serviceClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name, company },
    });
    if (error) {
      const exists = error.code === "email_exists" || error.status === 422 || /already/i.test(error.message || "");
      if (exists) return json(res, 409, { error: "An account with this email already exists." });
      throw error;
    }
    return json(res, 201, { ok: true });
  } catch (e) {
    return fail(res, 500, "Could not create your account", e);
  }
}
