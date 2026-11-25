-- Eilat split storage. Lives in its own "eilat" schema so it never touches the host
-- project's public schema (Prisma-managed). Reads/writes go through public.eilat_* RPCs;
-- realtime streams changes from eilat.items.
create schema if not exists eilat;

create table if not exists eilat.items (
  kind text not null,
  id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (kind, id)
);
alter table eilat.items enable row level security;
grant usage on schema eilat to anon, authenticated;
grant select on eilat.items to anon, authenticated;
drop policy if exists "read for realtime" on eilat.items;
create policy "read for realtime" on eilat.items for select to anon, authenticated using (true);

do $$ begin
  alter publication supabase_realtime add table eilat.items;
exception when duplicate_object then null; end $$;

create or replace function public.eilat_list()
returns setof eilat.items language sql security definer set search_path = '' as $$
  select * from eilat.items
$$;

create or replace function public.eilat_put(p_kind text, p_id text, p_data jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into eilat.items (kind, id, data, updated_at) values (p_kind, p_id, p_data, now())
  on conflict (kind, id) do update set data = excluded.data, updated_at = now()
$$;

create or replace function public.eilat_del(p_kind text, p_id text)
returns void language sql security definer set search_path = '' as $$
  delete from eilat.items where kind = p_kind and id = p_id
$$;

grant execute on function public.eilat_list(), public.eilat_put(text, text, jsonb), public.eilat_del(text, text) to anon, authenticated;
