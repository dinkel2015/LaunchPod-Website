/* =====================================================================
   POST /api/promo/validate

   Checks a promo code and returns its discount shape WITHOUT consuming a
   usage, so the portal's live preview agrees with what /api/checkout
   will charge. Before this existed the portal validated codes against a
   hardcoded list, which meant a code valid in the database was rejected
   on screen, and a code in the list but not in the database showed a
   discount that checkout would then refuse.

   Requires a signed-in caller and returns only a boolean-plus-shape, so
   it cannot be used to enumerate codes anonymously.
   ===================================================================== */

import { serviceClient, requireUser } from "../_lib/supabase.js";
import { json, fail, methodGuard, readBody } from "../_lib/http.js";

export default async function handler(req, res) {
  if (!methodGuard(req, res, "POST")) return;

  const { user, error: authError } = await requireUser(req);
  if (authError) return json(res, 401, { error: authError });

  let body;
  try {
    body = readBody(req);
  } catch (e) {
    return json(res, 400, { error: e.message });
  }

  const code = String(body.code ?? "").trim();
  if (!code) return json(res, 400, { valid: false, error: "Enter a promo code." });

  try {
    const { data, error } = await serviceClient().rpc("peek_promo_code", { p_code: code });
    if (error) throw error;

    const promo = data?.[0];
    if (!promo) {
      return json(res, 200, { valid: false, error: "That code isn't valid or has expired." });
    }

    return json(res, 200, {
      valid: true,
      promo: {
        code: promo.code,
        discountType: promo.discount_type,
        // percent -> basis points, flat -> cents. The portal formats
        // these for display; the server still recomputes at checkout.
        amount: promo.amount,
      },
    });
  } catch (e) {
    return fail(res, 500, "Could not check that code", e);
  }
}
