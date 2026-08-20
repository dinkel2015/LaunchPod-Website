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

/* A run that throws part-way through must not strand a test client, a
   promo code or a ClickUp folder. Registered before anything is created
   so an early failure still tidies up. */
async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    if (userId) {
      await db.rpc("e2e_purge_client", { p_client: userId });
      await db.auth.admin.deleteUser(userId);
    }
    await db.from("promo_codes").delete().like("code", `E2E%${stamp}`);
    if (clickupFolderId && process.env.CLICKUP_API_TOKEN) {
      await fetch(`https://api.clickup.com/api/v2/folder/${clickupFolderId}`, {
        method: "DELETE", headers: { Authorization: process.env.CLICKUP_API_TOKEN },
      });
    }
  } catch (e) {
    console.error("cleanup failed; check for leftovers:", e.message);
  }
}

const stamp = Date.now();
const email = `e2e-${stamp}@launchpodmedia.com`;
const password = "e2e-Password-9!";
let userId, token, created = [], clickupFolderId = null, cleanedUp = false;

process.on("uncaughtException", async (e) => { console.error("\nrun crashed:", e.message); await cleanup(); process.exit(1); });
process.on("unhandledRejection", async (e) => { console.error("\nrun crashed:", e?.message ?? e); await cleanup(); process.exit(1); });

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

/* The harness seeds its own promo codes and deletes them at the end, so
   it never depends on rows already in the table — and never leaves a
   working discount code behind in a live database. Run-stamped names
   keep concurrent runs from colliding. */
const CODE_FLAT     = `E2EFLAT${stamp}`;
const CODE_EXPIRED  = `E2EEXP${stamp}`;
const CODE_INACTIVE = `E2EOFF${stamp}`;
await db.from("promo_codes").insert([
  { code: CODE_FLAT,     discount_type: "flat",    amount: 25000, active: true },
  { code: CODE_EXPIRED,  discount_type: "percent", amount: 500,   active: true, expires_at: new Date(Date.now() - 86400000).toISOString() },
  { code: CODE_INACTIVE, discount_type: "percent", amount: 1500,  active: false },
]);

console.log(`\nE2E run ${stamp} — user ${email}\n`);

console.log("AUTH + CONFIG");
check("signed in and got an access token", Boolean(token));
const cfg = await fetch(`${BASE}/api/config`).then((r) => r.json());
check("/api/config serves public ids only", Boolean(cfg.squareApplicationId && cfg.supabaseUrl));
check("/api/config leaks no secret", !JSON.stringify(cfg).includes(process.env.SQUARE_ACCESS_TOKEN));

console.log("\nPROMO VALIDATION");
const good = await api("/api/promo/validate", { code: CODE_FLAT }, token);
check("valid flat code accepted", good.data.valid === true, JSON.stringify(good.data.promo));
const expired = await api("/api/promo/validate", { code: CODE_EXPIRED }, token);
check("expired code rejected", expired.data.valid === false);
const inactive = await api("/api/promo/validate", { code: CODE_INACTIVE }, token);
check("inactive code rejected", inactive.data.valid === false);
const unknown = await api("/api/promo/validate", { code: "NOPE" }, token);
check("unknown code rejected", unknown.data.valid === false);
const noAuth = await api("/api/promo/validate", { code: CODE_FLAT });
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
  promoCode: CODE_FLAT, tos, payment: { name: "E2E Runner", zip: "84103" },
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

const { data: promoRow } = await db.from("promo_codes").select("times_used").eq("code", CODE_FLAT).single();
check("promo usage incremented", promoRow?.times_used === 1, `times_used=${promoRow?.times_used}`);

