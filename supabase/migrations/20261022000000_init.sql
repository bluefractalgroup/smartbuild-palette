-- SmartBuild Color Palette: palettes and the exported colors (with their codes).
-- Every row belongs to the signed-in user who made it.

create table if not exists public.palettes (
  id uuid primary key,
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null default 'Untitled palette',
  -- Working state: charts, measured chips, selections and edits.
  doc jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists palettes_owner_updated on public.palettes (owner, updated_at desc);

-- Final rows as exported to SmartBuild. Later onboarding steps (metal and trim
-- parts) look up color codes here.
create table if not exists public.palette_colors (
  id bigint generated always as identity primary key,
  palette_id uuid not null references public.palettes (id) on delete cascade,
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  position int not null,
  color_name text not null,
  hex_code text not null check (hex_code ~ '^#[0-9A-F]{6}$'),
  color_code text not null,
  description text not null default '',
  preferred_manufacturer text not null default '',
  serial_number text not null default '',
  all_available_manufacturers text[] not null default '{}',
  textured boolean not null default false,
  exported_at timestamptz not null default now(),
  unique (palette_id, color_code)
);

alter table public.palettes enable row level security;
alter table public.palette_colors enable row level security;

create policy "Own palettes" on public.palettes
  for all using (owner = auth.uid()) with check (owner = auth.uid());

create policy "Own palette colors" on public.palette_colors
  for all using (owner = auth.uid()) with check (owner = auth.uid());
