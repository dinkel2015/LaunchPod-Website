/* =====================================================================
   SERVER-SIDE PRICING — authoritative.

   This is a faithful mirror of `PRICING` + `computePricing()` in
   portal.html, which are themselves ported from propdoc/config/pricing.ts.
   The client's copy exists only to render a live preview; the number that
   actually gets charged is the one computed HERE, from the client's
   *selections* (never from a client-submitted total).

   If pricing changes it must change in three places until these are
   factored into a shared package: propdoc/config/pricing.ts,
   portal.html, and this file. There is a parity test in
   api/_lib/pricing.test.mjs that guards the portal.html <-> here half.
   ===================================================================== */

export const PRICING = {
  ORBIT_TIERS: {
    basic:    { label: "Basic",    monthly: 3000 },
    standard: { label: "Standard", monthly: 4500 },
    pro:      { label: "Pro",      monthly: 6000 },
  },
  HOST_ADDERS: { ai: 100, "1": 0, "2": 250, "3": 500, "4": 750 },
  EPISODE_LENGTHS: [15, 30, 45, 60, 75, 90, 105, 120],
  RECORDING_LOCATIONS: ["lpm", "client", "third_party"],
  LAUNCH_BASE_PRICES: { 8: 10000, 10: 12500, 12: 15000 },
  LAUNCH_LENGTH_MULTIPLIERS: { 15: .75, 30: .85, 45: 1.00, 60: 1.20, 75: 1.35, 90: 1.50, 105: 1.65, 120: 1.85 },
  LAUNCH_EPISODE_OPTIONS: [8, 10, 12],
  SCRIPT_RATES_PER_EPISODE: { 15: 315, 30: 675, 45: 975, 60: 1350, 75: 1575, 90: 1800, 105: 2200, 120: 2700 },
  WEB_BASE_RATES: {
    "30": { "15": 4000, "30": 5500, "45": 7000, "60": 9000, "75": 11000, "90plus": 13000 },
    "8":  { "15": 1500, "30": 2000, "45": 2800, "60": 3500, "75": 4500, "90plus": 5500 },
    "4":  { "15": 1500, "30": 1500, "45": 1500, "60": 1800, "75": 2200, "90plus": 2800 },
    "3":  { "15": 1500, "30": 1500, "45": 1500, "60": 1500, "75": 2000, "90plus": 2500 },
    "2":  { "15": 1500, "30": 1500, "45": 1500, "60": 1500, "75": 1500, "90plus": 2000 },
    "1":  { "15": 1500, "30": 1500, "45": 1500, "60": 1500, "75": 1500, "90plus": 1500 },
  },
  WEB_FREQ_OPTIONS: ["1", "2", "3", "4", "8", "30"],
  WEB_ADDON_RATES: { transcript: 150, embeddedPlayer: 50, embeddedVideo: 100 },
  BLOG_LENGTH_OPTIONS: [
    { value: "none", adder: 0 },
    { value: "500",  adder: 0 },
    { value: "801",  adder: 100 },
    { value: "1201", adder: 250 },
    { value: "1701", adder: 400 },
    { value: "2501", adder: 600 },
  ],
  SOCIAL_CLIP_RATES: { 1: 400, 2: 375, 4: 350, 6: 325, 8: 300 },
  SOCIAL_CLIP_OPTIONS: [1, 2, 4, 6, 8],
  PRODUCTION_RATES: { 15: 375, 30: 625, 45: 875, 60: 1250, 75: 1500, 90: 1750, 105: 1875, 120: 2000 },
  PRODUCTION_FREQ_OPTIONS: [1, 2, 3, 4, 8, 30],
  BOOST_AD_RATES: { 1: 750, 2: 1000, 4: 1500, 8: 2000 },
  BOOST_AD_OPTIONS: [1, 2, 4, 8],
  DISCOUNTS: [
    { key: "full_year",        label: "Full Year Upfront", rate: 0.10 },
    { key: "six_months",       label: "6 Months Upfront",  rate: 0.05 },
    { key: "partner_referral", label: "Partner Referral",  rate: 0.10 },
    { key: "employee",         label: "Employee",          rate: 0.05 },
  ],
  POSTCAST_MONTHLY: 1200,
  WEBICAST_MONTHLY: 1200,
  AUDIT_PRICE_DEFAULT: 1000,
};

export const PACKAGE_PATHS = ["launch", "postcast", "webicast", "audit"];

/* Only these two DISCOUNTS keys are selectable as a *payment plan*. The
   other two exist as promo-style discounts and must not be settable by
   choosing a payment plan. */
export const PAYMENT_PLANS = ["monthly", "full_year", "six_months"];

const lengthBucket = (len) => (len >= 90 ? "90plus" : String(len));
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

