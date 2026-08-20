/* =====================================================================
   POST /api/plan-change

   Records a requested upgrade/downgrade. Deliberately does NOT bill:
   the change takes effect at the start of the next production cycle, at
   least 30 days out, per the "Client-Managed Upgrades and Downgrades"
   clause in the portal TOS. /api/billing/charge-cycle applies it when
   that date arrives.
   ===================================================================== */

import { validateSelection, computePricing, ValidationError } from "./_lib/pricing.js";
import { serviceClient, requireUser } from "./_lib/supabase.js";
import { planChangeEffectiveAt, parseDate, toDateString } from "./_lib/billing.js";
import { json, fail, methodGuard, readBody } from "./_lib/http.js";

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

  let selection;
  try {
    selection = validateSelection(body.selection);
  } catch (e) {
    if (e instanceof ValidationError) return json(res, 400, { error: e.message });
    throw e;
  }

  const db = serviceClient();

  try {
    // Scoped to the caller's own id, so a client cannot move someone
    // else's plan even by guessing a subscription id.
    const { data: sub, error: subErr } = await db
      .from("subscriptions")
      .select("id, selection, recurring_cents, billing_anchor, status")
      .eq("client_id", user.id)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (subErr) throw subErr;
    if (!sub) return json(res, 404, { error: "No active subscription to change" });

    /* A plan change is priced without any promo: promo codes are a
       signup-time incentive tied to the original checkout, and carrying
       one silently into a new plan would discount a package it was never
       issued for. */
    const price = computePricing(selection, null);

    const requestedAt = new Date();
    const anchor = parseDate(sub.billing_anchor);
    const effectiveAt = planChangeEffectiveAt(anchor, requestedAt);

    // Only one pending change per subscription (enforced by a partial
    // unique index); a new request supersedes the old one.
    const { error: cancelErr } = await db
      .from("plan_changes")
      .update({ status: "canceled" })
      .eq("subscription_id", sub.id)
      .eq("status", "pending");
    if (cancelErr) throw cancelErr;

    const { data: change, error: insertErr } = await db
      .from("plan_changes")
      .insert({
        subscription_id: sub.id,
        client_id: user.id,
        from_selection: sub.selection,
        to_selection: selection,
        from_recurring_cents: sub.recurring_cents,
        to_recurring_cents: price.recurringCents,
        requested_at: requestedAt.toISOString(),
        effective_at: toDateString(effectiveAt),
      })
      .select("id, effective_at")
      .single();
    if (insertErr) throw insertErr;

    return json(res, 200, {
      planChangeId: change.id,
      effectiveAt: change.effective_at,
      currentRecurringCents: sub.recurring_cents,
      newRecurringCents: price.recurringCents,
      billedNow: 0,
    });
  } catch (e) {
    return fail(res, 500, "Could not record the plan change", e);
  }
}
