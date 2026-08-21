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
| ClickUp provisioning | `POST /api/clickup/provision` | **verified against the live workspace** |

The whole chain has been run end to end against Square sandbox, the live Supabase
project and the live ClickUp workspace: **54/54 checks**, plus 18/18 unit tests.

It has also been driven by hand through the actual portal UI in a browser —
account creation, wizard, Terms, Square's real card iframe, checkout, success
screen, dashboard, and reload — against those same live services. The one step
no automation could perform is typing into Square's cross-origin PCI iframe;
that is verified through the API instead (`cnon:card-nonce-ok`), and the iframe
itself is confirmed to mount and render with the real Application ID.

Run the portal locally against real services with:

```bash
node --env-file=.env scripts/dev-server.mjs
```

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

## Email confirmation — resolved

"Confirm email" is **off**, so signup returns a session immediately and the
client goes straight into the wizard. Verified through the portal UI end to end.

If it is ever switched back on, configure custom SMTP at the same time (Resend
or Postmark). Supabase's built-in sender is rate-limited to a handful of messages
an hour and is not for production — with it, signup fails outright. The portal
handles both cases: with confirmation on it tells the client to confirm and sign
in rather than dropping them into a wizard they cannot check out from.

Custom SMTP is worth setting up regardless if checkout should ever send a
receipt, which the original handoff left undecided.

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

**ClickUp — corrected findings.** An earlier note here said dashboards were
entirely absent from the API. That is true only of *standalone* Dashboards.
Folder-scoped dashboard **views** can be both listed and created
(`GET`/`POST /folder/{id}/view` with `type: "dashboard"`), verified against this
workspace. Every real client folder has one named `<Client> Client Dashboard`;
neither template folder does. Provisioning now reuses a template-supplied
dashboard view if present and otherwise creates one, matching the convention.

What the API will *not* do is populate the dashboard's widgets — a created
dashboard view arrives empty. The cards have to be added once in the UI, or
carried across by a working folder template.

There is still no "duplicate this folder" endpoint; the API can only build from
a *saved Folder Template*.

Neither the folder nor the view API returns a URL, so the client-facing link is
**constructed**: `https://app.clickup.com/{team}/v/dsh/{viewId}`. That shape has
not been confirmed in a browser — open one from a client's dashboard and compare.
The raw view id is stored in `subscriptions.clickup_dashboard_view_id`, so if the
shape is wrong it is a single UPDATE to fix rather than a re-provision.

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

## Blocking issue: the ClickUp token cannot see the template folders

`CLICKUP_FOLDER_TEMPLATE_ID` is deliberately left unset, because the saved
template `t-901313605624` ("Client Folder Template") is rejected:

```
400 CTEMP_004 — "You would not have access to the folder created by this template"
```

The cause is a permission scope, not a bug. The personal token
(John's personal token) gets **401 Unauthorized** on all three template
folders:

| Folder | id | via personal token |
|---|---|---|
| Onboarding Templates | 901318711999 | 401 |
| Client 1 Template | 901313342105 | 401 |
| Client Template Folder | 901318206130 | 401 |

They are intact — confirmed still present through a differently-authenticated
client — just invisible to this token. The same restriction is what makes the
template unusable, since ClickUp refuses to build a folder the caller could not
then open.

To switch provisioning onto the template, share those folders with the token's
account in ClickUp (or issue a token whose scope includes them), confirm
`GET /folder/901318206130` returns 200, then set `CLICKUP_FOLDER_TEMPLATE_ID`.

Until then the fallback runs, and it works: it creates the folder and exactly
the lists the package path needs — `Onboarding` + `PostCast` for a Postcast
client, plus `SEO Optimization` when the Web Pod is on — matching how the real
Doba and SubBase folders are laid out. It just cannot carry across the template's
tasks or dashboard widgets.