/* ---------------------------------------------------------------------
   validateSelection — hard gate on anything the client sends.

   Every value is checked against the PRICING tables before it is used as
   a lookup key. Without this, a submitted `episodes: 999` yields
   `undefined * undefined = NaN`, and NaN propagates silently to a $0
   charge. Returns a normalized copy; never mutates the input.
   --------------------------------------------------------------------- */
export function validateSelection(raw) {
  if (!raw || typeof raw !== "object") throw new ValidationError("selection missing");

  const path = raw.path;
  if (!PACKAGE_PATHS.includes(path)) throw new ValidationError(`unknown path: ${path}`);

  const launch = raw.launch || {};
  const episodes = Number(launch.episodes);
  const lengthMin = Number(launch.lengthMin);
  if (!PRICING.LAUNCH_EPISODE_OPTIONS.includes(episodes)) {
    throw new ValidationError(`invalid launch.episodes: ${launch.episodes}`);
  }
  if (!PRICING.EPISODE_LENGTHS.includes(lengthMin)) {
    throw new ValidationError(`invalid launch.lengthMin: ${launch.lengthMin}`);
  }
  if (!PRICING.RECORDING_LOCATIONS.includes(launch.location)) {
    throw new ValidationError(`invalid launch.location: ${launch.location}`);
  }

  const orbit = raw.orbit || {};
  if (!has(PRICING.ORBIT_TIERS, orbit.tier)) throw new ValidationError(`invalid orbit.tier: ${orbit.tier}`);
  if (!has(PRICING.HOST_ADDERS, orbit.voice)) throw new ValidationError(`invalid orbit.voice: ${orbit.voice}`);

  const pods = raw.pods || {};
  const web = pods.web || {};
  const social = pods.social || {};
  const production = pods.production || {};
  const boost = pods.boost || {};

  if (web.enabled) {
    if (!PRICING.WEB_FREQ_OPTIONS.includes(String(web.freq))) {
      throw new ValidationError(`invalid pods.web.freq: ${web.freq}`);
    }
    if (!PRICING.BLOG_LENGTH_OPTIONS.some((o) => o.value === web.blogLength)) {
      throw new ValidationError(`invalid pods.web.blogLength: ${web.blogLength}`);
    }
  }
  if (social.enabled && !PRICING.SOCIAL_CLIP_OPTIONS.includes(Number(social.clips))) {
    throw new ValidationError(`invalid pods.social.clips: ${social.clips}`);
  }
  if (production.enabled && !PRICING.PRODUCTION_FREQ_OPTIONS.includes(Number(production.freq))) {
    throw new ValidationError(`invalid pods.production.freq: ${production.freq}`);
  }
  if (boost.enabled) {
    if (!PRICING.BOOST_AD_OPTIONS.includes(Number(boost.adsPerMo))) {
      throw new ValidationError(`invalid pods.boost.adsPerMo: ${boost.adsPerMo}`);
    }
    const spend = Number(boost.adSpend);
    // Ad spend is a client-chosen passthrough amount, so it has no lookup
    // table to check against — only sanity bounds.
    if (!Number.isFinite(spend) || spend < 0 || spend > 1_000_000) {
      throw new ValidationError(`invalid pods.boost.adSpend: ${boost.adSpend}`);
    }
  }

  if (!PAYMENT_PLANS.includes(raw.paymentPlan)) {
    throw new ValidationError(`invalid paymentPlan: ${raw.paymentPlan}`);
  }

  return {
    path,
    launch: {
      episodes,
      lengthMin,
      scripting: Boolean(launch.scripting),
      location: launch.location,
    },
    orbit: { tier: orbit.tier, voice: String(orbit.voice) },
    pods: {
      web: {
        enabled: Boolean(web.enabled),
        freq: String(web.freq ?? "4"),
        transcripts: Boolean(web.transcripts),
        embeddedPlayers: Boolean(web.embeddedPlayers),
        embeddedVideo: Boolean(web.embeddedVideo),
        blogLength: web.blogLength ?? "none",
      },
      social:     { enabled: Boolean(social.enabled),     clips: Number(social.clips ?? 4) },
      production: { enabled: Boolean(production.enabled), freq: Number(production.freq ?? 4) },
      boost: {
        enabled: Boolean(boost.enabled),
        adsPerMo: Number(boost.adsPerMo ?? 1),
        adSpend: Number(boost.adSpend ?? 0),
      },
    },
    paymentPlan: raw.paymentPlan,
  };
}

