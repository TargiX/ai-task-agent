import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const scriptPath = path.resolve('scripts/hosted-smoke.mjs');

test('hosted smoke validates protected-readiness endpoints over fixture transport', async () => {
  const fixturePath = await writeFixture();
  const result = runHostedSmoke(fixturePath, { REQUIRE_DURABLE: '0' });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.baseUrl, 'https://preview.example.test');
  assert.equal(report.transport, 'fixture');
  assert.equal(report.provider.storage, 'json');
  assert.equal(report.demoReport.tasks, 5);
});

test('hosted smoke enforces durable storage when required', async () => {
  const fixturePath = await writeFixture();
  const result = runHostedSmoke(fixturePath, { REQUIRE_DURABLE: '1' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /production storage must be durable/);
});

test('hosted smoke verifies private team workspace mode when configured', async () => {
  const fixturePath = await writeFixture();
  const result = runHostedSmoke(fixturePath, {
    REQUIRE_DURABLE: '0',
    REQUIRE_TEAM_WORKSPACE: '1',
    TEAM_WORKSPACE_ID: 'targix-smoke-1',
    TEAM_WORKSPACE_TOKEN: 'team-token',
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.teamWorkspace.ok, true);
  assert.equal(report.teamWorkspace.workspace, 'targix-smoke-1');
  assert.equal(report.teamWorkspace.providerAccess, 'guarded');
  assert.equal(report.teamWorkspace.mode, 'real-issue-creation');
});

function runHostedSmoke(fixturePath, env = {}) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      BASE_URL: 'https://preview.example.test',
      HOSTED_SMOKE_TRANSPORT: 'fixture',
      HOSTED_SMOKE_FIXTURE: fixturePath,
      ...env,
    },
  });
}

async function writeFixture() {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ai-task-agent-hosted-smoke-'));
  const fixturePath = path.join(tmpDir, 'fixture.json');
  await writeFile(fixturePath, JSON.stringify(fixturePayload()), 'utf8');
  return fixturePath;
}

function fixturePayload() {
  const provider = {
    ai: 'local-planner',
    langgraph: 'not-configured',
    storage: 'json',
    linear: 'not-configured',
    github: 'not-configured',
    access: 'guarded',
  };
  return {
    '/api/health': {
      ok: true,
      service: 'ai-task-agent',
      runtime: 'node',
      environment: 'test',
    },
    '/api/preflight': {
      provider,
      summary: { ready: 1, fallback: 3, missing: 2, misconfigured: 0, total: 6 },
      capabilities: [
        { id: 'idea-to-prd', status: 'ready' },
        { id: 'task-breakdown', status: 'ready' },
        { id: 'tool-calling', status: 'ready' },
        { id: 'human-approval', status: 'ready' },
        { id: 'workspace-isolation', status: 'ready' },
      ],
    },
    '/api/setup/verify': {
      runtime: 'node',
      provider,
      summary: { ready: 2, fallback: 4, missing: 0, failed: 0, total: 6 },
      checks: [
        { id: 'api-runtime', status: 'ready' },
        { id: 'storage-roundtrip', status: 'fallback' },
        { id: 'issue-package', status: 'ready' },
      ],
    },
    '/api/integrations/verify': {
      ok: false,
      configured: 0,
      providers: {
        github: { status: 'missing' },
        linear: { status: 'missing' },
      },
    },
    '/api/demo/report': {
      ok: true,
      summary: {
        tasks: 5,
        approved: 5,
        traceSpans: 10,
      },
      checks: [
        { id: 'idea-to-prd', status: 'ready' },
        { id: 'task-breakdown', status: 'ready' },
        { id: 'human-approval', status: 'ready' },
        { id: 'issue-package', status: 'ready' },
        { id: 'trace-export', status: 'ready' },
      ],
    },
    '/api/llm/free-models': {
      models: [],
      sources: [],
      provider,
    },
    'GET /api/team/workspaces': {
      configured: true,
      access: 'team-guarded',
      teams: [{ id: 'targix', label: 'TargiX Product' }],
    },
    'POST /api/team/session': {
      ok: true,
      workspace: { id: 'targix-smoke-1', label: 'TargiX Product' },
      access: 'guarded',
      global: false,
      team: { id: 'targix', label: 'TargiX Product' },
    },
    'DELETE /api/workspace': {
      ok: true,
      workspace: { id: 'targix-smoke-1', label: 'TargiX Product' },
      provider,
      tasks: [],
      runHistory: [],
    },
    'POST /api/agent/run': {
      runId: 'run-team-smoke',
      provider: { ...provider, access: 'guarded' },
      workspace: {
        id: 'targix-smoke-1',
        label: 'TargiX Product',
        access: 'guarded',
        team: { id: 'targix', label: 'TargiX Product' },
      },
      prd: { title: 'Private Team Workspace MVP' },
      tasks: Array.from({ length: 5 }, (_, index) => ({
        id: `TASK-${index + 1}`,
        title: `Task ${index + 1}`,
        status: 'pending',
      })),
      runHistory: [{ runId: 'run-team-smoke' }],
    },
    'PATCH /api/tasks/batch': {
      provider: { ...provider, access: 'guarded' },
      tasks: [
        { id: 'TASK-1', status: 'approved' },
        { id: 'TASK-2', status: 'approved' },
        { id: 'TASK-3', status: 'pending' },
        { id: 'TASK-4', status: 'pending' },
        { id: 'TASK-5', status: 'pending' },
      ],
    },
    'GET /api/export-package?target=GitHub': {
      status: 'ready',
      mode: {
        mode: 'real-issue-creation',
        canCreateIssues: true,
      },
      payload: [{ title: 'Task 1' }],
      markdown: '# GitHub issue package',
    },
  };
}
