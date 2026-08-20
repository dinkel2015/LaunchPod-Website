/* =====================================================================
   GET /api/billing/charge-cycle   (Vercel Cron, daily)

   Walks every active subscription whose next_charge_on has arrived,
   applies any plan change that has become effective, and charges the
   saved card-on-file for that cycle.

   This is the piece that makes recurring billing work given that LPM's
   pricing is à la carte and custom per client, which does not map onto
   Square's fixed Subscription Plan Variations.

   Protected by CRON_SECRET: Vercel sends it as a bearer token, and
   without the check this route would let anyone on the internet trigger
   a billing run.
   ===================================================================== */

import { computePricing, validateSelection } from "../_lib/pricing.js";
import { serviceClient } from "../_lib/supabase.js";
import { squareClient, locationId, money, plain, cycleIdempotencyKey } from "../_lib/square.js";
import { addMonthsClamped, parseDate, toDateString, nextCycleAfter } from "../_lib/billing.js";
import { json, methodGuard, bearerToken, requireEnv } from "../_lib/http.js";

export default async function handler(req, res) {
  if (!methodGuard(req, res, "GET")) return;

  if (bearerToken(req) !== requireEnv("CRON_SECRET")) {
    return json(res, 401, { error: "Unauthorized" });
  }

  const db = serviceClient();
  const square = squareClient();
  const today = new Date();
  const todayStr = toDateString(today);

  const results = { charged: [], failed: [], applied_changes: [], skipped: [] };

  const { data: due, error } = await db
    .from("subscriptions")
    .select("id, client_id, path, selection, recurring_cents, billing_anchor, next_charge_on, square_customer_id, square_card_id")
    .eq("status", "active")
    .lte("next_charge_on", todayStr);

  if (error) {
    console.error("charge-cycle: could not load due subscriptions", error);
    return json(res, 500, { error: "Could not load due subscriptions" });
  }

  for (const sub of due ?? []) {
    try {
      if (!sub.square_card_id || !sub.square_customer_id) {
        results.skipped.push({ id: sub.id, reason: "no card on file" });
        continue;
      }

      let selection = sub.selection;
      let recurringCents = sub.recurring_cents;

      /* ---- apply a plan change that has come due ---- */
      const { data: change } = await db
        .from("plan_changes")
        .select("id, to_selection, to_recurring_cents")
        .eq("subscription_id", sub.id)
        .eq("status", "pending")
        .lte("effective_at", todayStr)
        .maybeSingle();

      if (change) {
        selection = change.to_selection;
        // Re-derive rather than trusting the stored figure, so a pricing
        // change between request and effective date is picked up.
        recurringCents = computePricing(validateSelection(selection), null).recurringCents;

        await db.from("subscriptions")
          .update({ selection, recurring_cents: recurringCents })
          .eq("id", sub.id);
        await db.from("plan_changes")
          .update({ status: "applied", applied_at: new Date().toISOString() })
          .eq("id", change.id);

        results.applied_changes.push({ id: sub.id, planChangeId: change.id, recurringCents });
      }

      const cycleDate = sub.next_charge_on;

      if (recurringCents <= 0) {
        // Nothing recurring (e.g. a one-off Audit). Advance so the sweep
        // doesn't reconsider it every day.
        const nextAfter = nextCycleAfter(parseDate(sub.billing_anchor), parseDate(cycleDate));
        await db.from("subscriptions")
          .update({ next_charge_on: toDateString(nextAfter) })
          .eq("id", sub.id);
        results.skipped.push({ id: sub.id, reason: "nothing recurring" });
        continue;
      }

      /* Two runs on the same day for the same cycle at the same price
         collapse to a single charge; a next-day retry after a decline,
         or a cycle whose price moved because a plan change landed, gets
         a fresh key. See cycleIdempotencyKey for why both matter. */
      const { payment } = await square.payments.create({
        idempotencyKey: cycleIdempotencyKey({
          subscriptionId: sub.id,
          cycleDate,
          attemptDate: todayStr,
          cents: recurringCents,
        }),
        sourceId: sub.square_card_id,
        customerId: sub.square_customer_id,
        locationId: locationId(),
        amountMoney: money(recurringCents),
        referenceId: sub.id,
        note: `LPM ${sub.path} — cycle ${cycleDate}`,
      });

      const nextAfter = nextCycleAfter(parseDate(sub.billing_anchor), parseDate(cycleDate));
      await db.from("subscriptions")
        .update({
          next_charge_on: toDateString(nextAfter),
          last_charged_at: new Date().toISOString(),
          status: "active",
        })
        .eq("id", sub.id);

      results.charged.push({ id: sub.id, cycle: cycleDate, cents: recurringCents, paymentId: payment.id });
    } catch (e) {
      /* A decline marks the subscription past_due and leaves
         next_charge_on where it is, so the following day's run retries
         the same cycle under the same idempotency key rather than
         skipping the cycle or double-charging it. */
      const squareErrors = e?.errors || e?.body?.errors;
      console.error(`charge-cycle: subscription ${sub.id} failed`, squareErrors ? plain(squareErrors) : e);

      await db.from("subscriptions").update({ status: "past_due" }).eq("id", sub.id);
      results.failed.push({
        id: sub.id,
        code: squareErrors?.[0]?.code ?? "UNKNOWN",
      });
    }
  }

  console.log("charge-cycle summary", {
    due: due?.length ?? 0,
    charged: results.charged.length,
    failed: results.failed.length,
    applied_changes: results.applied_changes.length,
    skipped: results.skipped.length,
  });

  return json(res, 200, results);
}
