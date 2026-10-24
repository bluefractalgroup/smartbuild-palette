-- Team sharing: every signed-in team member can see and edit every palette.
-- "Team" means an email address on one of the domains below.

create table if not exists public.team_domains (
  domain text primary key
);

insert into public.team_domains (domain) values
  ('smartbuildsystems.com'),
  ('bluefractalgroup.com')
on conflict do nothing;

-- No policies: the table is only read through is_team_member() below.
alter table public.team_domains enable row level security;

create or replace function public.is_team_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.team_domains
    where domain = lower(split_part(auth.jwt() ->> 'email', '@', 2))
  );
$$;

-- Who saved last, shown in the palette list and used to avoid overwriting
-- someone else's newer changes.
alter table public.palettes add column if not exists updated_by text;

drop policy if exists "Own palettes" on public.palettes;
drop policy if exists "Own palette colors" on public.palette_colors;
drop policy if exists "Team palettes" on public.palettes;
drop policy if exists "Team palette colors" on public.palette_colors;

create policy "Team palettes" on public.palettes
  for all to authenticated
  using (public.is_team_member())
  with check (public.is_team_member());

create policy "Team palette colors" on public.palette_colors
  for all to authenticated
  using (public.is_team_member())
  with check (public.is_team_member());