/* ---------------------------------------------------------------------
   computePricing — mirrors portal.html's computePricing() exactly.

   Two faithful-to-the-original quirks, preserved deliberately so the
   server and the on-screen preview never disagree:

   1. Web Pod and Production Pod price off `launch.lengthMin` on EVERY
      path, including postcast/webicast/audit where the Launch step is
      never shown and lengthMin keeps its default of 45.
   2. `launchTotal` and `orbitMonthly` are excluded from `discountable`,
      so payment-plan and promo discounts never touch the one-time Launch
      fee or the Orbit retainer.

   Both are flagged in the handoff notes; changing either is a pricing
   decision, not a code fix, and must change in portal.html too.

   `promo` is the row from public.promo_codes (or null) — already
   validated and looked up server-side by the caller.
   --------------------------------------------------------------------- */
export function computePricing(sel, promo = null) {
  const path = sel.path;

  const launchBase = PRICING.LAUNCH_BASE_PRICES[sel.launch.episodes] * PRICING.LAUNCH_LENGTH_MULTIPLIERS[sel.launch.lengthMin];
  const scriptingCost = sel.launch.scripting
    ? PRICING.SCRIPT_RATES_PER_EPISODE[sel.launch.lengthMin] * sel.launch.episodes
    : 0;
  const launchTotal = launchBase + scriptingCost;

  const entryMonthly = path === "postcast" ? PRICING.POSTCAST_MONTHLY
                     : path === "webicast" ? PRICING.WEBICAST_MONTHLY
                     : 0;
  const entryOneTime = path === "audit" ? PRICING.AUDIT_PRICE_DEFAULT : 0;

  const orbitMonthly = path === "launch"
    ? PRICING.ORBIT_TIERS[sel.orbit.tier].monthly + PRICING.HOST_ADDERS[sel.orbit.voice]
    : 0;

  const web = sel.pods.web;
  const webBucket = lengthBucket(sel.launch.lengthMin);
  const webBase = web.enabled ? PRICING.WEB_BASE_RATES[web.freq][webBucket] : 0;
  const freqPerMonth = Number(web.freq);
  const blogAdder = (PRICING.BLOG_LENGTH_OPTIONS.find((o) => o.value === web.blogLength) || {}).adder || 0;
  const webAddons = web.enabled
    ? (web.transcripts     ? PRICING.WEB_ADDON_RATES.transcript     * freqPerMonth : 0) +
      (web.embeddedPlayers ? PRICING.WEB_ADDON_RATES.embeddedPlayer * freqPerMonth : 0) +
      (web.embeddedVideo   ? PRICING.WEB_ADDON_RATES.embeddedVideo  * freqPerMonth : 0) +
      blogAdder * freqPerMonth
    : 0;
  const webMonthly = webBase + webAddons;

  const social = sel.pods.social;
  const socialMonthly = social.enabled ? PRICING.SOCIAL_CLIP_RATES[social.clips] * social.clips : 0;

  const production = sel.pods.production;
  const productionMonthly = production.enabled
    ? PRICING.PRODUCTION_RATES[sel.launch.lengthMin] * production.freq
    : 0;

  const boost = sel.pods.boost;
  const boostMgmt = boost.enabled ? PRICING.BOOST_AD_RATES[boost.adsPerMo] : 0;
  const boostAdSpend = boost.enabled ? Number(boost.adSpend || 0) : 0;

  const discountable = entryMonthly + webMonthly + socialMonthly + productionMonthly + boostMgmt;

  const planDiscountRate = (PRICING.DISCOUNTS.find((d) => d.key === sel.paymentPlan) || {}).rate || 0;
  const planDiscountAmt = discountable * planDiscountRate;

  // Promo comes from the DB, not from PRICING.DISCOUNTS. percent codes
  // store basis points; flat codes store cents.
  let promoDiscountAmt = 0;
  if (promo) {
    promoDiscountAmt = promo.discount_type === "percent"
      ? discountable * (promo.amount / 10000)
      : promo.amount / 100;
  }

  // Discounts stack additively (matching the portal preview), but can
  // never exceed the discountable base — otherwise a generous flat code
  // on a small package produces a negative charge.
  const discAmount = Math.min(planDiscountAmt + promoDiscountAmt, discountable);

  const recurringTotal = orbitMonthly + discountable - discAmount + boostAdSpend;
  const chargedToday = path === "launch"
    ? launchTotal
    : entryOneTime + entryMonthly + webMonthly + socialMonthly + productionMonthly + boostMgmt - discAmount + boostAdSpend;

  return {
    launchTotal, entryMonthly, entryOneTime, orbitMonthly,
    webMonthly, socialMonthly, productionMonthly, boostMgmt, boostAdSpend,
    discountable, discAmount,
    recurringTotal, chargedToday,
    chargedTodayCents: toCents(chargedToday),
    recurringCents:    toCents(recurringTotal),
  };
}

/* Dollars -> integer cents. Rounded ONCE, at the edge, so the fractional
   dollars produced by LAUNCH_LENGTH_MULTIPLIERS don't accumulate error. */
export function toCents(dollars) {
  return Math.round((Number(dollars) || 0) * 100);
}
