import assert from 'node:assert/strict';
import test from 'node:test';
import { graphTrace, logEntry } from '../lib/domain.js';
import { getStorageWithOptions } from '../lib/storage.js';

test('Supabase storage persists team runs, approval, export, and history', async () => {
  await withSupabaseEnv(async () => {
    const fakeSupabase = createFakeSupabase();
    const storage = getStorageWithOptions('alpha-team', { supabaseClient: fakeSupabase.client });

    const reset = await storage.resetWorkspace();
    assert.equal(reset.provider.storage, 'supabase');
    assert.equal(reset.workspace.id, 'alpha-team');

    const saved = await storage.saveRun({
      idea: 'Build a task agent for SaaS product teams.',
      prd: {
        title: 'Task Agent MVP',
        problem: 'SaaS teams need a reliable way to turn product ideas into reviewed engineering work.',
        audience: 'Product and engineering leads',
        goals: ['Create PRDs', 'Break work into tasks'],
        scope: ['Idea capture', 'Human approval'],
        context: ['Customer feedback SaaS domain pattern'],
        sourceIdea: 'Build a task agent for SaaS product teams.',
        generatedBy: 'test-planner',
        model: 'test-model',
        validation: ['All required agent output fields passed validation'],
      },
      tasks: [
        {
          id: 'TASK-1',
          title: 'Create planning endpoint',
          owner: 'AI Platform',
          priority: 'High',
          effort: '3 pts',
          acceptance: 'The endpoint creates PRD and task records.',
          status: 'pending',
          source: 'test',
          createdAt: '2026-06-18T00:00:00.000Z',
        },
      ],
      graph: graphTrace('planned'),
      logs: [logEntry('tool', 'tasks.create_many', 'Persisted 1 task')],
    });

    assert.equal(saved.provider.storage, 'supabase');
    assert.ok(saved.runId);
    assert.equal(saved.workspace.id, 'alpha-team');
    assert.equal(saved.prd.context[0], 'Customer feedback SaaS domain pattern');
    assert.equal(saved.tasks[0].status, 'pending');
    assert.equal(saved.runHistory.length, 1);
    assert.equal(saved.runHistory[0].title, 'Task Agent MVP');

    const approved = await storage.patchTask(
      'TASK-1',
      { status: 'approved', reviewNote: 'Ready for GitHub.' },
      graphTrace('approved'),
      logEntry('human', 'human.approve_task', 'Approved TASK-1'),
    );
    assert.equal(approved.tasks[0].status, 'approved');
    assert.equal(approved.tasks[0].reviewNote, 'Ready for GitHub.');

    const exported = await storage.createExport(
      {
        id: 'export-1',
        target: 'GitHub',
        status: 'payload-only',
        payload: [{ title: 'Create planning endpoint' }],
        delivery: [{ ok: true, url: 'https://github.com/targix/ai-task-agent/issues/1' }],
        createdAt: '2026-06-18T00:01:00.000Z',
      },
      graphTrace('exported'),
      logEntry('integration', 'github.issues.create_batch', 'Prepared 1 issue'),
    );

    assert.equal(exported.exports[0].target, 'GitHub');
    assert.equal(exported.exports[0].payload[0].title, 'Create planning endpoint');
    assert.equal(exported.exports[0].delivery[0].ok, true);

    const second = await storage.saveRun({
      idea: 'Build a billing agent for SaaS finance teams.',
      prd: {
        title: 'Billing Agent MVP',
        problem: 'Finance teams need a billing workflow assistant.',
        audience: 'Finance leads',
        goals: ['Audit payments'],
        scope: ['Payment review'],
        context: ['Billing operations SaaS domain pattern'],
        sourceIdea: 'Build a billing agent for SaaS finance teams.',
        generatedBy: 'test-planner',
        model: 'test-model',
        validation: ['All required agent output fields passed validation'],
      },
      tasks: [
        {
          id: 'TASK-2',
          title: 'Create billing review endpoint',
          owner: 'AI Platform',
          priority: 'High',
          effort: '3 pts',
          acceptance: 'The endpoint creates billing PRD and task records.',
          status: 'pending',
          source: 'test',
          createdAt: '2026-06-18T00:02:00.000Z',
        },
      ],
      graph: graphTrace('planned'),
      logs: [logEntry('tool', 'tasks.create_many', 'Persisted 1 billing task')],
    });
    assert.equal(second.runHistory.length, 2);

    const restored = await storage.selectRun(saved.runId);
    assert.equal(restored.runId, saved.runId);
    assert.equal(restored.prd.title, 'Task Agent MVP');
    assert.equal((await storage.listRuns()).length, 2);

    await assert.rejects(() => storage.selectRun(crypto.randomUUID()), { message: 'Run not found.' });
    assert.ok(fakeSupabase.calls.some((call) => call.table === 'agent_workspaces' && call.type === 'upsert'));
    assert.ok(fakeSupabase.calls.some((call) => call.table === 'agent_runs' && call.type === 'insert'));
    assert.ok(fakeSupabase.calls.some((call) => call.table === 'agent_tasks' && call.type === 'update'));
    assert.ok(fakeSupabase.calls.some((call) => call.table === 'agent_exports' && call.type === 'insert'));
  });
});

