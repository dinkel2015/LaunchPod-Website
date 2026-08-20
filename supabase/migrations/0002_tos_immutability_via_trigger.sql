-- =====================================================================
-- Replace the DO INSTEAD NOTHING rules on tos_acceptances with a trigger.
--
-- Two problems with the rules:
--
-- 1. A rule rewrites the statement, which also rewrites the statements
--    Postgres issues internally to maintain foreign keys. Deleting a
--    subscription fires ON DELETE SET NULL against tos_acceptances, the
--    rule swallows it, and the FK check fails with an opaque
--    "referential integrity query ... gave unexpected result" (XX000).
--    That made any subscription with an acceptance undeletable, with no
--    usable error message.
--
-- 2. DO INSTEAD NOTHING is silent. An admin running a DELETE sees
--    "DELETE 0" and concludes nothing matched, rather than learning the
--    row is protected.
--
-- A trigger raises a real error, and leaves FK maintenance alone.
-- The subscription_id FK moves to RESTRICT so the relationship is
-- enforced honestly: a subscription carrying a signed agreement cannot
-- be deleted, and says so.
-- =====================================================================

drop rule if exists tos_acceptances_no_update on public.tos_acceptances;
drop rule if exists tos_acceptances_no_delete on public.tos_acceptances;

create or replace function public.tos_acceptances_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'tos_acceptances is an immutable legal record; % is not permitted (row %)',
    tg_op, coalesce(old.id::text, '?')
    using errcode = 'restrict_violation',
          hint = 'Signed agreements are an audit trail. Insert a new acceptance instead.';
end;
$$;

create trigger tos_acceptances_no_update
  before update on public.tos_acceptances
  for each row execute function public.tos_acceptances_immutable();

create trigger tos_acceptances_no_delete
  before delete on public.tos_acceptances
  for each row execute function public.tos_acceptances_immutable();

-- ON DELETE SET NULL would need to modify a protected row; RESTRICT
-- refuses the parent delete cleanly instead.
alter table public.tos_acceptances
  drop constraint tos_acceptances_subscription_id_fkey;

alter table public.tos_acceptances
  add constraint tos_acceptances_subscription_id_fkey
  foreign key (subscription_id) references public.subscriptions(id)
  on delete restrict;
