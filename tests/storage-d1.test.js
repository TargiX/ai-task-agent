import assert from 'node:assert/strict';
import test from 'node:test';
import { graphTrace, logEntry } from '../lib/domain.js';
import { getStorage } from '../lib/storage.js';

test('Cloudflare D1 storage persists run, approval, and export through the query API', async () => {
  await withD1Env(async () => {
    const previousFetch = global.fetch;
    const fakeD1 = createFakeD1();
    global.fetch = fakeD1.fetch;

    try {
      const storage = getStorage();
      const reset = await storage.resetWorkspace();
      assert.equal(reset.provider.storage, 'cloudflare-d1');

      const saved = await storage.saveRun({
        idea: 'Build a task agent for SaaS teams.',
        prd: {
          title: 'Task Agent MVP',
          problem: 'SaaS teams need a faster way to turn product ideas into reviewed engineering work.',
          audience: 'Product and engineering leads',
          goals: ['Create PRDs', 'Break work into tasks'],
          scope: ['Idea capture', 'Human approval'],
          context: ['Customer feedback SaaS domain pattern'],
          sourceIdea: 'Build a task agent for SaaS teams.',
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

      assert.equal(saved.provider.storage, 'cloudflare-d1');
      assert.ok(saved.runId);
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
          createdAt: '2026-06-18T00:01:00.000Z',
        },
        graphTrace('exported'),
        logEntry('integration', 'github.issues.create_batch', 'Prepared 1 issue'),
      );

      assert.equal(exported.exports[0].target, 'GitHub');
      assert.equal(exported.exports[0].payload[0].title, 'Create planning endpoint');

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

      assert.equal(fakeD1.calls[0].url, 'https://api.cloudflare.com/client/v4/accounts/cf-account/d1/database/cf-database/query');
      assert.equal(fakeD1.calls[0].options.headers.authorization, 'Bearer cf-token');
      assert.ok(fakeD1.calls.some((call) => call.body.sql.startsWith('insert into agent_runs')));
      assert.ok(fakeD1.calls.some((call) => call.body.sql.startsWith('update agent_tasks set status = ?')));
      assert.ok(fakeD1.calls.some((call) => call.body.sql.startsWith('select r.id as run_id')));
    } finally {
      global.fetch = previousFetch;
    }
  });
});

async function withD1Env(callback) {
  const names = [
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_D1_DATABASE_ID',
    'CLOUDFLARE_API_TOKEN',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_PUBLISHABLE_KEY',
    'SUPABASE_ANON_KEY',
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.CLOUDFLARE_ACCOUNT_ID = 'cf-account';
  process.env.CLOUDFLARE_D1_DATABASE_ID = 'cf-database';
  process.env.CLOUDFLARE_API_TOKEN = 'cf-token';
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_PUBLISHABLE_KEY;
  delete process.env.SUPABASE_ANON_KEY;

  try {
    await callback();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

function createFakeD1() {
  const db = {
    workspace: null,
    runs: new Map(),
    prds: new Map(),
    tasks: [],
    logs: [],
    exports: [],
  };
  const calls = [];

  return {
    calls,
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      const sql = body.sql.replace(/\s+/g, ' ').trim();
      const normalized = sql.toLowerCase();
      const params = body.params || [];
      calls.push({ url, options, body: { ...body, sql } });

      const results = handleD1Query(db, normalized, sql, params);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          errors: [],
          messages: [],
          result: [{ success: true, results, meta: { rows_read: results.length, rows_written: 0 } }],
        }),
      };
    },
  };
}

