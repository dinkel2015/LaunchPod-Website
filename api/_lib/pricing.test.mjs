/* =====================================================================
   PRICING PARITY TEST

   The server recomputes every charge from scratch, so if it ever drifts
   from portal.html the client sees one number and gets billed another.
   This test extracts the REAL `PRICING` object and `computePricing()`
   source out of portal.html, evaluates them, and compares against the
   server module across the full cartesian product of every selectable
   option on every path.

   Run: node --test api/_lib/pricing.test.mjs
   ===================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

import { computePricing as serverCompute, validateSelection, PRICING as SERVER_PRICING } from "./pricing.js";

const here = dirname(fileURLToPath(import.meta.url));
const portalPath = join(here, "..", "..", "portal.html");

/* Pull the pricing source straight out of the shipped portal so the test
   can never pass against a stale copy. */
function extractClientPricing() {
  const html = readFileSync(portalPath, "utf8");

  const slice = (startMarker, endMarker) => {
    const start = html.indexOf(startMarker);
    assert.notEqual(start, -1, `could not find "${startMarker}" in portal.html`);
    const end = html.indexOf(endMarker, start);
    assert.notEqual(end, -1, `could not find "${endMarker}" after "${startMarker}"`);
    return html.slice(start, end);
  };

  const pricingSrc = slice("const PRICING = {", "\nfunction fmt(");
  const bucketSrc = slice("function lengthBucket(", "\n// ---");
  const computeSrc = slice("function computePricing()", "\n// ---------------------------------------------------------------------\n// RENDER HELPERS");

  // computePricing() builds lineItems with fmt(); supply it rather than
  // slicing it out of the file, since it is pure presentation.
  const sandbox = {
    state: null,
    auditPrice: null,
    fmt: (n) => "$" + Math.round(n || 0).toLocaleString("en-US"),
  };
  vm.createContext(sandbox);
  vm.runInContext(`${pricingSrc}\n${bucketSrc}\n${computeSrc}\nthis.PRICING = PRICING; this.computePricing = computePricing;`, sandbox);

  return sandbox;
}

const client = extractClientPricing();

test("server PRICING constants match portal.html verbatim", () => {
  // Compare only the keys the server mirrors; the client carries extra
  // presentation-only fields (labels, notes) the server has no use for.
  const numericKeys = [
    "HOST_ADDERS", "LAUNCH_BASE_PRICES", "LAUNCH_LENGTH_MULTIPLIERS",
    "SCRIPT_RATES_PER_EPISODE", "WEB_BASE_RATES", "WEB_ADDON_RATES",
    "SOCIAL_CLIP_RATES", "PRODUCTION_RATES", "BOOST_AD_RATES",
    "POSTCAST_MONTHLY", "WEBICAST_MONTHLY", "AUDIT_PRICE_DEFAULT",
  ];
  // vm-context objects have a different realm's prototype, so compare
  // by value rather than by deepStrictEqual's reference-equal check.
  const byValue = (v) => JSON.parse(JSON.stringify(v));
  for (const key of numericKeys) {
    assert.deepEqual(byValue(SERVER_PRICING[key]), byValue(client.PRICING[key]), `PRICING.${key} drifted`);
  }
  for (const tier of Object.keys(client.PRICING.ORBIT_TIERS)) {
    assert.equal(
      SERVER_PRICING.ORBIT_TIERS[tier].monthly,
      client.PRICING.ORBIT_TIERS[tier].monthly,
      `ORBIT_TIERS.${tier}.monthly drifted`,
    );
  }
  for (const d of client.PRICING.DISCOUNTS) {
    const mine = SERVER_PRICING.DISCOUNTS.find((x) => x.key === d.key);
    assert.ok(mine, `DISCOUNTS.${d.key} missing on server`);
    assert.equal(mine.rate, d.rate, `DISCOUNTS.${d.key}.rate drifted`);
  }
});

/* Drive the client function the way the portal does: by mutating the
   global `state` it closes over. */
