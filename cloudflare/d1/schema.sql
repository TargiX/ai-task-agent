create table if not exists agent_workspaces (
  id text primary key,
  name text not null,
  current_run_id text,
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now'))
);

create table if not exists agent_runs (
  id text primary key,
  workspace_id text not null references agent_workspaces(id) on delete cascade,
  idea text not null,
  status text not null default 'planned',
  graph text not null default '[]',
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now'))
);

create table if not exists agent_prds (
  id text primary key,
  run_id text not null references agent_runs(id) on delete cascade,
  title text not null,
  problem text not null,
  audience text not null,
  goals text not null default '[]',
  scope text not null default '[]',
  context text not null default '[]',
  source_idea text,
  generated_by text not null,
  model text,
  validation text not null default '[]',
  created_at text not null default (datetime('now'))
);

create table if not exists agent_tasks (
  id text primary key,
  run_id text not null references agent_runs(id) on delete cascade,
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
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now')),
  unique (run_id, public_id)
);

create table if not exists agent_tool_calls (
  id text primary key,
  run_id text not null references agent_runs(id) on delete cascade,
  type text not null,
  label text not null,
  detail text not null,
  created_at text not null default (datetime('now'))
);

create table if not exists agent_exports (
  id text primary key,
  run_id text not null references agent_runs(id) on delete cascade,
  target text not null check (target in ('Linear', 'GitHub')),
  status text not null,
  payload text not null default '[]',
  delivery text,
  created_at text not null default (datetime('now'))
);

create index if not exists agent_runs_workspace_created_idx
  on agent_runs(workspace_id, created_at desc);

create index if not exists agent_tasks_run_position_idx
  on agent_tasks(run_id, position);

create index if not exists agent_tool_calls_run_created_idx
  on agent_tool_calls(run_id, created_at desc);

create index if not exists agent_exports_run_created_idx
  on agent_exports(run_id, created_at desc);