function handleD1Query(db, normalized, sql, params) {
  if (normalized.startsWith('create table') || normalized.startsWith('create index')) return [];

  if (normalized.startsWith('insert into agent_workspaces')) {
    if (!db.workspace) {
      db.workspace = {
        id: params[0],
        name: params[1],
        current_run_id: null,
        created_at: params[2],
        updated_at: params[2],
      };
    }
    return [];
  }

  if (normalized.startsWith('select current_run_id from agent_workspaces')) {
    return db.workspace ? [{ current_run_id: db.workspace.current_run_id }] : [];
  }

  if (normalized.startsWith('update agent_workspaces set current_run_id = null')) {
    if (db.workspace) {
      db.workspace.current_run_id = null;
      db.workspace.updated_at = params[0];
    }
    return [];
  }

  if (normalized.startsWith('update agent_workspaces set current_run_id = ?')) {
    db.workspace.current_run_id = params[0];
    db.workspace.updated_at = params[1];
    return [];
  }

  if (normalized.startsWith('delete from agent_runs')) {
    db.runs.delete(params[0]);
    db.prds.delete(params[0]);
    db.tasks = db.tasks.filter((task) => task.run_id !== params[0]);
    db.logs = db.logs.filter((log) => log.run_id !== params[0]);
    db.exports = db.exports.filter((record) => record.run_id !== params[0]);
    return [];
  }

  if (normalized.startsWith('insert into agent_runs')) {
    db.runs.set(params[0], {
      id: params[0],
      workspace_id: params[1],
      idea: params[2],
      status: params[3],
      graph: params[4],
      created_at: params[5],
      updated_at: params[6],
    });
    return [];
  }

  if (normalized.startsWith('insert into agent_prds')) {
    db.prds.set(params[1], {
      id: params[0],
      run_id: params[1],
      title: params[2],
      problem: params[3],
      audience: params[4],
      goals: params[5],
      scope: params[6],
      context: params[7],
      source_idea: params[8],
      generated_by: params[9],
      model: params[10],
      validation: params[11],
      created_at: params[12],
    });
    return [];
  }

  if (normalized.startsWith('insert into agent_tasks')) {
    db.tasks.push({
      id: params[0],
      run_id: params[1],
      public_id: params[2],
      title: params[3],
      owner: params[4],
      priority: params[5],
      effort: params[6],
      acceptance: params[7],
      status: params[8],
      review_note: params[9],
      source: params[10],
      position: params[11],
      created_at: params[12],
      updated_at: params[13],
    });
    return [];
  }

  if (normalized.startsWith('insert into agent_tool_calls')) {
    db.logs.push({
      id: params[0],
      run_id: params[1],
      type: params[2],
      label: params[3],
      detail: params[4],
      created_at: params[5],
    });
    return [];
  }

  if (normalized.startsWith('select * from agent_runs')) {
    return db.runs.has(params[0]) ? [db.runs.get(params[0])] : [];
  }

  if (normalized.startsWith('select id from agent_runs where id = ? and workspace_id = ?')) {
    const run = db.runs.get(params[0]);
    return run && run.workspace_id === params[1] ? [{ id: run.id }] : [];
  }

  if (normalized.startsWith('select r.id as run_id')) {
    return [...db.runs.values()]
      .filter((run) => run.workspace_id === params[0])
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, 30)
      .map((run) => {
        const tasks = db.tasks.filter((task) => task.run_id === run.id);
        return {
          run_id: run.id,
          idea: run.idea,
          status: run.status,
          created_at: run.created_at,
          updated_at: run.updated_at,
          title: db.prds.get(run.id)?.title,
          task_count: tasks.length,
          approved_count: tasks.filter((task) => task.status === 'approved').length,
          rejected_count: tasks.filter((task) => task.status === 'rejected').length,
          export_count: db.exports.filter((record) => record.run_id === run.id).length,
        };
      });
  }

  if (normalized.startsWith('select * from agent_prds')) {
    return db.prds.has(params[0]) ? [db.prds.get(params[0])] : [];
  }

  if (normalized.startsWith('select * from agent_tasks')) {
    return db.tasks.filter((task) => task.run_id === params[0]).sort((a, b) => a.position - b.position);
  }

  if (normalized.startsWith('select * from agent_tool_calls')) {
    return db.logs
      .filter((log) => log.run_id === params[0])
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  if (normalized.startsWith('select * from agent_exports')) {
    return db.exports
      .filter((record) => record.run_id === params[0])
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  if (normalized.startsWith('update agent_tasks set')) {
    const runId = params.at(-2);
    const publicId = params.at(-1);
    const task = db.tasks.find((candidate) => candidate.run_id === runId && candidate.public_id === publicId);
    const assignmentSegment = normalized.slice('update agent_tasks set '.length, normalized.indexOf(' where run_id = ? and public_id = ?'));
    const columns = assignmentSegment.split(',').map((assignment) => assignment.trim().split(' = ')[0]);
    columns.forEach((column, index) => {
      task[column] = params[index];
    });
    return [];
  }

  if (normalized.startsWith('update agent_runs set graph = ?')) {
    const run = db.runs.get(params[2]);
    run.graph = params[0];
    run.updated_at = params[1];
    return [];
  }

  if (normalized.startsWith('insert into agent_exports')) {
    db.exports.push({
      id: params[0],
      run_id: params[1],
      target: params[2],
      status: params[3],
      payload: params[4],
      delivery: params[5],
      created_at: params[6],
    });
    return [];
  }

  throw new Error(`Unhandled fake D1 query: ${sql}`);
}