async function withSupabaseEnv(callback) {
  const names = [
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_D1_DATABASE_ID',
    'CLOUDFLARE_API_TOKEN',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_D1_DATABASE_ID;
  delete process.env.CLOUDFLARE_API_TOKEN;
  process.env.SUPABASE_URL = 'https://project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

  try {
    await callback();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

function createFakeSupabase() {
  const db = {
    workspaces: new Map(),
    runs: new Map(),
    prds: [],
    tasks: [],
    logs: [],
    exports: [],
  };
  const calls = [];
  const client = {
    from(table) {
      return new FakeTable(db, calls, table);
    },
  };
  return { client, calls };
}

class FakeTable {
  constructor(db, calls, table) {
    this.db = db;
    this.calls = calls;
    this.table = table;
  }

  select(columns) {
    return new FakeQuery(this.db, this.calls, this.table, 'select', { columns });
  }

  insert(values) {
    return new FakeQuery(this.db, this.calls, this.table, 'insert', { values });
  }

  update(patch) {
    return new FakeQuery(this.db, this.calls, this.table, 'update', { patch });
  }

  upsert(values, options = {}) {
    return new FakeQuery(this.db, this.calls, this.table, 'upsert', { values, options });
  }
}

class FakeQuery {
  constructor(db, calls, table, type, payload = {}) {
    this.db = db;
    this.calls = calls;
    this.table = table;
    this.type = type;
    this.payload = payload;
    this.filters = [];
    this.orders = [];
    this.limitCount = null;
    this.singleMode = false;
    this.maybeSingleMode = false;
  }

  eq(column, value) {
    this.filters.push({ column, op: 'eq', value });
    return this;
  }

  in(column, values) {
    this.filters.push({ column, op: 'in', values });
    return this;
  }

  order(column, options = {}) {
    this.orders.push({ column, ascending: options.ascending !== false });
    return this;
  }

  limit(count) {
    this.limitCount = count;
    return this;
  }

  single() {
    this.singleMode = true;
    return this;
  }

  maybeSingle() {
    this.maybeSingleMode = true;
    return this;
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }

  async execute() {
    this.calls.push({
      table: this.table,
      type: this.type,
      payload: this.payload,
      filters: this.filters,
    });

    if (this.type === 'select') return this.selectRows();
    if (this.type === 'insert') return this.insertRows();
    if (this.type === 'update') return this.updateRows();
    if (this.type === 'upsert') return this.upsertRows();
    return { data: null, error: new Error(`Unsupported fake query ${this.type}`) };
  }

  selectRows() {
    let rows = rowsForTable(this.db, this.table).filter((row) => matchesFilters(row, this.filters));
    for (const order of this.orders) {
      rows = [...rows].sort((a, b) => {
        const result = String(a[order.column] || '').localeCompare(String(b[order.column] || ''));
        return order.ascending ? result : -result;
      });
    }
    if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);

    if (this.singleMode || this.maybeSingleMode) {
      if (rows.length === 1) return { data: rows[0], error: null };
      if (rows.length === 0 && this.maybeSingleMode) return { data: null, error: null };
      return { data: null, error: new Error('JSON object requested, multiple or no rows returned') };
    }

    return { data: rows, error: null };
  }

  insertRows() {
    const values = Array.isArray(this.payload.values) ? this.payload.values : [this.payload.values];
    const now = new Date().toISOString();
    for (const value of values) {
      const row = { ...value };
      if (this.table !== 'agent_exports') row.id ||= crypto.randomUUID();
      row.created_at ||= now;
      row.updated_at ||= row.created_at;
      insertRow(this.db, this.table, row);
    }
    return { data: values, error: null };
  }

  updateRows() {
    const rows = rowsForTable(this.db, this.table).filter((row) => matchesFilters(row, this.filters));
    for (const row of rows) {
      Object.assign(row, this.payload.patch);
    }
    return { data: rows, error: null };
  }

  upsertRows() {
    const values = Array.isArray(this.payload.values) ? this.payload.values : [this.payload.values];
    const now = new Date().toISOString();
    for (const value of values) {
      const existing = rowsForTable(this.db, this.table).find((row) => row.id === value.id);
      if (existing) {
        Object.assign(existing, { ...value, current_run_id: value.current_run_id ?? existing.current_run_id });
      } else {
        insertRow(this.db, this.table, {
          ...value,
          current_run_id: value.current_run_id || null,
          created_at: now,
          updated_at: now,
        });
      }
    }
    return { data: values, error: null };
  }
}

function rowsForTable(db, table) {
  if (table === 'agent_workspaces') return [...db.workspaces.values()];
  if (table === 'agent_runs') return [...db.runs.values()];
  if (table === 'agent_prds') return db.prds;
  if (table === 'agent_tasks') return db.tasks;
  if (table === 'agent_tool_calls') return db.logs;
  if (table === 'agent_exports') return db.exports;
  return [];
}

function insertRow(db, table, row) {
  if (table === 'agent_workspaces') db.workspaces.set(row.id, row);
  else if (table === 'agent_runs') db.runs.set(row.id, row);
  else if (table === 'agent_prds') db.prds.push(row);
  else if (table === 'agent_tasks') db.tasks.push(row);
  else if (table === 'agent_tool_calls') db.logs.push(row);
  else if (table === 'agent_exports') db.exports.push(row);
}

function matchesFilters(row, filters) {
  return filters.every((filter) => {
    if (filter.op === 'eq') return row[filter.column] === filter.value;
    if (filter.op === 'in') return filter.values.includes(row[filter.column]);
    return true;
  });
}
