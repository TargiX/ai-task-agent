import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { DEFAULT_WORKSPACE_ID, initialWorkspace, providerStatus } from './domain.js';
import { normalizeWorkspaceId, workspaceDisplayName } from './workspace-context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_DB_FILE = path.join(process.env.VERCEL ? os.tmpdir() : DB_DIR, 'task-agent-db.json');
let jsonStorageQueue = Promise.resolve();
const D1_SCHEMA = [
  "create table if not exists agent_workspaces (id text primary key, name text not null, current_run_id text, created_at text not null default (datetime('now')), updated_at text not null default (datetime('now')))",
  "create table if not exists agent_runs (id text primary key, workspace_id text not null references agent_workspaces(id) on delete cascade, idea text not null, status text not null default 'planned', graph text not null default '[]', created_at text not null default (datetime('now')), updated_at text not null default (datetime('now')))",
  "create table if not exists agent_prds (id text primary key, run_id text not null references agent_runs(id) on delete cascade, title text not null, problem text not null, audience text not null, goals text not null default '[]', scope text not null default '[]', context text not null default '[]', source_idea text, generated_by text not null, model text, validation text not null default '[]', created_at text not null default (datetime('now')))",
  "create table if not exists agent_tasks (id text primary key, run_id text not null references agent_runs(id) on delete cascade, public_id text not null, title text not null, owner text not null, priority text not null check (priority in ('High', 'Medium', 'Low')), effort text not null, acceptance text not null, status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')), review_note text, source text, position integer not null default 0, created_at text not null default (datetime('now')), updated_at text not null default (datetime('now')), unique (run_id, public_id))",
  "create table if not exists agent_tool_calls (id text primary key, run_id text not null references agent_runs(id) on delete cascade, type text not null, label text not null, detail text not null, created_at text not null default (datetime('now')))",
  "create table if not exists agent_exports (id text primary key, run_id text not null references agent_runs(id) on delete cascade, target text not null check (target in ('Linear', 'GitHub')), status text not null, payload text not null default '[]', delivery text, created_at text not null default (datetime('now')))",
  'create index if not exists agent_runs_workspace_created_idx on agent_runs(workspace_id, created_at desc)',
  'create index if not exists agent_tasks_run_position_idx on agent_tasks(run_id, position)',
  'create index if not exists agent_tool_calls_run_created_idx on agent_tool_calls(run_id, created_at desc)',
  'create index if not exists agent_exports_run_created_idx on agent_exports(run_id, created_at desc)',
];

export function getStorage(workspaceId = DEFAULT_WORKSPACE_ID) {
  const activeWorkspaceId = normalizeWorkspaceId(workspaceId);
  if (
    process.env.CLOUDFLARE_ACCOUNT_ID &&
    process.env.CLOUDFLARE_D1_DATABASE_ID &&
    process.env.CLOUDFLARE_API_TOKEN
  ) {
    return d1Storage(activeWorkspaceId);
  }
  if (
    process.env.SUPABASE_URL &&
    (process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_PUBLISHABLE_KEY ||
      process.env.SUPABASE_ANON_KEY)
  ) {
    return supabaseStorage(activeWorkspaceId);
  }
  return jsonStorage(activeWorkspaceId);
}

function withProvider(workspace, workspaceId = DEFAULT_WORKSPACE_ID) {
  return {
    ...workspace,
    workspace: {
      id: workspaceId,
      label: workspaceDisplayName(workspaceId),
    },
    provider: providerStatus(),
  };
}

