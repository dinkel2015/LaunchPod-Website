/* =====================================================================
   POST /api/checkout

   Takes a Square card token from the Web Payments SDK plus the client's
   *selections* (never a total), recomputes the price server-side, saves
   the card on file, charges the initial amount, and records both the
   subscription and the TOS the client actually agreed to.

   Ordering is deliberate:
     1. subscription row written as 'pending'
     2. TOS acceptance written against it (immutable once written)
     3. card saved + charged
     4. subscription flipped to 'active'
   A declined card therefore leaves a 'pending' subscription and a
   recorded acceptance rather than losing the consent record — consent
   happened when they clicked, independent of whether the card cleared.
   ===================================================================== */

import { createHash } from "node:crypto";
import { validateSelection, computePricing, ValidationError } from "./_lib/pricing.js";
import { serviceClient, requireUser } from "./_lib/supabase.js";
import { squareClient, locationId, money, plain, idempotencyKey } from "./_lib/square.js";
import { addMonthsClamped, toDateString } from "./_lib/billing.js";
import { provisionClient } from "./_lib/clickup.js";
import { json, fail, methodGuard, readBody } from "./_lib/http.js";

/* The Launch path charges its one-time build fee today; the recurring
   Orbit + Pods retainer starts one month later. Every other path bills
   its first cycle today, so the anchor is today. See the handoff notes —
   this is a business rule, not an implementation detail. */
function billingAnchorFor(path, today) {
  return path === "launch" ? addMonthsClamped(today, 1) : today;
}

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

  const { sourceId, verificationToken, promoCode, tos, payment } = body;
  if (!sourceId) return json(res, 400, { error: "Missing card token" });
  if (!tos?.text || !tos?.rev) {
    return json(res, 400, { error: "Missing the accepted Terms of Service document" });
  }

  let selection;
  try {
    selection = validateSelection(body.selection);
  } catch (e) {
    if (e instanceof ValidationError) return json(res, 400, { error: e.message });
    throw e;
  }

  const db = serviceClient();
  const square = squareClient();

  /* ---- promo: looked up and consumed server-side, never trusted ---- */
  let promo = null;
  if (promoCode && String(promoCode).trim()) {
    const { data, error } = await db.rpc("redeem_promo_code", { p_code: String(promoCode) });
    if (error) return fail(res, 500, "Could not validate the promo code", error);
    promo = data?.[0] ?? null;
    if (!promo) {
      return json(res, 400, {
        error: "That promo code isn't valid, has expired, or has been fully redeemed.",
        field: "promoCode",
      });
    }
  }

  const releasePromo = async () => {
    if (promo) await db.rpc("release_promo_code", { p_id: promo.id });
  };

  /* ---- price: recomputed from selections + the DB promo row ---- */
  const price = computePricing(selection, promo);

  let subscriptionId = null;
  try {
    /* ---- profile ---- */
    const { error: clientErr } = await db.from("clients").upsert(
      {
        id: user.id,
        name: payment?.name || user.user_metadata?.name || "",
        company: user.user_metadata?.company || "",
        email: user.email,
        billing_zip: payment?.zip || null,
      },
      { onConflict: "id" },
    );
    if (clientErr) throw clientErr;

    /* ---- 1. subscription, pending ---- */
    const today = new Date();
    const anchor = billingAnchorFor(selection.path, today);

    const { data: sub, error: subErr } = await db
      .from("subscriptions")
      .insert({
        client_id: user.id,
        path: selection.path,
        selection,
        status: "pending",
        charged_today_cents: price.chargedTodayCents,
        recurring_cents: price.recurringCents,
        billing_anchor: toDateString(anchor),
        next_charge_on: toDateString(addMonthsClamped(anchor, 1)),
        promo_code_id: promo?.id ?? null,
      })
      .select("id")
      .single();
    if (subErr) throw subErr;
    subscriptionId = sub.id;

    /* ---- 2. TOS acceptance: the exact text rendered to this client ---- */
    const { error: tosErr } = await db.from("tos_acceptances").insert({
      client_id: user.id,
      subscription_id: subscriptionId,
      path: selection.path,
      document_text: tos.text,
      document_sha256: createHash("sha256").update(tos.text, "utf8").digest("hex"),
      document_rev: tos.rev,
      ip_address: (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || null,
      user_agent: req.headers["user-agent"] || null,
    });
    if (tosErr) throw tosErr;

    /* ---- 3. Square: customer -> card on file -> charge ---- */
    const { customer } = await square.customers.create({
      idempotencyKey: idempotencyKey("cu", user.id),
      emailAddress: user.email,
      companyName: payment?.company || undefined,
      referenceId: user.id,
    });

    const { card } = await square.cards.create({
      idempotencyKey: idempotencyKey("ca", subscriptionId),
      sourceId,
      verificationToken,
      card: {
        customerId: customer.id,
        billingAddress: payment?.zip ? { postalCode: payment.zip } : undefined,
        cardholderName: payment?.name || undefined,
      },
    });

    // A $0 charge is legitimate (e.g. a flat promo covering the whole
    // first cycle). Save the card, skip the payment, still activate.
    let paymentId = null;
    if (price.chargedTodayCents > 0) {
      const { payment: made } = await square.payments.create({
        idempotencyKey: idempotencyKey("pa", subscriptionId),
        sourceId: card.id,
        customerId: customer.id,
        locationId: locationId(),
        amountMoney: money(price.chargedTodayCents),
        referenceId: subscriptionId,
        note: `LPM ${selection.path} — initial charge`,
      });
      paymentId = made.id;
    }

    /* ---- 4. activate ---- */
    const { error: activateErr } = await db
      .from("subscriptions")
      .update({
        status: "active",
        square_customer_id: customer.id,
        square_card_id: card.id,
        square_payment_id: paymentId,
        last_charged_at: paymentId ? new Date().toISOString() : null,
      })
      .eq("id", subscriptionId);
    if (activateErr) throw activateErr;

    /* ---- 5. ClickUp workspace ----
       The money has moved and the subscription is active, so a ClickUp
       failure must not fail the checkout: log it and return success with
       clickupProvisioned:false. /api/clickup/provision can be re-run by
       hand for that subscription, and is idempotent. */
    let clickup = null;
    try {
      clickup = await provisionClient(db, subscriptionId);
    } catch (e) {
      console.error("ClickUp provisioning failed after a successful charge", { subscriptionId }, e?.body ?? e);
    }

    return json(res, 200, {
      subscriptionId,
      clickupProvisioned: Boolean(clickup),
      dashboardUrl: clickup?.folderUrl ?? null,
      chargedTodayCents: price.chargedTodayCents,
      recurringCents: price.recurringCents,
      billingAnchor: toDateString(anchor),
      nextChargeOn: toDateString(addMonthsClamped(anchor, 1)),
    });
  } catch (e) {
    await releasePromo();

    // Square surfaces declines as structured errors; pass the customer-
    // facing reason through but never the raw body.
    const squareErrors = e?.errors || e?.body?.errors;
    if (Array.isArray(squareErrors) && squareErrors.length) {
      console.error("Square rejected checkout:", plain(squareErrors), { subscriptionId });
      return json(res, 402, {
        error: squareErrors[0].detail || "Your card was declined.",
        code: squareErrors[0].code,
        subscriptionId,
      });
    }
    return fail(res, 500, "Checkout could not be completed", e);
  }
}
