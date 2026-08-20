-- =====================================================================
-- LaunchPod Media Client Portal — initial schema
--
-- Money convention: every monetary column is INTEGER CENTS (USD).
-- The portal's PRICING constants are expressed in whole dollars and the
-- length multipliers produce fractional dollars (e.g. 12500 * 0.85), so
-- the server computes in dollars, then rounds ONCE to cents at the edge.
-- Never store dollars as float here.
-- =====================================================================

-- ---------------------------------------------------------------------
-- clients — auth-linked profile
-- ---------------------------------------------------------------------
create table public.clients (
  id           uuid primary key references auth.users(id) on delete cascade,
  name         text not null,
  company      text not null,
  email        text not null,
  billing_zip  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index clients_email_idx on public.clients (lower(email));

-- ---------------------------------------------------------------------
-- promo_codes — managed directly in the Supabase table editor (no UI)
--
-- discount_type 'percent' stores basis points in `amount` (1000 = 10.00%)
-- discount_type 'flat'    stores integer cents in `amount`
-- Basis points rather than numeric so percent math stays exact.
-- ---------------------------------------------------------------------
create type public.discount_type as enum ('percent', 'flat');

create table public.promo_codes (
  id            uuid primary key default gen_random_uuid(),
  code          text not null,
  discount_type public.discount_type not null,
  amount        integer not null check (amount > 0),
  active        boolean not null default true,
  expires_at    timestamptz,
  usage_cap     integer check (usage_cap is null or usage_cap > 0),
  times_used    integer not null default 0 check (times_used >= 0),
  notes         text,
  created_at    timestamptz not null default now(),
  -- percent codes may not exceed 100%
  constraint promo_percent_sane
    check (discount_type <> 'percent' or amount <= 10000)
);

-- Codes are matched case-insensitively; enforce uniqueness the same way.
create unique index promo_codes_code_key on public.promo_codes (lower(code));

-- ---------------------------------------------------------------------
-- subscriptions — the client's current package selection.
-- `selection` mirrors the shape of `state.pkg` in portal.html verbatim
-- (path, launch{}, orbit{}, pods{}, paymentPlan) so the portal can
-- rehydrate the wizard from it without a translation layer.
-- The scalar columns alongside it are denormalized for querying/billing;
-- `selection` stays the source of truth for what the client picked.
-- ---------------------------------------------------------------------
create type public.package_path    as enum ('launch', 'postcast', 'webicast', 'audit');
create type public.sub_status      as enum ('active', 'past_due', 'canceled', 'pending');

create table public.subscriptions (
  id                    uuid primary key default gen_random_uuid(),
  client_id             uuid not null references public.clients(id) on delete cascade,
  path                  public.package_path not null,
  selection             jsonb not null,
  status                public.sub_status not null default 'pending',

  -- Amounts locked in at checkout, in cents. Recomputed server-side at
  -- checkout from PRICING; never accepted from the client.
  charged_today_cents   integer not null check (charged_today_cents >= 0),
  recurring_cents       integer not null check (recurring_cents >= 0),

  -- Square
  square_customer_id    text,
  square_card_id        text,          -- card-on-file token
  square_payment_id     text,          -- the initial checkout payment

  -- Billing schedule
  billing_anchor        date,          -- day the recurring cycle starts
  next_charge_on        date,          -- advanced by /api/billing/charge-cycle
  last_charged_at       timestamptz,

  promo_code_id         uuid references public.promo_codes(id),

  -- ClickUp provisioning result
  clickup_folder_id     text,
  clickup_dashboard_url text,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index subscriptions_client_idx on public.subscriptions (client_id);
-- Drives the cron sweep: only active subs that are due.
create index subscriptions_due_idx
  on public.subscriptions (next_charge_on)
  where status = 'active';

-- ---------------------------------------------------------------------
-- plan_changes — pending upgrades/downgrades.
-- effective_at is set server-side to the start of the next production
-- cycle, minimum 30 days out, per the "Client-Managed Upgrades and
-- Downgrades" clause already live in the portal TOS. A plan change does
-- NOT bill at request time; charge-cycle applies it when it comes due.
-- ---------------------------------------------------------------------
create type public.plan_change_status as enum ('pending', 'applied', 'canceled');

create table public.plan_changes (
  id                  uuid primary key default gen_random_uuid(),
  subscription_id     uuid not null references public.subscriptions(id) on delete cascade,
  client_id           uuid not null references public.clients(id) on delete cascade,

  from_selection      jsonb not null,
  to_selection        jsonb not null,
  from_recurring_cents integer not null check (from_recurring_cents >= 0),
  to_recurring_cents   integer not null check (to_recurring_cents >= 0),

  status              public.plan_change_status not null default 'pending',
  requested_at        timestamptz not null default now(),
  effective_at        date not null,
  applied_at          timestamptz,

  constraint plan_change_min_notice check (effective_at > requested_at::date)
);

create index plan_changes_sub_idx on public.plan_changes (subscription_id);
-- At most one pending change per subscription; a new request supersedes
-- the old one (cancel the prior row first) rather than queueing.
create unique index plan_changes_one_pending
  on public.plan_changes (subscription_id)
  where status = 'pending';

-- ---------------------------------------------------------------------
-- tos_acceptances — the legal audit trail.
-- Stores the FULL rendered text the client actually saw (TOS content is
-- conditional on package path), not just a boolean. sha256 of that text
-- is stored alongside so tampering is detectable and identical documents
-- are cheap to compare.
-- ---------------------------------------------------------------------
create table public.tos_acceptances (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.clients(id) on delete restrict,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  path            public.package_path not null,
  document_text   text not null,
  document_sha256 text not null,
  document_rev    text not null,   -- e.g. '2026-07-28' from the portal header
  accepted_at     timestamptz not null default now(),
  ip_address      inet,
  user_agent      text
);

create index tos_acceptances_client_idx on public.tos_acceptances (client_id);

-- Acceptances are an immutable legal record: no updates, no deletes.
-- NOTE: these rules are REPLACED by triggers in 0002 — they broke
-- Postgres's own foreign-key maintenance. Kept here as applied history.
create rule tos_acceptances_no_update as
  on update to public.tos_acceptances do instead nothing;
create rule tos_acceptances_no_delete as
  on delete to public.tos_acceptances do instead nothing;

-- ---------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger clients_touch
  before update on public.clients
  for each row execute function public.touch_updated_at();

create trigger subscriptions_touch
  before update on public.subscriptions
  for each row execute function public.touch_updated_at();

-- =====================================================================
-- ROW LEVEL SECURITY
--
-- Every table is deny-by-default. Clients may read their own rows and
-- may not write billing-relevant columns at all — all writes that move
-- money or record consent happen in /api functions under service_role,
-- which bypasses RLS.
-- =====================================================================
alter table public.clients        enable row level security;
alter table public.subscriptions  enable row level security;
alter table public.plan_changes   enable row level security;
alter table public.tos_acceptances enable row level security;
alter table public.promo_codes    enable row level security;

-- clients: read + update own profile. Insert is done by /api on signup.
create policy clients_select_own on public.clients
  for select to authenticated using (id = (select auth.uid()));

create policy clients_update_own on public.clients
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- subscriptions: read-only to the client. All writes go through /api.
create policy subscriptions_select_own on public.subscriptions
  for select to authenticated using (client_id = (select auth.uid()));

-- plan_changes: read-only to the client. Requests go through
-- /api/plan-change so effective_at can be computed server-side.
create policy plan_changes_select_own on public.plan_changes
  for select to authenticated using (client_id = (select auth.uid()));

-- tos_acceptances: the client may read what they signed, nothing more.
create policy tos_acceptances_select_own on public.tos_acceptances
  for select to authenticated using (client_id = (select auth.uid()));

-- promo_codes: NO policies. Deny-by-default means anon and authenticated
-- cannot read the table at all — codes are validated only in /api/checkout
-- under service_role. This is deliberate: a readable promo table lets
-- anyone enumerate every active discount.

-- =====================================================================
-- redeem_promo_code — validate and consume a code atomically.
--
-- Checking the cap and then incrementing in two statements races: two
-- concurrent checkouts both read times_used = cap-1 and both succeed.
-- The UPDATE ... WHERE guard makes the check and the increment a single
-- atomic statement, so exactly one of them wins.
--
-- Returns the code's discount shape on success, or NULL if the code is
-- unknown, inactive, expired, or exhausted. Callers must treat NULL as
-- "no discount" and surface a rejection.
-- =====================================================================
create or replace function public.redeem_promo_code(p_code text)
returns table (id uuid, discount_type public.discount_type, amount integer)
language sql
security definer
set search_path = ''
as $$
  update public.promo_codes pc
     set times_used = pc.times_used + 1
   where lower(pc.code) = lower(trim(p_code))
     and pc.active
     and (pc.expires_at is null or pc.expires_at > now())
     and (pc.usage_cap is null or pc.times_used < pc.usage_cap)
  returning pc.id, pc.discount_type, pc.amount;
$$;

-- Only service_role (i.e. /api) may redeem. Revoke the default grant so
-- an authenticated client cannot burn codes or probe which ones exist.
revoke all on function public.redeem_promo_code(text) from public, anon, authenticated;
grant execute on function public.redeem_promo_code(text) to service_role;

-- Releases a code if checkout fails after redemption (e.g. the card is
-- declined), so a failed attempt doesn't consume a capped code.
create or replace function public.release_promo_code(p_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.promo_codes
     set times_used = greatest(times_used - 1, 0)
   where id = p_id;
$$;

revoke all on function public.release_promo_code(uuid) from public, anon, authenticated;
grant execute on function public.release_promo_code(uuid) to service_role;

-- =====================================================================
-- peek_promo_code — validate WITHOUT consuming.
--
-- Backs the portal's "apply code" button so the on-screen preview agrees
-- with what checkout will actually do. Deliberately separate from
-- redeem_promo_code: previewing a code must not burn a usage against its
-- cap. Returns the code's shape, or nothing if it is unusable.
-- =====================================================================
create or replace function public.peek_promo_code(p_code text)
returns table (code text, discount_type public.discount_type, amount integer)
language sql
stable
security definer
set search_path = ''
as $$
  select pc.code, pc.discount_type, pc.amount
    from public.promo_codes pc
   where lower(pc.code) = lower(trim(p_code))
     and pc.active
     and (pc.expires_at is null or pc.expires_at > now())
     and (pc.usage_cap is null or pc.times_used < pc.usage_cap)
   limit 1;
$$;

-- Still service_role only. Exposing this to `authenticated` would let a
-- signed-in client brute-force the code space.
revoke all on function public.peek_promo_code(text) from public, anon, authenticated;
grant execute on function public.peek_promo_code(text) to service_role;
