# Client Portal — backend setup

The portal front-end is `portal.html` (still a single dependency-free file).
Everything that needs a secret runs in `/api` as Vercel serverless functions.
The site stays static — no Next.js, no build step.

## What is wired

| Piece | Route | Status |
|---|---|---|
| Auth | Supabase Auth REST, called from `portal.html` | done |
| Public config | `GET /api/config` | done |
| Promo validation | `POST /api/promo/validate` | done |
| Checkout | `POST /api/checkout` | **verified against Square sandbox** |
| Recurring billing | `GET /api/billing/charge-cycle` (daily cron) | **verified against Square sandbox** |
| Plan changes | `POST /api/plan-change` | **verified** |
| ClickUp provisioning | `POST /api/clickup/provision` | written, **untested — needs an API token** |

Everything except ClickUp has been run end to end against Square sandbox and the
live Supabase project: 42/42 checks, plus 18/18 unit tests. ClickUp provisioning
is written but has never called the API — it needs a token.

**Node 22 is required.** `@supabase/supabase-js` uses native WebSocket, which
Node 20 does not have; `createClient` throws on construction there.

## Setup

1. **Supabase — done.** Project `lpm-portal` (`hdcoddhfrglbdpopdcur`, us-west-2).
   Both migrations are applied and the schema is verified against the live
   database: RLS isolates clients from each other, `promo_codes` is unreadable
   to `anon` and `authenticated`, the promo functions reject non-`service_role`
   callers, the usage cap holds, and TOS acceptances survive UPDATE and DELETE.
   The database is empty — all test rows were removed.

   `SUPABASE_URL` is `https://hdcoddhfrglbdpopdcur.supabase.co`.
   Use the **anon** key (the `eyJ...` JWT) for `SUPABASE_ANON_KEY`; the
   service_role key is in Project Settings → API and goes in Vercel only.

2. **Set the Vercel env vars** listed in `.env.example`. Secrets
   (`SUPABASE_SERVICE_ROLE_KEY`, `SQUARE_ACCESS_TOKEN`, `CLICKUP_API_TOKEN`,
   `CRON_SECRET`) are read only inside `/api` and never reach the browser.
   Generate the cron secret with:

   ```bash
   openssl rand -hex 32
   ```

3. **Supabase Auth settings.** If email confirmation is on, signup returns no
   session and the portal tells the client to confirm and sign in — that path
   is handled, just decide which behaviour you want.

4. **Vercel Cron** is declared in `vercel.json` (daily, 13:00 UTC). Vercel sends
   `CRON_SECRET` as a bearer token; the route rejects anything else.

## Tests

```bash
npm test
```

Runs without any credentials. Covers:

- **Pricing parity** — extracts the real `PRICING` and `computePricing()` out of
  `portal.html`, evaluates them, and compares against the server across
  **170,496 option combinations**. If the two ever drift, this fails.
- **Billing dates** — month-end clamping (a Jan 31 anchor bills Feb 28 and
  returns to Mar 31, rather than walking backwards), and that a plan change is
  never effective sooner than 30 days, checked for every request date in a year.
- **Guards** — `money()` rejects floats, `requireEnv` treats a blank env var as
  missing, the cron route refuses a wrong/absent secret, checkout refuses an
  unauthenticated caller before touching Square.

## End-to-end check

```bash
node --env-file=.env scripts/e2e.mjs
```

Mounts the real `/api` handlers behind a Vercel-compatible req/res shim and
drives a full signup-to-charge run against Square sandbox and the live Supabase
project — so what it verifies is the shipping code path, not a re-implementation.
It creates a throwaway client per run and cleans up after itself. Needs a local
`.env` (gitignored) including `SUPABASE_SERVICE_ROLE_KEY`.

## Blocking issue: email confirmation

Signup is currently **impossible** on this project. Email confirmation is on, and
Supabase's built-in SMTP is rate-limited to a handful of messages per hour — it
is explicitly not for production use. Every signup attempt during testing failed
with `over_email_send_rate_limit`, and `auth.users` stayed empty.

Two ways forward, in Authentication → Providers → Email:

1. **Turn off "Confirm email"** for v1. Signup returns a session immediately and
   the client goes straight into the wizard. Fastest path to launch.
2. **Configure custom SMTP** (Resend or Postmark). Needed anyway if checkout is
   ever going to send a receipt — the handoff left that provider undecided.

The portal already handles both cases: with confirmation on it tells the client
to confirm and sign in rather than dropping them into a wizard they cannot check
out from.

## Things worth knowing

**Pricing lives in three places.** `propdoc/config/pricing.ts`, `portal.html`,
and `api/_lib/pricing.js`. The parity test guards the last two; PropDoc is still
manual. Worth factoring into a shared package.

