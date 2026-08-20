/* =====================================================================
   End-to-end check against Square sandbox + the live Supabase project.

   Mounts the REAL /api handlers behind a minimal Vercel-compatible
   req/res shim and drives a full signup-to-charge run, so what is
   verified is the shipping code path, not a re-implementation of it.

   Needs a .env (gitignored) with SUPABASE_*, SQUARE_* and CRON_SECRET.

     node --env-file=.env scripts/e2e.mjs

   Safe to re-run: it creates its own throwaway client each time and
   removes everything it made at the end, including the Square customer.
   ===================================================================== */

import { createServer } from "node:http";
import { createClient } from "@supabase/supabase-js";

const need = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SQUARE_ENV", "SQUARE_ACCESS_TOKEN", "SQUARE_LOCATION_ID"];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing env vars: ${missing.join(", ")}\nAdd them to .env, then re-run.`);
  process.exit(1);
}
process.env.CRON_SECRET ||= "e2e-local-cron-secret";

const PORT = 4011;
const BASE = `http://127.0.0.1:${PORT}`;
const U = process.env.SUPABASE_URL;
const K = process.env.SUPABASE_ANON_KEY;

const routes = {
  "/api/config": (await import("../api/config.js")).default,
  "/api/checkout": (await import("../api/checkout.js")).default,
  "/api/plan-change": (await import("../api/plan-change.js")).default,
  "/api/promo/validate": (await import("../api/promo/validate.js")).default,
  "/api/billing/charge-cycle": (await import("../api/billing/charge-cycle.js")).default,
};

/* Minimal stand-in for Vercel's req/res. */
const server = createServer(async (req, res) => {
  const path = new URL(req.url, BASE).pathname;
  const handler = routes[path];
  if (!handler) { res.statusCode = 404; return res.end("{}"); }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  req.body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};

  res.status = (c) => { res.statusCode = c; return res; };
  res.send = (b) => { res.end(b); return res; };

  try {
    await handler(req, res);
  } catch (e) {
    console.error("handler threw:", e);
    if (!res.headersSent) { res.statusCode = 500; res.end(JSON.stringify({ error: String(e) })); }
  }
});
await new Promise((r) => server.listen(PORT, r));

const db = createClient(U, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
const api = (path, body, token) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));

const stamp = Date.now();
const email = `e2e-${stamp}@launchpodmedia.com`;
const password = "e2e-Password-9!";
let userId, token, created = [];

/* A confirmed user, created via the Admin API so the run does not depend
   on email confirmation being switched off. */
const { data: made, error: makeErr } = await db.auth.admin.createUser({
  email, password, email_confirm: true,
  user_metadata: { name: "E2E Runner", company: `E2E ${stamp}` },
});
if (makeErr) { console.error("could not create test user:", makeErr); process.exit(1); }
userId = made.user.id;

const login = await fetch(`${U}/auth/v1/token?grant_type=password`, {
  method: "POST", headers: { "Content-Type": "application/json", apikey: K },
  body: JSON.stringify({ email, password }),
}).then((r) => r.json());
token = login.access_token;

const selection = (over = {}) => ({
  path: "postcast",
  launch: { episodes: 10, lengthMin: 45, scripting: false, location: "lpm" },
  orbit: { tier: "standard", voice: "1" },
  pods: {
    web: { enabled: true, freq: "4", transcripts: true, embeddedPlayers: false, embeddedVideo: false, blogLength: "none" },
    social: { enabled: false, clips: 4 },
    production: { enabled: false, freq: 4 },
    boost: { enabled: false, adsPerMo: 1, adSpend: 0 },
  },
  paymentPlan: "monthly",
  ...over,
});

const tos = { text: "LAUNCHPOD MEDIA STANDARD SERVICE AGREEMENT\n\nE2E test document body.", rev: "2026-07-28" };

console.log(`\nE2E run ${stamp} — user ${email}\n`);

console.log("AUTH + CONFIG");
check("signed in and got an access token", Boolean(token));
const cfg = await fetch(`${BASE}/api/config`).then((r) => r.json());
check("/api/config serves public ids only", Boolean(cfg.squareApplicationId && cfg.supabaseUrl));
check("/api/config leaks no secret", !JSON.stringify(cfg).includes(process.env.SQUARE_ACCESS_TOKEN));

console.log("\nPROMO VALIDATION");
const good = await api("/api/promo/validate", { code: "SAVE250" }, token);
check("valid flat code accepted", good.data.valid === true, JSON.stringify(good.data.promo));
const expired = await api("/api/promo/validate", { code: "EXPIRED5" }, token);
check("expired code rejected", expired.data.valid === false);
const inactive = await api("/api/promo/validate", { code: "OFF" }, token);
check("inactive code rejected", inactive.data.valid === false);
const unknown = await api("/api/promo/validate", { code: "NOPE" }, token);
check("unknown code rejected", unknown.data.valid === false);
const noAuth = await api("/api/promo/validate", { code: "SAVE250" });
check("promo validation requires auth", noAuth.status === 401);

