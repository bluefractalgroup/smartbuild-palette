-- Open access: no sign-in. Anyone using the app (with its public key) can read,
-- save, export and delete palettes. Rows no longer belong to a signed-in user.

alter table public.palettes alter column owner drop not null;
alter table public.palette_colors alter column owner drop not null;

drop policy if exists "Own palettes" on public.palettes;
drop policy if exists "Own palette colors" on public.palette_colors;
drop policy if exists "Team palettes" on public.palettes;
drop policy if exists "Team palette colors" on public.palette_colors;
drop policy if exists "Open palettes" on public.palettes;
drop policy if exists "Open palette colors" on public.palette_colors;

create policy "Open palettes" on public.palettes
  for all to anon, authenticated
  using (true) with check (true);

create policy "Open palette colors" on public.palette_colors
  for all to anon, authenticated
  using (true) with check (true);