function clientCompute(sel, paymentPlan, promo) {
  // promo mirrors what /api/promo/validate returns:
  // { code, discountType: 'percent'|'flat', amount } — bps or cents.
  client.state = { pkg: { ...sel, paymentPlan, promoApplied: promo ?? null } };
  client.auditPrice = client.PRICING.AUDIT_PRICE_DEFAULT;
  return client.computePricing();
}

/* Full cross-product of every dimension that changes a price, with the
   dimensions that only scale a single adder (orbit tier, host voice,
   payment plan) rotated rather than nested — nesting them too pushes the
   sweep past 7M cases without covering any new pricing branch. */
function* everySelection() {
  const P = SERVER_PRICING;
  const tiers = Object.keys(P.ORBIT_TIERS);
  const voices = Object.keys(P.HOST_ADDERS);
  const plans = ["monthly", "full_year", "six_months"];
  let n = 0;

  for (const path of ["launch", "postcast", "webicast", "audit"]) {
    for (const episodes of P.LAUNCH_EPISODE_OPTIONS) {
      for (const lengthMin of P.EPISODE_LENGTHS) {
        for (const scripting of [false, true]) {
          for (const webOn of [false, true]) {
            for (const freq of webOn ? P.WEB_FREQ_OPTIONS : ["4"]) {
              for (const blogLength of webOn ? P.BLOG_LENGTH_OPTIONS.map((o) => o.value) : ["none"]) {
                for (const socialOn of [false, true]) {
                  for (const clips of socialOn ? P.SOCIAL_CLIP_OPTIONS : [4]) {
                    for (const prodOn of [false, true]) {
                      for (const boostOn of [false, true]) {
                        n++;
                        yield {
                          path,
                          launch: { episodes, lengthMin, scripting, location: "lpm" },
                          orbit: { tier: tiers[n % tiers.length], voice: voices[n % voices.length] },
                          pods: {
                            web: {
                              enabled: webOn, freq, blogLength,
                              transcripts: webOn, embeddedPlayers: webOn, embeddedVideo: boostOn,
                            },
                            social:     { enabled: socialOn, clips },
                            production: { enabled: prodOn, freq: P.PRODUCTION_FREQ_OPTIONS[n % P.PRODUCTION_FREQ_OPTIONS.length] },
                            boost:      { enabled: boostOn, adsPerMo: P.BOOST_AD_OPTIONS[n % P.BOOST_AD_OPTIONS.length], adSpend: 500 },
                          },
                          paymentPlan: plans[n % plans.length],
                        };
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

test("server computePricing matches portal.html across every option combination", () => {
  let checked = 0;
  for (const sel of everySelection()) {
    const mine = serverCompute(validateSelection(sel), null);
    const theirs = clientCompute(sel, sel.paymentPlan, null);

    // Compare first, build the (expensive) failure message only on a
    // mismatch — an eager template here dominates the whole run.
    if (mine.chargedToday !== theirs.chargedToday || mine.recurringTotal !== theirs.recurringTotal) {
      assert.fail(
        `pricing drift for ${JSON.stringify(sel)}\n` +
        `  chargedToday   server=${mine.chargedToday} portal=${theirs.chargedToday}\n` +
        `  recurringTotal server=${mine.recurringTotal} portal=${theirs.recurringTotal}`,
      );
    }
    checked++;
  }
  assert.ok(checked > 100000, `expected a broad sweep, only checked ${checked}`);
  console.log(`    compared ${checked.toLocaleString()} selections`);
});

test("percent promo codes reproduce the portal's additive stacking", () => {
  // The portal stacks a payment-plan discount and a promo additively.
  // partner_referral is 10% there; model it as a 1000bp DB row here.
  const sel = validateSelection({
    path: "postcast",
    launch: { episodes: 10, lengthMin: 45, scripting: false, location: "lpm" },
    orbit: { tier: "standard", voice: "1" },
    pods: {
      web: { enabled: true, freq: "4", transcripts: false, embeddedPlayers: false, embeddedVideo: false, blogLength: "none" },
      social: { enabled: false, clips: 4 },
      production: { enabled: false, freq: 4 },
      boost: { enabled: false, adsPerMo: 1, adSpend: 0 },
    },
    paymentPlan: "full_year",
  });

  const mine = serverCompute(sel, { discount_type: "percent", amount: 1000 });
  const theirs = clientCompute(
    { ...sel, paymentPlan: undefined },
    "full_year",
    { code: "partner10", discountType: "percent", amount: 1000 },
  );
  assert.equal(mine.chargedToday, theirs.chargedToday);
  assert.equal(mine.recurringTotal, theirs.recurringTotal);
});

test("a flat promo larger than the discountable base cannot produce a negative charge", () => {
  const sel = validateSelection({
    path: "postcast",
    launch: { episodes: 10, lengthMin: 45, scripting: false, location: "lpm" },
    orbit: { tier: "standard", voice: "1" },
    pods: {
      web: { enabled: false, freq: "4", transcripts: false, embeddedPlayers: false, embeddedVideo: false, blogLength: "none" },
      social: { enabled: false, clips: 4 },
      production: { enabled: false, freq: 4 },
      boost: { enabled: false, adsPerMo: 1, adSpend: 0 },
    },
    paymentPlan: "monthly",
  });
  // $5,000 flat off a $1,200 Postcast.
  const out = serverCompute(sel, { discount_type: "flat", amount: 500000 });
  assert.equal(out.chargedToday, 0);
  assert.equal(out.chargedTodayCents, 0);
  assert.ok(out.recurringTotal >= 0);
});

test("validateSelection rejects out-of-table values instead of producing NaN", () => {
  const base = {
    path: "launch",
    launch: { episodes: 10, lengthMin: 45, scripting: false, location: "lpm" },
    orbit: { tier: "standard", voice: "1" },
    pods: {
      web: { enabled: false, freq: "4", blogLength: "none" },
      social: { enabled: false, clips: 4 },
      production: { enabled: false, freq: 4 },
      boost: { enabled: false, adsPerMo: 1, adSpend: 0 },
    },
    paymentPlan: "monthly",
  };

  const bad = [
    { ...base, launch: { ...base.launch, episodes: 999 } },
    { ...base, launch: { ...base.launch, lengthMin: 37 } },
    { ...base, orbit: { tier: "enterprise", voice: "1" } },
    { ...base, orbit: { tier: "standard", voice: "9" } },
    { ...base, path: "freebie" },
    { ...base, paymentPlan: "partner_referral" }, // a promo key, not a plan
    { ...base, pods: { ...base.pods, boost: { enabled: true, adsPerMo: 3, adSpend: 0 } } },
    { ...base, pods: { ...base.pods, boost: { enabled: true, adsPerMo: 1, adSpend: -50 } } },
  ];

  for (const sel of bad) {
    assert.throws(() => validateSelection(sel), /ValidationError|invalid|unknown/,
      `expected rejection for ${JSON.stringify(sel)}`);
  }
});

test("flat promo codes agree between the portal and the server", () => {
  const raw = {
    path: "webicast",
    launch: { episodes: 10, lengthMin: 45, scripting: false, location: "lpm" },
    orbit: { tier: "standard", voice: "1" },
    pods: {
      web: { enabled: true, freq: "4", transcripts: true, embeddedPlayers: false, embeddedVideo: false, blogLength: "801" },
      social: { enabled: true, clips: 4 },
      production: { enabled: false, freq: 4 },
      boost: { enabled: false, adsPerMo: 1, adSpend: 0 },
    },
    paymentPlan: "six_months",
  };
  const promoDb = { discount_type: "flat", amount: 25000 };            // $250 in cents
  const promoUi = { code: "save250", discountType: "flat", amount: 25000 };

  const mine = serverCompute(validateSelection(raw), promoDb);
  const theirs = clientCompute(raw, "six_months", promoUi);

  assert.equal(mine.chargedToday, theirs.chargedToday);
  assert.equal(mine.recurringTotal, theirs.recurringTotal);
  assert.ok(mine.discAmount > 0);
});