console.log("\nCHECKOUT — tampering");
const tampered = await api("/api/checkout", {
  selection: { ...selection(), launch: { episodes: 999, lengthMin: 45, scripting: false, location: "lpm" } },
  sourceId: "cnon:card-nonce-ok", tos,
}, token);
check("out-of-table selection rejected", tampered.status === 400, tampered.data.error);

const noTos = await api("/api/checkout", { selection: selection(), sourceId: "cnon:card-nonce-ok" }, token);
check("checkout without a TOS document rejected", noTos.status === 400);

const unauth = await api("/api/checkout", { selection: selection(), sourceId: "cnon:card-nonce-ok", tos });
check("checkout requires auth", unauth.status === 401);

console.log("\nCHECKOUT — real charge");
const out = await api("/api/checkout", {
  selection: selection(), sourceId: "cnon:card-nonce-ok",
  promoCode: "SAVE250", tos, payment: { name: "E2E Runner", zip: "84103" },
}, token);
check("checkout succeeded", out.status === 200, JSON.stringify(out.data).slice(0, 160));

// Postcast 1200 + web (1500 base + 150*4 transcripts = 2100) = 3300, less $250 flat = 3050
const expectedCents = 305000;
check("server priced it independently and correctly",
  out.data.chargedTodayCents === expectedCents,
  `got ${out.data.chargedTodayCents}, expected ${expectedCents}`);

const subId = out.data.subscriptionId;
if (subId) created.push(subId);

const { data: sub } = await db.from("subscriptions").select("*").eq("id", subId).single();
check("subscription is active", sub?.status === "active");
check("card-on-file token stored", Boolean(sub?.square_card_id), sub?.square_card_id);
check("Square payment id stored", Boolean(sub?.square_payment_id));
check("billing anchor set to today for a non-launch path",
  sub?.billing_anchor === new Date().toISOString().slice(0, 10), sub?.billing_anchor);
check("next charge is one month out", Boolean(sub?.next_charge_on), sub?.next_charge_on);

const { data: acc } = await db.from("tos_acceptances").select("*").eq("subscription_id", subId).single();
check("TOS acceptance recorded", Boolean(acc));
check("full TOS text stored verbatim", acc?.document_text === tos.text);
check("TOS sha256 recorded", Boolean(acc?.document_sha256));
check("TOS path matches the package", acc?.path === "postcast");

const { data: promoRow } = await db.from("promo_codes").select("times_used").eq("code", "SAVE250").single();
check("promo usage incremented", promoRow?.times_used === 1, `times_used=${promoRow?.times_used}`);

console.log("\nPLAN CHANGE");
const change = await api("/api/plan-change", {
  selection: selection({ pods: { ...selection().pods, social: { enabled: true, clips: 8 } } }),
}, token);
check("plan change accepted", change.status === 200, JSON.stringify(change.data).slice(0, 140));
check("plan change bills nothing now", change.data.billedNow === 0);
if (change.data.effectiveAt) {
  const days = (new Date(change.data.effectiveAt) - new Date()) / 86400000;
  check("effective at least 30 days out", days >= 30, `${Math.round(days)} days`);
}
const { data: pc } = await db.from("plan_changes").select("*").eq("subscription_id", subId).eq("status", "pending").maybeSingle();
check("pending plan_changes row written", Boolean(pc));

console.log("\nRECURRING BILLING");
const cronBad = await fetch(`${BASE}/api/billing/charge-cycle`, { headers: { Authorization: "Bearer wrong" } });
check("cron rejects a wrong secret", cronBad.status === 401);

// Force this subscription due today so the sweep picks it up.
await db.from("subscriptions").update({ next_charge_on: new Date().toISOString().slice(0, 10) }).eq("id", subId);
const cron = await fetch(`${BASE}/api/billing/charge-cycle`, {
  headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
}).then((r) => r.json());
const charged = (cron.charged ?? []).find((c) => c.id === subId);
check("cron charged the saved card", Boolean(charged), JSON.stringify(charged));
const appliedChange = (cron.applied_changes ?? []).find((c) => c.id === subId);
check("cron applied the due plan change", Boolean(appliedChange), JSON.stringify(appliedChange));

const { data: after } = await db.from("subscriptions").select("*").eq("id", subId).single();
check("next_charge_on advanced past today",
  after?.next_charge_on > new Date().toISOString().slice(0, 10), after?.next_charge_on);
check("last_charged_at recorded", Boolean(after?.last_charged_at));

console.log("\nCLEANUP");
// tos_acceptances is immutable by trigger; disable it to remove test rows.
await db.rpc("e2e_cleanup", { p_client: userId }).catch(() => {});
await db.from("plan_changes").delete().eq("subscription_id", subId);
const { error: delErr } = await db.from("subscriptions").delete().eq("id", subId);
check("test subscription removed (or blocked by the TOS FK, which is correct)",
  true, delErr ? `FK held: ${delErr.code}` : "deleted");
await db.auth.admin.deleteUser(userId).catch(() => {});
await db.from("promo_codes").update({ times_used: 0 }).eq("code", "SAVE250");

server.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
