import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const scriptPath = path.resolve('scripts/production-launch.mjs');
const envInitScriptPath = path.resolve('scripts/production-env-init.mjs');

test('production env init creates env file and generates workspace access token once', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ai-task-agent-env-init-'));
  const envFile = path.join(tmpDir, '.env.production.local');
  const first = runEnvInit(envFile);

  assert.equal(first.status, 0, first.stderr);
  const firstReport = JSON.parse(first.stdout);
  assert.equal(firstReport.created, true);
  assert.deepEqual(firstReport.generated, ['WORKSPACE_ACCESS_TOKEN']);
  assert.equal(first.stdout.includes('wat_'), false, 'stdout must not print the generated access token');
  assert.equal(firstReport.readiness.workspaceAccess, 'ready');
  assert.equal(firstReport.readiness.liveLlm, 'missing');
  assert.ok(firstReport.readiness.missingExternal.some((item) => item.group === 'durable-storage'));
  assert.ok(firstReport.readiness.missingExternal.some((item) => item.group === 'live-llm'));

  const envContents = await import('node:fs/promises').then((fs) => fs.readFile(envFile, 'utf8'));
  const token = envContents.match(/^WORKSPACE_ACCESS_TOKEN=(wat_[^\n]+)$/m)?.[1];
  assert.ok(token);
  assert.match(envContents, /^LANGGRAPH_BACKEND_URL=$/m);
  assert.match(envContents, /^PUBLIC_APP_URL=$/m);
  assert.match(envContents, /^GITHUB_REPOSITORY=$/m);

  const second = runEnvInit(envFile);
  assert.equal(second.status, 0, second.stderr);
  const secondReport = JSON.parse(second.stdout);
  assert.deepEqual(secondReport.generated, []);
  const nextContents = await import('node:fs/promises').then((fs) => fs.readFile(envFile, 'utf8'));
  assert.equal(nextContents.match(/^WORKSPACE_ACCESS_TOKEN=(wat_[^\n]+)$/m)?.[1], token);
});

test('production launch dry-run accepts LangGraph as the live planner provider', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ai-task-agent-launch-'));
  const envFile = path.join(tmpDir, '.env.production.local');
  const result = runLaunchDryRun(envFile, {
    CLOUDFLARE_ACCOUNT_ID: 'cloudflare-account-id',
    CLOUDFLARE_D1_DATABASE_ID: 'cloudflare-d1-database-id',
    CLOUDFLARE_API_TOKEN: 'cloudflare-api-token',
    LANGGRAPH_BACKEND_URL: 'https://agent-backend.example.com',
    GITHUB_TOKEN: 'github-token',
    GITHUB_REPOSITORY: 'targix/ai-task-agent',
    WORKSPACE_ACCESS_TOKEN: 'workspace-access-token',
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.blockers, []);
  assert.deepEqual(report.acceptedSecretSets.liveLlm.at(-1), ['LANGGRAPH_BACKEND_URL']);
  assert.ok(report.commands.some((command) => command.includes('d1:setup')));
  assert.ok(report.commands.some((command) => command.includes('vercel deploy')));
});

test('production launch dry-run accepts Supabase as durable storage', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ai-task-agent-launch-'));
  const envFile = path.join(tmpDir, '.env.production.local');
  const result = runLaunchDryRun(envFile, {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'supabase-service-role-key',
    LANGGRAPH_BACKEND_URL: 'https://agent-backend.example.com',
    GITHUB_TOKEN: 'github-token',
    GITHUB_REPOSITORY: 'targix/ai-task-agent',
    WORKSPACE_ACCESS_TOKEN: 'workspace-access-token',
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.storageMode, 'supabase');
  assert.deepEqual(report.blockers, []);
  assert.ok(report.commands.some((command) => command.includes('supabase:smoke')));
  assert.equal(report.commands.some((command) => command.includes('d1:setup')), false);
});

test('production launch dry-run still blocks when no live planner provider is configured', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ai-task-agent-launch-'));
  const envFile = path.join(tmpDir, '.env.production.local');
  const result = runLaunchDryRun(envFile, {
    CLOUDFLARE_ACCOUNT_ID: 'cloudflare-account-id',
    CLOUDFLARE_D1_DATABASE_ID: 'cloudflare-d1-database-id',
    CLOUDFLARE_API_TOKEN: 'cloudflare-api-token',
    GITHUB_TOKEN: 'github-token',
    GITHUB_REPOSITORY: 'targix/ai-task-agent',
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.ok(report.blockers.some((blocker) => blocker.group === 'live-llm' && blocker.name === 'OPENROUTER_API_KEY'));
  assert.match(report.next, /one live LLM credential set/);
  assert.match(report.next, /WORKSPACE_ACCESS_TOKEN/);
});

test('production launch dry-run does not accept loopback LangGraph as a live production provider', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ai-task-agent-launch-'));
  const envFile = path.join(tmpDir, '.env.production.local');
  const result = runLaunchDryRun(envFile, {
    CLOUDFLARE_ACCOUNT_ID: 'cloudflare-account-id',
    CLOUDFLARE_D1_DATABASE_ID: 'cloudflare-d1-database-id',
    CLOUDFLARE_API_TOKEN: 'cloudflare-api-token',
    LANGGRAPH_BACKEND_URL: 'http://127.0.0.1:8000',
    GITHUB_TOKEN: 'github-token',
    GITHUB_REPOSITORY: 'targix/ai-task-agent',
    WORKSPACE_ACCESS_TOKEN: 'workspace-access-token',
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.ok(report.blockers.some((blocker) => blocker.group === 'live-llm' && blocker.name === 'OPENROUTER_API_KEY'));
  assert.match(report.next, /one live LLM credential set/);
  assert.doesNotMatch(report.next, /WORKSPACE_ACCESS_TOKEN/);
});

function runLaunchDryRun(envFile, overrides = {}) {
  return spawnSync(process.execPath, [scriptPath, `--from=${envFile}`], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...overrides,
    },
  });
}

function runEnvInit(envFile, args = []) {
  return spawnSync(process.execPath, [envInitScriptPath, `--from=${envFile}`, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    },
  });
}
