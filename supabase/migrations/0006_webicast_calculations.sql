-- One row per press of Calculate on the Webicast page's cost/value
-- calculator. Anonymous: no name, email, or IP. Written only by
-- /api/webicast-calc through the service role; RLS is on with no
-- policies, so the anon and authenticated keys can neither read nor write.
create table public.webicast_calculations (
  id                 bigint generated always as identity primary key,
  created_at         timestamptz not null default now(),
  visitor_id         text,
  webinar_minutes    integer not null check (webinar_minutes between 1 and 600),
  webinars_per_month integer not null check (webinars_per_month between 1 and 31),
  release_cadence    text    not null check (release_cadence in ('biweekly', 'weekly', 'twice')),
  registrants        integer,
  lead_value         integer,
  episodes_per_month integer,
  quoted_price       integer,
  is_custom          boolean not null default false,
  break_even_leads   integer,
  page_path          text,
  referrer           text,
  user_agent         text
);

alter table public.webicast_calculations enable row level security;

create index webicast_calculations_created_at_idx on public.webicast_calculations (created_at desc);
create index webicast_calculations_visitor_idx on public.webicast_calculations (visitor_id);

comment on table public.webicast_calculations is
  'Anonymous usage of the Webicast page calculator. Service-role writes only.';
