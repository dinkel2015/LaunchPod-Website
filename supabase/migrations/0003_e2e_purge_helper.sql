-- =====================================================================
-- e2e_purge_client — remove a TEST client and everything attached to it.
--
-- tos_acceptances is immutable by trigger and its FK is RESTRICT, so a
-- test run cannot clean up after itself through the normal API. This
-- lifts the trigger for the duration of one delete.
--
-- Deliberately NOT a general-purpose purge: it refuses any client whose
-- email is not an e2e harness address. A blanket "delete this client's
-- records" function would quietly undo the audit-trail guarantee the
-- immutability trigger exists to provide, and would look sanctioned
-- sitting in the schema. Blast radius is bounded to test accounts.
-- =====================================================================
create or replace function public.e2e_purge_client(p_client uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
begin
  select email into v_email from auth.users where id = p_client;

  if v_email is null then
    return;
  end if;

  if v_email !~ '^e2e-[0-9]+@launchpodmedia\.com$' then
    raise exception 'e2e_purge_client refuses non-test client % (%)', p_client, v_email
      using errcode = 'restrict_violation',
            hint = 'This helper only removes e2e-<timestamp>@launchpodmedia.com accounts.';
  end if;

  alter table public.tos_acceptances disable trigger tos_acceptances_no_delete;
  delete from public.tos_acceptances where client_id = p_client;
  alter table public.tos_acceptances enable trigger tos_acceptances_no_delete;

  delete from public.plan_changes  where client_id = p_client;
  delete from public.subscriptions where client_id = p_client;
  delete from public.clients       where id = p_client;
end;
$$;

revoke all on function public.e2e_purge_client(uuid) from public, anon, authenticated;
grant execute on function public.e2e_purge_client(uuid) to service_role;
