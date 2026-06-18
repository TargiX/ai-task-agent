create table if not exists public.agent_workspaces (
  id uuid primary key,
  name text not null,
  current_run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.agent_runs (
  id uuid primary key,
  workspace_id uuid not null references public.agent_workspaces(id) on delete cascade,
  idea text not null,
  status text not null default 'planned',
  graph jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.agent_workspaces
  add constraint agent_workspaces_current_run_id_fkey
  foreign key (current_run_id)
  references public.agent_runs(id)
  on delete set null;

create table if not exists public.agent_prds (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  title text not null,
  problem text not null,
  audience text not null,
  goals jsonb not null default '[]'::jsonb,
  scope jsonb not null default '[]'::jsonb,
  source_idea text,
  generated_by text not null,
  model text,
  context jsonb not null default '[]'::jsonb,
  validation jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.agent_prds
  add column if not exists context jsonb not null default '[]'::jsonb;

alter table public.agent_prds
  add column if not exists validation jsonb not null default '[]'::jsonb;

create table if not exists public.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  public_id text not null,
  title text not null,
  owner text not null,
  priority text not null check (priority in ('High', 'Medium', 'Low')),
  effort text not null,
  acceptance text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  review_note text,
  source text,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, public_id)
);

create table if not exists public.agent_tool_calls (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  type text not null,
  label text not null,
  detail text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.agent_exports (
  id text primary key,
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  target text not null check (target in ('Linear', 'GitHub')),
  status text not null,
  payload jsonb not null default '[]'::jsonb,
  delivery jsonb,
  created_at timestamptz not null default now()
);

create index if not exists agent_runs_workspace_created_idx
  on public.agent_runs(workspace_id, created_at desc);

create index if not exists agent_tasks_run_position_idx
  on public.agent_tasks(run_id, position);

create index if not exists agent_tool_calls_run_created_idx
  on public.agent_tool_calls(run_id, created_at desc);

create index if not exists agent_exports_run_created_idx
  on public.agent_exports(run_id, created_at desc);

alter table public.agent_workspaces enable row level security;
alter table public.agent_runs enable row level security;
alter table public.agent_prds enable row level security;
alter table public.agent_tasks enable row level security;
alter table public.agent_tool_calls enable row level security;
alter table public.agent_exports enable row level security;

create policy "demo_agent_workspaces_all"
  on public.agent_workspaces
  for all
  using (true)
  with check (true);

create policy "demo_agent_runs_all"
  on public.agent_runs
  for all
  using (true)
  with check (true);

create policy "demo_agent_prds_all"
  on public.agent_prds
  for all
  using (true)
  with check (true);

create policy "demo_agent_tasks_all"
  on public.agent_tasks
  for all
  using (true)
  with check (true);

create policy "demo_agent_tool_calls_all"
  on public.agent_tool_calls
  for all
  using (true)
  with check (true);

create policy "demo_agent_exports_all"
  on public.agent_exports
  for all
  using (true)
  with check (true);
