import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const scriptPath = path.resolve('scripts/vercel-env-sync.mjs');

test('vercel env sync supports scoped partial dry-run without durable storage', async () => {
  const { envFile } = await writeEnvFile('WORKSPACE_ACCESS_TOKEN=secret-token\n');
  const result = runEnvSync([
    `--from=${envFile}`,
    '--allow-partial',
    '--only=WORKSPACE_ACCESS_TOKEN',
    '--env=preview',
    '--scope=targixs-projects',
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes('secret-token'), false);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.allowPartial, true);
  assert.deepEqual(report.only, ['WORKSPACE_ACCESS_TOKEN']);
  assert.deepEqual(report.missingRequired, []);
  assert.deepEqual(report.present, ['WORKSPACE_ACCESS_TOKEN']);
  assert.equal(report.commands.length, 1);
  assert.match(report.commands[0], /env add WORKSPACE_ACCESS_TOKEN preview/);
});

test('vercel env sync includes git branch for preview env when requested', async () => {
  const { envFile } = await writeEnvFile('WORKSPACE_ACCESS_TOKEN=secret-token\n');
  const result = runEnvSync([
    `--from=${envFile}`,
    '--allow-partial',
    '--only=WORKSPACE_ACCESS_TOKEN',
    '--env=preview',
    '--git-branch=main',
  ]);

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.gitBranch, 'main');
  assert.match(report.commands[0], /env add WORKSPACE_ACCESS_TOKEN preview main/);
});

test('vercel env sync remains strict without allow-partial', async () => {
  const { envFile } = await writeEnvFile('WORKSPACE_ACCESS_TOKEN=secret-token\n');
  const result = runEnvSync([`--from=${envFile}`, '--only=WORKSPACE_ACCESS_TOKEN']);

  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.missingRequired, [
    'CLOUDFLARE_D1_DATABASE_ID or SUPABASE_URL',
    'CLOUDFLARE_API_TOKEN or SUPABASE_SERVICE_ROLE_KEY',
  ]);
  assert.match(report.next, /allow-partial/);
});

test('vercel env sync requires --only for partial mode', async () => {
  const { envFile } = await writeEnvFile('WORKSPACE_ACCESS_TOKEN=secret-token\nOPENAI_MODEL=gpt-4.1\n');
  const result = runEnvSync([`--from=${envFile}`, '--allow-partial']);

  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.missingOnlyForPartial, true);
  assert.deepEqual(report.commands, []);
  assert.match(report.next, /--only/);
});

test('vercel env sync apply sends only selected variables and does not print values', async () => {
  const { tmpDir, envFile } = await writeEnvFile('WORKSPACE_ACCESS_TOKEN=secret-token\nOPENAI_MODEL=gpt-4.1\n');
  const logFile = path.join(tmpDir, 'fake-vercel-log.jsonl');
  const fakeVercel = path.join(tmpDir, 'fake-vercel.mjs');
  await writeFile(
    fakeVercel,
    `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(process.env.FAKE_VERCEL_LOG, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
`,
    'utf8',
  );
  await chmod(fakeVercel, 0o755);

  const result = runEnvSync(
    [
      `--from=${envFile}`,
      '--allow-partial',
      '--only=WORKSPACE_ACCESS_TOKEN',
      '--env=preview',
      '--apply',
      `--vercel=${fakeVercel}`,
    ],
    { FAKE_VERCEL_LOG: logFile },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes('secret-token'), false);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.applied, [{ name: 'WORKSPACE_ACCESS_TOKEN', environment: 'preview' }]);
  const log = (await readFile(logFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(log.length, 1);
  assert.deepEqual(log[0].argv.slice(0, 4), ['env', 'add', 'WORKSPACE_ACCESS_TOKEN', 'preview']);
  assert.ok(log[0].argv.includes('--value'));
  assert.equal(log[0].argv[log[0].argv.indexOf('--value') + 1], 'secret-token');
});

test('vercel env sync explains Gitless preview env failures', async () => {
  const { tmpDir, envFile } = await writeEnvFile('WORKSPACE_ACCESS_TOKEN=secret-token\n');
  const fakeVercel = path.join(tmpDir, 'fake-vercel.mjs');
  await writeFile(
    fakeVercel,
    `#!/usr/bin/env node
console.error(JSON.stringify({
  status: 'action_required',
  reason: 'git_branch_required',
  message: 'Add WORKSPACE_ACCESS_TOKEN to which Git branch for Preview?'
}));
process.exit(1);
`,
    'utf8',
  );
  await chmod(fakeVercel, 0o755);

  const result = runEnvSync([
    `--from=${envFile}`,
    '--allow-partial',
    '--only=WORKSPACE_ACCESS_TOKEN',
    '--env=preview',
    '--apply',
    `--vercel=${fakeVercel}`,
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Git-connected Vercel project/);
  assert.match(result.stderr, /--env=production/);
  assert.equal(result.stderr.includes('secret-token'), false);
});

async function writeEnvFile(contents) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ai-task-agent-vercel-env-'));
  const envFile = path.join(tmpDir, '.env.production.local');
  await writeFile(envFile, contents, 'utf8');
  return { tmpDir, envFile };
}

function runEnvSync(args, extraEnv = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...extraEnv,
    },
  });
}
