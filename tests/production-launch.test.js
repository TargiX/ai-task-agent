import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const scriptPath = path.resolve('scripts/production-launch.mjs');

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
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.blockers, []);
  assert.deepEqual(report.acceptedSecretSets.liveLlm.at(-1), ['LANGGRAPH_BACKEND_URL']);
  assert.ok(report.commands.some((command) => command.includes('d1:setup')));
  assert.ok(report.commands.some((command) => command.includes('vercel deploy')));
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
