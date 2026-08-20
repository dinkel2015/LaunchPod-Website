-- The ClickUp API returns no URL for a folder or a view, so the portal
-- has to construct one. Storing the raw view id alongside the URL means
-- a wrong URL format can be corrected with a single UPDATE instead of
-- re-provisioning every client's ClickUp workspace.
alter table public.subscriptions
  add column clickup_dashboard_view_id text;

comment on column public.subscriptions.clickup_dashboard_view_id is
  'ClickUp folder-scoped dashboard VIEW id (e.g. 2ky4mf0h-9273). The URL in clickup_dashboard_url is derived from it.';

comment on column public.subscriptions.clickup_dashboard_url is
  'Constructed client-facing ClickUp URL. Not returned by the API — derived from clickup_dashboard_view_id, or the folder id when no dashboard view exists.';