function jsonStorage(workspaceId = DEFAULT_WORKSPACE_ID) {
  function dbFile() {
    return workspaceDbFile(process.env.TASK_AGENT_DB_FILE || DEFAULT_DB_FILE, workspaceId);
  }

  function dbDir() {
    return path.dirname(dbFile());
  }

  async function ensureDbRaw() {
    await fs.mkdir(dbDir(), { recursive: true });
    try {
      await fs.access(dbFile());
    } catch {
      await writeDbRaw(initialWorkspace());
    }
  }

  async function readDbRaw() {
    await ensureDbRaw();
    const body = await fs.readFile(dbFile(), 'utf8');
    try {
      return JSON.parse(body);
    } catch (error) {
      if (error instanceof SyntaxError) {
        const corruptPath = `${dbFile()}.corrupt-${Date.now()}`;
        await fs.rename(dbFile(), corruptPath).catch(() => {});
        const next = initialWorkspace();
        await writeDbRaw(next);
        return next;
      }
      throw error;
    }
  }

  async function writeDbRaw(db) {
    await fs.mkdir(dbDir(), { recursive: true });
    const tmpFile = `${dbFile()}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tmpFile, `${JSON.stringify(db, null, 2)}\n`);
    await fs.rename(tmpFile, dbFile());
  }

  function withJsonLock(task) {
    const job = jsonStorageQueue.then(task, task);
    jsonStorageQueue = job.catch(() => {});
    return job;
  }

  return {
    async getWorkspace() {
      return withJsonLock(async () => {
        const db = normalizeJsonDb(await readDbRaw());
        await writeDbRaw(db);
        return withProvider(currentJsonWorkspace(db), workspaceId);
      });
    },
    async resetWorkspace() {
      return withJsonLock(async () => {
        const db = normalizeJsonDb(await readDbRaw());
        const next = {
          ...initialWorkspace(),
          runs: db.runs,
          currentRunId: null,
        };
        await writeDbRaw(next);
        return withProvider(currentJsonWorkspace(next), workspaceId);
      });
    },
    async listRuns() {
      return withJsonLock(async () => {
        const db = normalizeJsonDb(await readDbRaw());
        await writeDbRaw(db);
        return jsonRunSummaries(db);
      });
    },
    async selectRun(runId) {
      return withJsonLock(async () => {
        const db = normalizeJsonDb(await readDbRaw());
        if (!db.runs.some((run) => run.runId === runId)) {
          throw new Error('Run not found.');
        }
        const selected = { ...db, currentRunId: runId };
        await writeDbRaw(selected);
        return withProvider(currentJsonWorkspace(selected), workspaceId);
      });
    },
    async saveRun({ idea, prd, tasks, graph, logs }) {
      return withJsonLock(async () => {
        const db = normalizeJsonDb(await readDbRaw());
        const runId = crypto.randomUUID();
        const now = new Date().toISOString();
        const run = {
          runId,
          idea,
          prd,
          tasks,
          graph,
          exports: [],
          logs: [...logs, ...initialWorkspace().logs],
          createdAt: now,
          updatedAt: now,
        };
        const next = {
          ...db,
          ...run,
          currentRunId: runId,
          runs: [run, ...db.runs.filter((existing) => existing.runId !== runId)].slice(0, 30),
        };
        await writeDbRaw(next);
        return withProvider(currentJsonWorkspace(next), workspaceId);
      });
    },
    async patchTask(taskId, patch, graph, log) {
      return withJsonLock(async () => {
        const db = normalizeJsonDb(await readDbRaw());
        const current = currentJsonWorkspace(db);
        const runId = current.runId;
        if (!runId) throw new Error('No active run.');
        const updatedRun = {
          ...current,
          tasks: current.tasks.map((task) => {
            if (task.id !== taskId) return task;
            return { ...task, ...patch, updatedAt: new Date().toISOString() };
          }),
          graph,
          logs: [log, ...current.logs],
          updatedAt: new Date().toISOString(),
        };
        const next = updateJsonRun(db, updatedRun);
        await writeDbRaw(next);
        return withProvider(currentJsonWorkspace(next), workspaceId);
      });
    },
    async patchTasks(taskIds, patch, graph, log) {
      return withJsonLock(async () => {
        const ids = new Set(taskIds);
        const db = normalizeJsonDb(await readDbRaw());
        const current = currentJsonWorkspace(db);
        const runId = current.runId;
        if (!runId) throw new Error('No active run.');
        const now = new Date().toISOString();
        const updatedRun = {
          ...current,
          tasks: current.tasks.map((task) => {
            if (!ids.has(task.id)) return task;
            return { ...task, ...patch, updatedAt: now };
          }),
          graph,
          logs: [log, ...current.logs],
          updatedAt: now,
        };
        const next = updateJsonRun(db, updatedRun);
        await writeDbRaw(next);
        return withProvider(currentJsonWorkspace(next), workspaceId);
      });
    },
    async createExport(exportRecord, graph, log) {
      return withJsonLock(async () => {
        const db = normalizeJsonDb(await readDbRaw());
        const current = currentJsonWorkspace(db);
        const runId = current.runId;
        if (!runId) throw new Error('No active run.');
        const updatedRun = {
          ...current,
          graph,
          exports: [exportRecord, ...current.exports],
          logs: [log, ...current.logs],
          updatedAt: new Date().toISOString(),
        };
        const next = updateJsonRun(db, updatedRun);
        await writeDbRaw(next);
        return withProvider(currentJsonWorkspace(next), workspaceId);
      });
    },
  };
}

function workspaceDbFile(baseFile, workspaceId) {
  if (workspaceId === DEFAULT_WORKSPACE_ID) return baseFile;
  const parsed = path.parse(baseFile);
  const extension = parsed.ext || '.json';
  return path.join(parsed.dir, `${parsed.name}.${workspaceId}${extension}`);
}

function normalizeJsonDb(db) {
  const runs = Array.isArray(db.runs) ? db.runs : [];
  if (runs.length) {
    return {
      ...initialWorkspace(),
      ...db,
      runs: runs.map(normalizeJsonRun),
      currentRunId: db.currentRunId || db.runId || runs[0]?.runId || null,
    };
  }
  if (db.prd || db.tasks?.length || db.idea) {
    const runId = db.runId || crypto.randomUUID();
    const run = normalizeJsonRun({
      runId,
      idea: db.idea || '',
      prd: db.prd || null,
      tasks: db.tasks || [],
      graph: db.graph || graphFallbackFromDb(db),
      logs: db.logs || [],
      exports: db.exports || [],
      createdAt: db.createdAt || db.logs?.at(-1)?.createdAt || new Date().toISOString(),
      updatedAt: db.updatedAt || db.logs?.[0]?.createdAt || new Date().toISOString(),
    });
    return {
      ...db,
      ...run,
      runs: [run],
      currentRunId: runId,
    };
  }
  return {
    ...initialWorkspace(),
    ...db,
    runs,
    currentRunId: null,
  };
}

function normalizeJsonRun(run) {
  return {
    runId: run.runId || run.id || crypto.randomUUID(),
    idea: run.idea || '',
    prd: run.prd || null,
    tasks: run.tasks || [],
    graph: run.graph || initialWorkspace().graph,
    logs: run.logs || [],
    exports: run.exports || [],
    createdAt: run.createdAt || new Date().toISOString(),
    updatedAt: run.updatedAt || run.createdAt || new Date().toISOString(),
  };
}

function currentJsonWorkspace(db) {
  const current = db.currentRunId ? db.runs.find((run) => run.runId === db.currentRunId) : null;
  const workspace = current || initialWorkspace();
  return {
    ...workspace,
    runHistory: jsonRunSummaries(db),
  };
}

function updateJsonRun(db, run) {
  const normalized = normalizeJsonRun(run);
  return {
    ...db,
    ...normalized,
    currentRunId: normalized.runId,
    runs: [normalized, ...db.runs.filter((existing) => existing.runId !== normalized.runId)].slice(0, 30),
  };
}

function jsonRunSummaries(db) {
  return db.runs.map((run) => runSummaryFromWorkspace(run));
}

function runSummaryFromWorkspace(run) {
  return {
    runId: run.runId,
    title: run.prd?.title || 'Untitled run',
    idea: run.idea || '',
    status: run.graph?.at(-1)?.status === 'done' ? 'exported' : run.tasks?.some((task) => task.status === 'approved') ? 'approved' : 'planned',
    taskCount: run.tasks?.length || 0,
    approvedCount: run.tasks?.filter((task) => task.status === 'approved').length || 0,
    rejectedCount: run.tasks?.filter((task) => task.status === 'rejected').length || 0,
    exportCount: run.exports?.length || 0,
    createdAt: run.createdAt || null,
    updatedAt: run.updatedAt || run.createdAt || null,
  };
}

function graphFallbackFromDb(db) {
  return db.graph || initialWorkspace().graph;
}

function d1Storage(workspaceId = DEFAULT_WORKSPACE_ID) {
  let schemaReady = false;

  async function ensureSchema() {
    if (schemaReady) return;
    for (const sql of D1_SCHEMA) {
      await d1Query(sql);
    }
    schemaReady = true;
  }

  async function ensureWorkspace() {
    await ensureSchema();
    await d1Query(
      'insert into agent_workspaces (id, name, updated_at) values (?, ?, ?) on conflict(id) do nothing',
      [workspaceId, workspaceDisplayName(workspaceId), new Date().toISOString()],
    );
  }

  async function currentRunId() {
    await ensureWorkspace();
    const rows = await d1Rows('select current_run_id from agent_workspaces where id = ? limit 1', [
      workspaceId,
    ]);
    return rows[0]?.current_run_id || null;
  }

  async function loadRun(runId) {
    if (!runId) return { ...initialWorkspace(), runHistory: await listRuns() };
    const [run] = await d1Rows('select * from agent_runs where id = ? and workspace_id = ? limit 1', [
      runId,
      workspaceId,
    ]);
    if (!run) return { ...initialWorkspace(), runHistory: await listRuns() };
    const [prd] = await d1Rows('select * from agent_prds where run_id = ? limit 1', [runId]);
    const tasks = await d1Rows('select * from agent_tasks where run_id = ? order by position asc', [runId]);
    const logs = await d1Rows('select * from agent_tool_calls where run_id = ? order by created_at desc', [runId]);
    const exports = await d1Rows('select * from agent_exports where run_id = ? order by created_at desc', [runId]);

    return {
      runId: run.id,
      idea: run.idea,
      prd: prd
        ? {
            title: prd.title,
            problem: prd.problem,
            audience: prd.audience,
            goals: parseJson(prd.goals, []),
            scope: parseJson(prd.scope, []),
            context: parseJson(prd.context, []),
            sourceIdea: prd.source_idea,
            generatedBy: prd.generated_by,
            model: prd.model,
            validation: parseJson(prd.validation, []),
            checks: parseJson(prd.validation, []),
          }
        : null,
      tasks: tasks.map(fromTaskRow),
      graph: parseJson(run.graph, []),
      logs: logs.map((log) => ({
        id: log.id,
        type: log.type,
        label: log.label,
        detail: log.detail,
        createdAt: log.created_at,
      })),
      exports: exports.map((record) => ({
        id: record.id,
        target: record.target,
        status: record.status,
        payload: parseJson(record.payload, []),
        delivery: record.delivery ? parseJson(record.delivery, null) : null,
        createdAt: record.created_at,
      })),
      runHistory: await listRuns(),
    };
  }

  async function listRuns() {
    await ensureWorkspace();
    const rows = await d1Rows(
      `select
        r.id as run_id,
        r.idea,
        r.status,
        r.created_at,
        r.updated_at,
        p.title,
        (select count(*) from agent_tasks t where t.run_id = r.id) as task_count,
        (select count(*) from agent_tasks t where t.run_id = r.id and t.status = 'approved') as approved_count,
        (select count(*) from agent_tasks t where t.run_id = r.id and t.status = 'rejected') as rejected_count,
        (select count(*) from agent_exports e where e.run_id = r.id) as export_count
      from agent_runs r
      left join agent_prds p on p.run_id = r.id
      where r.workspace_id = ?
      order by r.created_at desc
      limit 30`,
      [workspaceId],
    );
    return rows.map(fromRunSummaryRow);
  }

  async function appendLog(runId, log) {
    await d1Query(
      'insert into agent_tool_calls (id, run_id, type, label, detail, created_at) values (?, ?, ?, ?, ?, ?)',
      [
        log.id || crypto.randomUUID(),
        runId,
        log.type,
        log.label,
        log.detail,
        log.createdAt || new Date().toISOString(),
      ],
    );
  }

  return {
    async getWorkspace() {
      return withProvider(await loadRun(await currentRunId()), workspaceId);
    },
    async resetWorkspace() {
      await ensureWorkspace();
      await d1Query('update agent_workspaces set current_run_id = null, updated_at = ? where id = ?', [
        new Date().toISOString(),
        workspaceId,
      ]);
      return withProvider({ ...initialWorkspace(), runHistory: await listRuns() }, workspaceId);
    },
    async listRuns() {
      return listRuns();
    },
    async selectRun(runId) {
      const [run] = await d1Rows('select id from agent_runs where id = ? and workspace_id = ? limit 1', [
        runId,
        workspaceId,
      ]);
      if (!run) throw new Error('Run not found.');
      await d1Query('update agent_workspaces set current_run_id = ?, updated_at = ? where id = ?', [
        runId,
        new Date().toISOString(),
        workspaceId,
      ]);
      return withProvider(await loadRun(runId), workspaceId);
    },
    async saveRun({ idea, prd, tasks, graph, logs }) {
      await ensureWorkspace();
      const runId = crypto.randomUUID();
      const now = new Date().toISOString();
      await d1Query(
        'insert into agent_runs (id, workspace_id, idea, status, graph, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)',
        [runId, workspaceId, idea, 'planned', JSON.stringify(graph), now, now],
      );
      await d1Query(
        'insert into agent_prds (id, run_id, title, problem, audience, goals, scope, context, source_idea, generated_by, model, validation, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          crypto.randomUUID(),
          runId,
          prd.title,
          prd.problem,
          prd.audience,
          JSON.stringify(prd.goals || []),
          JSON.stringify(prd.scope || []),
          JSON.stringify(prd.context || []),
          prd.sourceIdea || '',
          prd.generatedBy,
          prd.model || null,
          JSON.stringify(prd.validation || prd.checks || []),
          now,
        ],
      );
      for (const [index, task] of tasks.entries()) {
        await d1Query(
          'insert into agent_tasks (id, run_id, public_id, title, owner, priority, effort, acceptance, status, review_note, source, position, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            crypto.randomUUID(),
            runId,
            task.id,
            task.title,
            task.owner,
            task.priority,
            task.effort,
            task.acceptance,
            task.status,
            task.reviewNote || '',
            task.source,
            index,
            task.createdAt || now,
            task.updatedAt || now,
          ],
        );
      }
      for (const log of logs) {
        await appendLog(runId, log);
      }
      await d1Query('update agent_workspaces set current_run_id = ?, updated_at = ? where id = ?', [
        runId,
        now,
        workspaceId,
      ]);
      return withProvider(await loadRun(runId), workspaceId);
    },
    async patchTask(taskId, patch, graph, log) {
      const runId = await currentRunId();
      if (!runId) throw new Error('No active run.');
      await updateD1Task(runId, [taskId], patch);
      await d1Query('update agent_runs set graph = ?, updated_at = ? where id = ?', [
        JSON.stringify(graph),
        new Date().toISOString(),
        runId,
      ]);
      await appendLog(runId, log);
      return withProvider(await loadRun(runId), workspaceId);
    },
    async patchTasks(taskIds, patch, graph, log) {
      const runId = await currentRunId();
      if (!runId) throw new Error('No active run.');
      await updateD1Task(runId, taskIds, patch);
      await d1Query('update agent_runs set graph = ?, updated_at = ? where id = ?', [
        JSON.stringify(graph),
        new Date().toISOString(),
        runId,
      ]);
      await appendLog(runId, log);
      return withProvider(await loadRun(runId), workspaceId);
    },
    async createExport(exportRecord, graph, log) {
      const runId = await currentRunId();
      if (!runId) throw new Error('No active run.');
      const now = new Date().toISOString();
      await d1Query(
        'insert into agent_exports (id, run_id, target, status, payload, delivery, created_at) values (?, ?, ?, ?, ?, ?, ?)',
        [
          exportRecord.id,
          runId,
          exportRecord.target,
          exportRecord.status,
          JSON.stringify(exportRecord.payload || []),
          exportRecord.delivery ? JSON.stringify(exportRecord.delivery) : null,
          exportRecord.createdAt || now,
        ],
      );
      await d1Query('update agent_runs set graph = ?, updated_at = ? where id = ?', [
        JSON.stringify(graph),
        now,
        runId,
      ]);
      await appendLog(runId, log);
      return withProvider(await loadRun(runId), workspaceId);
    },
  };
}

function supabaseStorage(workspaceId = DEFAULT_WORKSPACE_ID) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_PUBLISHABLE_KEY ||
      process.env.SUPABASE_ANON_KEY,
    {
      auth: { persistSession: false },
    },
  );

  async function ensureWorkspace() {
    const { error } = await supabase
      .from('agent_workspaces')
      .upsert({ id: workspaceId, name: workspaceDisplayName(workspaceId) }, { onConflict: 'id' });
    if (error) throw error;
  }

  async function currentRunId() {
    await ensureWorkspace();
    const { data, error } = await supabase
      .from('agent_workspaces')
      .select('current_run_id')
      .eq('id', workspaceId)
      .single();
    if (error) throw error;
    return data?.current_run_id || null;
  }

  async function loadRun(runId) {
    if (!runId) return { ...initialWorkspace(), runHistory: await listRuns() };

    const [{ data: run, error: runError }, { data: prdRows, error: prdError }, { data: tasks, error: tasksError }, { data: logs, error: logsError }, { data: exports, error: exportsError }] =
      await Promise.all([
        supabase.from('agent_runs').select('*').eq('id', runId).eq('workspace_id', workspaceId).single(),
        supabase.from('agent_prds').select('*').eq('run_id', runId).limit(1),
        supabase.from('agent_tasks').select('*').eq('run_id', runId).order('position'),
        supabase.from('agent_tool_calls').select('*').eq('run_id', runId).order('created_at', { ascending: false }),
        supabase.from('agent_exports').select('*').eq('run_id', runId).order('created_at', { ascending: false }),
      ]);
    for (const error of [runError, prdError, tasksError, logsError, exportsError]) {
      if (error) throw error;
    }

    return {
      runId: run.id,
      idea: run.idea,
      prd: prdRows[0]
        ? {
            title: prdRows[0].title,
            problem: prdRows[0].problem,
            audience: prdRows[0].audience,
            goals: prdRows[0].goals,
            scope: prdRows[0].scope,
            sourceIdea: prdRows[0].source_idea,
            generatedBy: prdRows[0].generated_by,
            model: prdRows[0].model,
            context: prdRows[0].context || [],
            validation: prdRows[0].validation || [],
            checks: prdRows[0].validation || [],
          }
        : null,
      tasks: tasks.map(fromTaskRow),
      graph: run.graph,
      logs: logs.map((log) => ({
        id: log.id,
        type: log.type,
        label: log.label,
        detail: log.detail,
        createdAt: log.created_at,
      })),
      exports: exports.map((record) => ({
        id: record.id,
        target: record.target,
        status: record.status,
        payload: record.payload,
        delivery: record.delivery,
        createdAt: record.created_at,
      })),
      runHistory: await listRuns(),
    };
  }

  async function listRuns() {
    await ensureWorkspace();
    const { data: runs, error: runsError } = await supabase
      .from('agent_runs')
      .select('id, idea, status, created_at, updated_at')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(30);
    if (runsError) throw runsError;
    const runIds = runs.map((run) => run.id);
    if (!runIds.length) return [];

    const [
      { data: prds, error: prdsError },
      { data: tasks, error: tasksError },
      { data: exports, error: exportsError },
    ] = await Promise.all([
      supabase.from('agent_prds').select('run_id, title').in('run_id', runIds),
      supabase.from('agent_tasks').select('run_id, status').in('run_id', runIds),
      supabase.from('agent_exports').select('run_id').in('run_id', runIds),
    ]);
    for (const error of [prdsError, tasksError, exportsError]) {
      if (error) throw error;
    }

    return runs.map((run) => {
      const runTasks = tasks.filter((task) => task.run_id === run.id);
      return {
        runId: run.id,
        title: prds.find((prd) => prd.run_id === run.id)?.title || 'Untitled run',
        idea: run.idea,
        status: run.status,
        taskCount: runTasks.length,
        approvedCount: runTasks.filter((task) => task.status === 'approved').length,
        rejectedCount: runTasks.filter((task) => task.status === 'rejected').length,
        exportCount: exports.filter((record) => record.run_id === run.id).length,
        createdAt: run.created_at,
        updatedAt: run.updated_at,
      };
    });
  }

  return {
    async getWorkspace() {
      return withProvider(await loadRun(await currentRunId()), workspaceId);
    },
    async resetWorkspace() {
      await ensureWorkspace();
      const { error } = await supabase
        .from('agent_workspaces')
        .update({ current_run_id: null, updated_at: new Date().toISOString() })
        .eq('id', workspaceId);
      if (error) throw error;
      return withProvider({ ...initialWorkspace(), runHistory: await listRuns() }, workspaceId);
    },
    async listRuns() {
      return listRuns();
    },
    async selectRun(runId) {
      await ensureWorkspace();
      const { data: run, error: runError } = await supabase
        .from('agent_runs')
        .select('id')
        .eq('id', runId)
        .eq('workspace_id', workspaceId)
        .single();
      if (runError || !run) throw runError || new Error('Run not found.');
      const { error } = await supabase
        .from('agent_workspaces')
        .update({ current_run_id: runId, updated_at: new Date().toISOString() })
        .eq('id', workspaceId);
      if (error) throw error;
      return withProvider(await loadRun(runId), workspaceId);
    },
    async saveRun({ idea, prd, tasks, graph, logs }) {
      await ensureWorkspace();
      const runId = crypto.randomUUID();
      const now = new Date().toISOString();
      const { error: runError } = await supabase.from('agent_runs').insert({
        id: runId,
        workspace_id: workspaceId,
        idea,
        status: 'planned',
        graph,
      });
      if (runError) throw runError;

      const { error: prdError } = await supabase.from('agent_prds').insert({
        run_id: runId,
        title: prd.title,
        problem: prd.problem,
        audience: prd.audience,
        goals: prd.goals,
        scope: prd.scope,
        source_idea: prd.sourceIdea,
        generated_by: prd.generatedBy,
        model: prd.model || null,
        context: prd.context || [],
        validation: prd.validation || prd.checks || [],
      });
      if (prdError) throw prdError;

      const { error: taskError } = await supabase.from('agent_tasks').insert(
        tasks.map((task, index) => ({
          run_id: runId,
          public_id: task.id,
          title: task.title,
          owner: task.owner,
          priority: task.priority,
          effort: task.effort,
          acceptance: task.acceptance,
          status: task.status,
          source: task.source,
          position: index,
          created_at: task.createdAt || now,
        })),
      );
      if (taskError) throw taskError;

      const { error: logError } = await supabase.from('agent_tool_calls').insert(
        logs.map((log) => ({
          run_id: runId,
          type: log.type,
          label: log.label,
          detail: log.detail,
          created_at: log.createdAt || now,
        })),
      );
      if (logError) throw logError;

      const { error: workspaceError } = await supabase
        .from('agent_workspaces')
        .update({ current_run_id: runId, updated_at: now })
        .eq('id', workspaceId);
      if (workspaceError) throw workspaceError;

      return withProvider(await loadRun(runId), workspaceId);
    },
    async patchTask(taskId, patch, graph, log) {
      const runId = await currentRunId();
      if (!runId) throw new Error('No active run.');
      const rowPatch = toTaskRowPatch(patch);
      const { error: taskError } = await supabase
        .from('agent_tasks')
        .update({ ...rowPatch, updated_at: new Date().toISOString() })
        .eq('run_id', runId)
        .eq('public_id', taskId);
      if (taskError) throw taskError;

      const { error: runError } = await supabase
        .from('agent_runs')
        .update({ graph, updated_at: new Date().toISOString() })
        .eq('id', runId);
      if (runError) throw runError;

      const { error: logError } = await supabase.from('agent_tool_calls').insert({
        run_id: runId,
        type: log.type,
        label: log.label,
        detail: log.detail,
        created_at: log.createdAt,
      });
      if (logError) throw logError;
      return withProvider(await loadRun(runId), workspaceId);
    },
    async patchTasks(taskIds, patch, graph, log) {
      const runId = await currentRunId();
      if (!runId) throw new Error('No active run.');
      const rowPatch = toTaskRowPatch(patch);
      const { error: taskError } = await supabase
        .from('agent_tasks')
        .update({ ...rowPatch, updated_at: new Date().toISOString() })
        .eq('run_id', runId)
        .in('public_id', taskIds);
      if (taskError) throw taskError;

      const { error: runError } = await supabase
        .from('agent_runs')
        .update({ graph, updated_at: new Date().toISOString() })
        .eq('id', runId);
      if (runError) throw runError;

      const { error: logError } = await supabase.from('agent_tool_calls').insert({
        run_id: runId,
        type: log.type,
        label: log.label,
        detail: log.detail,
        created_at: log.createdAt,
      });
      if (logError) throw logError;
      return withProvider(await loadRun(runId), workspaceId);
    },
    async createExport(exportRecord, graph, log) {
      const runId = await currentRunId();
      if (!runId) throw new Error('No active run.');
      const { error: exportError } = await supabase.from('agent_exports').insert({
        id: exportRecord.id,
        run_id: runId,
        target: exportRecord.target,
        status: exportRecord.status,
        payload: exportRecord.payload,
        delivery: exportRecord.delivery,
        created_at: exportRecord.createdAt,
      });
      if (exportError) throw exportError;

      const { error: runError } = await supabase
        .from('agent_runs')
        .update({ graph, updated_at: new Date().toISOString() })
        .eq('id', runId);
      if (runError) throw runError;

      const { error: logError } = await supabase.from('agent_tool_calls').insert({
        run_id: runId,
        type: log.type,
        label: log.label,
        detail: log.detail,
        created_at: log.createdAt,
      });
      if (logError) throw logError;
      return withProvider(await loadRun(runId), workspaceId);
    },
  };
}

function fromTaskRow(row) {
  return {
    id: row.public_id,
    title: row.title,
    owner: row.owner,
    priority: row.priority,
    effort: row.effort,
    acceptance: row.acceptance,
    status: row.status,
    reviewNote: row.review_note || '',
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function fromRunSummaryRow(row) {
  const exportCount = Number(row.export_count || 0);
  const approvedCount = Number(row.approved_count || 0);
  return {
    runId: row.run_id || row.id,
    title: row.title || 'Untitled run',
    idea: row.idea || '',
    status: exportCount > 0 ? 'exported' : approvedCount > 0 ? 'approved' : row.status || 'planned',
    taskCount: Number(row.task_count || 0),
    approvedCount,
    rejectedCount: Number(row.rejected_count || 0),
    exportCount,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || row.created_at || null,
  };
}

function toTaskRowPatch(patch) {
  const mapped = {};
  const map = {
    title: 'title',
    owner: 'owner',
    priority: 'priority',
    effort: 'effort',
    acceptance: 'acceptance',
    status: 'status',
    reviewNote: 'review_note',
  };
  for (const [key, column] of Object.entries(map)) {
    if (patch[key] !== undefined) mapped[column] = patch[key];
  }
  return mapped;
}

async function updateD1Task(runId, taskIds, patch) {
  const rowPatch = toTaskRowPatch(patch);
  const entries = Object.entries(rowPatch);
  if (!entries.length || !taskIds.length) return;

  const now = new Date().toISOString();
  const assignments = [...entries.map(([column]) => `${column} = ?`), 'updated_at = ?'];
  const values = [...entries.map(([, value]) => value), now];

  for (const taskId of taskIds) {
    await d1Query(`update agent_tasks set ${assignments.join(', ')} where run_id = ? and public_id = ?`, [
      ...values,
      runId,
      taskId,
    ]);
  }
}

async function d1Rows(sql, params = []) {
  const result = await d1Query(sql, params);
  return Array.isArray(result.results) ? result.results : [];
}

async function d1Query(sql, params = []) {
  const response = await fetch(d1QueryUrl(), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sql,
      params: params.map((value) => (value === undefined ? null : value)),
    }),
  });
  const json = await readD1Json(response);
  const result = Array.isArray(json.result) ? json.result[0] : json.result;
  const error = d1ErrorMessage(json, result);

  if (!response.ok || error) {
    throw new Error(error || `Cloudflare D1 query failed with HTTP ${response.status}`);
  }

  return result || { results: [] };
}

async function readD1Json(response) {
  try {
    return await response.json();
  } catch {
    return {
      success: false,
      errors: [{ message: `Cloudflare D1 returned a non-JSON response with HTTP ${response.status}` }],
    };
  }
}

function d1ErrorMessage(json, result) {
  const errors = [
    ...(Array.isArray(json?.errors) ? json.errors : []),
    ...(Array.isArray(result?.errors) ? result.errors : []),
  ]
    .map((error) => error?.message)
    .filter(Boolean);

  if (json?.success === false || result?.success === false || errors.length) {
    return errors.join('; ') || 'Cloudflare D1 query failed.';
  }
  return '';
}

function d1QueryUrl() {
  const accountId = encodeURIComponent(process.env.CLOUDFLARE_ACCOUNT_ID);
  const databaseId = encodeURIComponent(process.env.CLOUDFLARE_D1_DATABASE_ID);
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
