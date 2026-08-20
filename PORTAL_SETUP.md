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
| Checkout | `POST /api/checkout` | done, **untested against Square** |
| Recurring billing | `GET /api/billing/charge-cycle` (daily cron) | done, **untested against Square** |
| Plan changes | `POST /api/plan-change` | done |
| ClickUp provisioning | `POST /api/clickup/provision` | done, **untested against ClickUp** |

The three "untested" rows need live credentials — see *Still needed* below.

## Setup

1. **Create the Supabase project** (`lpm-portal`, separate from PropDoc's).
   Apply `supabase/migrations/0001_portal_init.sql`.

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
  template in the ClickUp UI. Set `CLICKUP_FOLDER_TEMPLATE_ID` once it is; until
  then provisioning builds the folder and only the lists the package path needs.
- Dashboards aren't in the public API at all. `clickup_dashboard_url` currently
  holds the client's **folder** URL, which is the closest shareable equivalent.

**TOS acceptances are immutable.** Database rules block UPDATE and DELETE. The
full rendered text is stored, not a boolean — including the "pending Michael's
confirmation" disclaimers, since those were part of what the client was shown.
That flag is still in the UI and stays until you say otherwise.