**Two quirks were preserved deliberately**, because changing either is a pricing
decision rather than a bug fix:

- Web Pod and Production Pod price off `launch.lengthMin` on *every* path,
  including Postcast/Webicast/Audit where that step is never shown and the value
  stays at its default of 45.
- The one-time Launch fee and the Orbit retainer are excluded from the
  discountable base, so no payment-plan or promo discount touches them.

**Promo codes changed shape.** They used to be matched against the hardcoded
`PRICING.DISCOUNTS` list, which meant a code that was valid in the database was
rejected on screen, and a code in the list but not in the database showed a
discount checkout would then refuse. They now go through
`/api/promo/validate`, and support flat-amount codes, which the old shape could
not express at all. Codes are still managed directly in the Supabase table
editor — no UI.

**ClickUp has two hard API limits** (both verified, both documented in
`api/_lib/clickup.js`):

- There is no "duplicate this folder" endpoint. The API can only create a folder
  from a *saved Folder Template*. `Client Template Folder` (`901318206130`) is a
  plain folder, so it can't be a duplication source until it's saved as a
  template in the ClickUp UI (**this is the chosen approach** — see below).
  With `CLICKUP_FOLDER_TEMPLATE_ID` unset, provisioning falls back to building
  the folder and only the lists the package path needs.
- Dashboards aren't in the public API at all. `clickup_dashboard_url` currently
  holds the client's **folder** URL, which is the closest shareable equivalent.

**TOS acceptances are immutable.** Database rules block UPDATE and DELETE. The
full rendered text is stored, not a boolean — including the "pending Michael's
confirmation" disclaimers, since those were part of what the client was shown.
That flag is still in the UI and stays until you say otherwise.

## Getting the ClickUp Folder Template ID

Save `Client Template Folder` as a Folder Template in the ClickUp UI, then:

```bash
curl -s -H "Authorization: $CLICKUP_API_TOKEN" https://api.clickup.com/api/v2/team/90132069393/folder_template
```

Take the `t-`-prefixed id of the template you just saved and set it as
`CLICKUP_FOLDER_TEMPLATE_ID` in Vercel. Pass the full id including the prefix.

Provisioning calls the template with `return_immediately: false` on purpose:
the default is `true`, which returns a folder id before the nested lists exist,
and the client would get a link to an empty folder. It also suppresses the
template author's due dates, start dates, assignees and followers, which would
otherwise land on a new client's board looking overdue on day one.

## Confirmed decisions

- **Launch path billing** — the one-time Launch fee is charged at checkout, and
  the recurring Orbit + Pods retainer starts one month later. The client is not
  billed a retainer for a show that isn't in production yet.
- **Square** — build and verify against sandbox, then flip `SQUARE_ENV` to
  `production` at launch. Nothing else changes between the two.
- **ClickUp** — folder template is the intended path; the explicit list builder
  stays as the fallback.
- **Admin tooling / promo UI** — none for v1, by decision. Supabase's table
  editor plus ClickUp directly is the admin surface.

## Why there is a migration 0002

`tos_acceptances` was originally made immutable with `DO INSTEAD NOTHING`
rules. Rules rewrite statements — including the ones Postgres issues internally
to maintain foreign keys — so deleting a subscription fired `ON DELETE SET NULL`
against a protected row, the rule swallowed it, and the delete failed with an
opaque `XX000: referential integrity query ... gave unexpected result`. Any
subscription with a signed agreement became undeletable with no usable error.

0002 replaces the rules with triggers that raise a real message, and moves the
`subscription_id` foreign key to `ON DELETE RESTRICT` so the constraint is
enforced honestly. Immutability is unchanged — it just fails legibly now.

## Two bugs the end-to-end run caught

Both were invisible to unit tests and would have reached production.

**Every recurring charge would have failed.** The cycle idempotency key was
`cycle-{uuid}-{iso date}` — 53 characters against Square's 45-character limit.
Square rejects it with `VALUE_TOO_LONG`, so the initial checkout would have
worked fine and then no client would ever have been billed again. Nothing short
of calling the real API surfaces this.

**The key was also keyed on the wrong things.** `(subscription, cycle date)`
alone breaks in two ways:

- If a plan change becomes effective while a cycle is being retried, the amount
  differs from the first attempt and Square rejects the charge with
  `IDEMPOTENCY_KEY_REUSED`. The subscription sticks at `past_due` and can never
  be billed for that cycle.
- An idempotency key is consumed by the *attempt*, not by its success. Reusing
  it the next day to retry a declined card returns the original failed payment
  rather than making a fresh attempt, so a recoverable decline never recovers.

The key now includes the attempt date and the amount, which fixes both while
preserving the guarantee it exists for: two runs on the same day, same cycle,
same price collapse to one charge. That is asserted explicitly in the harness —
both runs return the same Square payment id.
