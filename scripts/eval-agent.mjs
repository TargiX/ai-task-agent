import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handleApiRequest } from '../lib/api-core.js';

const cases = JSON.parse(await readFile(new URL('../evals/cases.json', import.meta.url), 'utf8'));
const previousEnv = snapshotEnv();
const results = [];

try {
  clearProviderEnv();
  for (const testCase of cases) {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), `ai-task-agent-eval-${testCase.id}-`));
    process.env.TASK_AGENT_DB_FILE = path.join(tmpDir, 'task-agent-db.json');
    const headers = authHeaders();

    const memory = await handleApiRequest({ method: 'GET', pathname: '/api/memory', headers });
    assert.equal(memory.status, 200);
    assert.ok(
      memory.body.documents.some((doc) => doc.id === testCase.mustRetrieve),
      `${testCase.id} memory corpus must contain ${testCase.mustRetrieve}`,
    );

    const run = await handleApiRequest({
      method: 'POST',
      pathname: '/api/agent/run',
      headers,
      body: { idea: testCase.idea },
    });
    assert.equal(run.status, 200, `${testCase.id} run should succeed`);
    assert.equal(run.body.tasks.length, 5, `${testCase.id} should create 5 tasks`);
    assert.equal(run.body.graph.find((node) => node.id === 'approval')?.status, 'active');
    assert.ok(run.body.prd.context?.length >= 3, `${testCase.id} should include retrieved context`);
    assert.ok(
      run.body.prd.context.some((entry) => entry.toLowerCase().includes(testCase.mustRetrieve.replace(/-/g, ' ').split(' ')[0])),
      `${testCase.id} should include expected domain context`,
    );
    assert.ok(
      run.body.logs.some((log) => log.label === 'memory.retrieve_context'),
      `${testCase.id} should log memory retrieval`,
    );
    assert.ok(
      run.body.logs.some((log) => log.label === 'interrupt.wait_for_human'),
      `${testCase.id} should pause for approval`,
    );

    const blockedExport = await handleApiRequest({
      method: 'POST',
      pathname: '/api/export',
      headers,
      body: { target: 'Linear' },
    });
    assert.equal(blockedExport.status, 400, `${testCase.id} export should be blocked before approval`);

    results.push({
      id: testCase.id,
      title: run.body.prd.title,
      tasks: run.body.tasks.length,
      retrieved: run.body.prd.context.length,
      status: 'pass',
    });
  }
} finally {
  restoreEnv(previousEnv);
}

console.log(JSON.stringify({ ok: true, cases: results }, null, 2));

function snapshotEnv() {
  const names = [
    'TASK_AGENT_DB_FILE',
    'LANGGRAPH_BACKEND_URL',
    'OPENROUTER_API_KEY',
    'FREELLMAPI_BASE_URL',
    'FREELLMAPI_API_KEY',
    'OPENAI_API_KEY',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_PUBLISHABLE_KEY',
    'SUPABASE_ANON_KEY',
    'LINEAR_API_KEY',
    'LINEAR_TEAM_ID',
    'GITHUB_TOKEN',
    'GITHUB_REPOSITORY',
  ];
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

function clearProviderEnv() {
  for (const name of Object.keys(previousEnv)) delete process.env[name];
}

function authHeaders() {
  return process.env.WORKSPACE_ACCESS_TOKEN
    ? { 'x-ai-task-agent-access-token': process.env.WORKSPACE_ACCESS_TOKEN }
    : {};
}

function restoreEnv(snapshot) {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