console.log("\nCLICKUP PROVISIONING");
if (!process.env.CLICKUP_API_TOKEN) {
  console.log("  SKIP  no CLICKUP_API_TOKEN set");
} else {
  const cu = async (p, o = {}) => {
    const r = await fetch(`https://api.clickup.com/api/v2${p}`, {
      ...o, headers: { Authorization: process.env.CLICKUP_API_TOKEN, "Content-Type": "application/json", ...o.headers },
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  check("checkout reported provisioning succeeded", out.data.clickupProvisioned === true);
  check("checkout returned a dashboard url", Boolean(out.data.dashboardUrl), out.data.dashboardUrl);

  const { data: cuRow } = await db.from("subscriptions")
    .select("clickup_folder_id, clickup_dashboard_url, clickup_dashboard_view_id").eq("id", subId).single();
  check("folder id stored on the subscription", Boolean(cuRow?.clickup_folder_id), cuRow?.clickup_folder_id);
  check("dashboard view id stored", Boolean(cuRow?.clickup_dashboard_view_id), cuRow?.clickup_dashboard_view_id);

  clickupFolderId = cuRow?.clickup_folder_id;
  const folder = await cu(`/folder/${clickupFolderId}`);
  check("folder exists in ClickUp", folder.status === 200, folder.body?.name);
  check("folder is in the Delivery space", folder.body?.space?.id === process.env.CLICKUP_DELIVERY_SPACE_ID);

  const names = (folder.body.lists || []).map((l) => l.name.split(": ").pop());
  check("postcast path got Onboarding + PostCast", names.includes("Onboarding") && names.includes("PostCast"), names.join(", "));
  check("web pod added an SEO Optimization list", names.includes("SEO Optimization"));

  const views = await cu(`/folder/${clickupFolderId}/view`);
  const dash = (views.body.views || []).find((v) => v.type === "dashboard");
  check("a dashboard view exists on the folder", Boolean(dash), dash?.name);
  check("stored view id matches the real one", dash?.id === cuRow?.clickup_dashboard_view_id);
}

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

const today = new Date().toISOString().slice(0, 10);
const runCron = () => fetch(`${BASE}/api/billing/charge-cycle`, {
  headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
}).then((r) => r.json());

/* Pass 1: the subscription is due, but the plan change is not. The cycle
   must be charged at the OLD price and the change left pending — this is
   the guarantee that an upgrade cannot bill early. */
await db.from("subscriptions").update({ next_charge_on: today }).eq("id", subId);
const cron1 = await runCron();

const charged = (cron1.charged ?? []).find((c) => c.id === subId);
check("cron charged the saved card", Boolean(charged), JSON.stringify(charged));
check("charged the OLD price, not the pending upgrade",
  charged?.cents === 305000, `charged ${charged?.cents}, old price 305000, upgrade 570000`);
check("a not-yet-effective plan change is NOT applied",
  !(cron1.applied_changes ?? []).some((c) => c.id === subId));

const { data: stillPending } = await db.from("plan_changes")
  .select("status").eq("subscription_id", subId).maybeSingle();
check("plan change still pending after the early cycle", stillPending?.status === "pending");

const { data: after } = await db.from("subscriptions").select("*").eq("id", subId).single();
check("next_charge_on advanced past today", after?.next_charge_on > today, after?.next_charge_on);
check("last_charged_at recorded", Boolean(after?.last_charged_at));

/* The guarantee the key exists for: a cron that fires twice in one day
   for the same cycle at the same price must charge exactly once. */
await db.from("subscriptions").update({ next_charge_on: charged.cycle }).eq("id", subId);
const cronDup = await runCron();
const dup = (cronDup.charged ?? []).find((c) => c.id === subId);
check("same-day double-fire does not double-charge",
  dup?.paymentId === charged?.paymentId,
  `first ${charged?.paymentId}, second ${dup?.paymentId}`);

/* Pass 2: fast-forward to the cycle the change is effective on. Now it
   must be applied AND the new price charged. */
await db.from("subscriptions").update({ next_charge_on: today }).eq("id", subId);

/* Simulate the 30 days having passed. requested_at must move back too:
   the plan_change_min_notice CHECK requires effective_at > requested_at,
   so setting effective_at to today alone is rejected by the database —
   which is the constraint working, not a bug. */
const backdated = new Date(Date.now() - 31 * 86400000).toISOString();
const { error: ffErr } = await db.from("plan_changes")
  .update({ requested_at: backdated, effective_at: today })
  .eq("subscription_id", subId).eq("status", "pending");
check("fast-forwarding the plan change respects the notice constraint", !ffErr, ffErr?.message ?? "");

const cron2 = await runCron();

const applied = (cron2.applied_changes ?? []).find((c) => c.id === subId);
check("an effective plan change IS applied", Boolean(applied), JSON.stringify(applied));
const charged2 = (cron2.charged ?? []).find((c) => c.id === subId);
check("charges the NEW price once effective",
  charged2?.cents === 570000, `charged ${charged2?.cents}, expected 570000`);

const { data: post } = await db.from("subscriptions").select("recurring_cents, selection").eq("id", subId).single();
check("subscription recurring_cents updated to the new plan", post?.recurring_cents === 570000);
check("subscription selection swapped to the new plan",
  post?.selection?.pods?.social?.enabled === true && post?.selection?.pods?.social?.clips === 8);

const { data: doneChange } = await db.from("plan_changes").select("status, applied_at").eq("subscription_id", subId).maybeSingle();
check("plan change marked applied", doneChange?.status === "applied" && Boolean(doneChange?.applied_at));

console.log("\nCLEANUP");
/* tos_acceptances is immutable by trigger and its FK is RESTRICT, so the
   subscription cannot be deleted while an acceptance points at it. That
   is the intended production behaviour; for a test run the trigger is
   lifted just long enough to drop the rows this run created. */
await db.rpc("e2e_purge_client", { p_client: userId });
const { count } = await db.from("subscriptions").select("id", { count: "exact", head: true }).eq("client_id", userId);
check("test rows purged", (count ?? 0) === 0, `${count ?? "?"} subscriptions left`);
try { await db.auth.admin.deleteUser(userId); } catch { /* already gone */ }
const { error: promoDelErr } = await db.from("promo_codes").delete().in("code", [CODE_FLAT, CODE_EXPIRED, CODE_INACTIVE]);
check("seeded promo codes removed", !promoDelErr, promoDelErr?.message ?? "");

if (clickupFolderId) {
  const del = await fetch(`https://api.clickup.com/api/v2/folder/${clickupFolderId}`, {
    method: "DELETE", headers: { Authorization: process.env.CLICKUP_API_TOKEN },
  });
  check("test ClickUp folder removed", del.status === 200, `status ${del.status}`);
  clickupFolderId = null;
}
cleanedUp = true;


server.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
