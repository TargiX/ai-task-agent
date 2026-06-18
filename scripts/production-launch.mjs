import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = parseArgs(process.argv.slice(2));
const apply = Boolean(args.apply);
const scope = args.scope || process.env.VERCEL_SCOPE || 'targixs-projects';
const envFile = path.resolve(args.from || '.env.production.local');
const values = {
  ...readDotEnvIfExists(envFile),
  ...pickProcessEnv([
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_D1_DATABASE_ID',
    'CLOUDFLARE_API_TOKEN',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'LANGGRAPH_BACKEND_URL',
    'OPENROUTER_API_KEY',
    'FREELLMAPI_BASE_URL',
    'FREELLMAPI_API_KEY',
    'OPENAI_API_KEY',
    'LINEAR_API_KEY',
    'LINEAR_TEAM_ID',
    'GITHUB_TOKEN',
    'GITHUB_REPOSITORY',
    'WORKSPACE_ACCESS_TOKEN',
    'VERCEL_AUTOMATION_BYPASS_SECRET',
  ]),
};
const hasCloudflareRuntime =
  values.CLOUDFLARE_ACCOUNT_ID && values.CLOUDFLARE_D1_DATABASE_ID && values.CLOUDFLARE_API_TOKEN;
const hasCloudflareCreate = values.CLOUDFLARE_ACCOUNT_ID && values.CLOUDFLARE_API_TOKEN;
const hasSupabaseRuntime = values.SUPABASE_URL && values.SUPABASE_SERVICE_ROLE_KEY;
const storageMode = hasSupabaseRuntime ? 'supabase' : 'cloudflare-d1';
const missing = {
  workspaceAccess: ['WORKSPACE_ACCESS_TOKEN'].filter((name) => !values[name]?.trim()),
  durableStorage: hasCloudflareRuntime || hasCloudflareCreate || hasSupabaseRuntime ? [] : ['DURABLE_STORAGE'],
  liveLlm:
    hasProductionLangGraph(values.LANGGRAPH_BACKEND_URL) ||
    values.OPENROUTER_API_KEY ||
    values.OPENAI_API_KEY ||
    (values.FREELLMAPI_BASE_URL && values.FREELLMAPI_API_KEY)
      ? []
      : ['OPENROUTER_API_KEY'],
  issueExport:
    (values.LINEAR_API_KEY && values.LINEAR_TEAM_ID) || (values.GITHUB_TOKEN && values.GITHUB_REPOSITORY)
      ? []
      : ['LINEAR_API_KEY', 'LINEAR_TEAM_ID', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY'],
};
const blockers = [
  ...missing.workspaceAccess.map((name) => ({ group: 'workspace-access', name })),
  ...missing.durableStorage.map((name) => ({ group: 'durable-storage', name })),
  ...missing.liveLlm.map((name) => ({ group: 'live-llm', name })),
  ...missing.issueExport.map((name) => ({ group: 'issue-export', name })),
];
const acceptedSecretSets = {
  workspaceAccess: [['WORKSPACE_ACCESS_TOKEN']],
  durableStorage: [
    ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_D1_DATABASE_ID', 'CLOUDFLARE_API_TOKEN'],
    ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'],
    ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
  ],
  cloudflareCreate: [['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']],
  cloudflareRuntime: [['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_D1_DATABASE_ID', 'CLOUDFLARE_API_TOKEN']],
  liveLlm: [
    ['OPENROUTER_API_KEY'],
    ['FREELLMAPI_BASE_URL', 'FREELLMAPI_API_KEY'],
    ['OPENAI_API_KEY'],
    ['LANGGRAPH_BACKEND_URL'],
  ],
  issueExport: [
    ['LINEAR_API_KEY', 'LINEAR_TEAM_ID'],
    ['GITHUB_TOKEN', 'GITHUB_REPOSITORY'],
  ],
};
const basePlan = [
  ['npm', ['test']],
  ['npm', ['run', 'backend:test']],
  ['npm', ['run', 'eval:agent']],
  ['npm', ['run', 'build']],
];
const storagePlan =
  storageMode === 'supabase'
    ? [['npm', ['run', 'supabase:smoke']]]
    : [
        ['npm', ['run', 'd1:setup', '--', '--name=ai-task-agent', '--location=apac', '--write-env']],
        ['npm', ['run', 'd1:smoke']],
      ];
const plan = [
  ...basePlan,
  ...storagePlan,
  ['npm', ['run', 'vercel:env:sync', '--', '--apply', `--scope=${scope}`]],
  [findVercelCli(), ['deploy', '--yes', '--scope', scope]],
];
const hostedSmokePreviewCommand =
  'BASE_URL=<deployment-url> REQUIRE_DURABLE=1 REQUIRE_LIVE_LLM=1 REQUIRE_ISSUE_EXPORT=1 REQUIRE_ACCESS_GUARD=1 npm run hosted:smoke';

if (!apply) {
  console.log(
    JSON.stringify(
      {
        ok: blockers.length === 0,
        dryRun: true,
        envFile,
        scope,
        storageMode,
        blockers,
        acceptedSecretSets,
        commands: [...plan.map(([command, commandArgs]) => `${command} ${commandArgs.join(' ')}`), hostedSmokePreviewCommand],
        next: blockers.length ? formatMissingNext(blockers) : 'Run npm run production:launch -- --apply to execute this release path.',
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (blockers.length) {
  throw new Error(`Missing production launch secrets: ${blockers.map((item) => item.name).join(', ')}`);
}

const completed = [];
let deploymentUrl = '';
for (const [command, commandArgs] of plan) {
  if (!command) throw new Error('Vercel CLI was not found.');
  const result = run(command, commandArgs);
  completed.push({ command: `${command} ${commandArgs.join(' ')}`, status: result.status });
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  deploymentUrl = deploymentUrl || findDeploymentUrl(result.stdout);
}

let hostedSmoke = null;
if (deploymentUrl && !args['skip-hosted-smoke']) {
  const smokeEnv = {
    ...process.env,
    BASE_URL: deploymentUrl,
    REQUIRE_DURABLE: '1',
    REQUIRE_LIVE_LLM: '1',
    REQUIRE_ISSUE_EXPORT: '1',
    REQUIRE_ACCESS_GUARD: '1',
  };
  const result = run(process.execPath, ['scripts/hosted-smoke.mjs'], { env: smokeEnv });
  const command = `BASE_URL=${deploymentUrl} REQUIRE_DURABLE=1 REQUIRE_LIVE_LLM=1 REQUIRE_ISSUE_EXPORT=1 REQUIRE_ACCESS_GUARD=1 npm run hosted:smoke`;
  completed.push({ command, status: result.status });
  if (result.status !== 0) {
    throw new Error(`${command} failed:\n${result.stderr || result.stdout}`);
  }
  hostedSmoke = parseJsonObject(result.stdout);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      completed,
      deploymentUrl,
      hostedSmoke,
      next: deploymentUrl
        ? `Hosted smoke passed for ${deploymentUrl}. Run BASE_URL=${deploymentUrl} npm run production:smoke for the full mutating workflow when auth/bypass access is available.`
        : 'Run production smoke against the deployed URL.',
    },
    null,
    2,
  ),
);

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: process.cwd(),
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || result.error?.message || '',
  };
}

function readDotEnvIfExists(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const valuesFromFile = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equalsAt = trimmed.indexOf('=');
    if (equalsAt <= 0) continue;
    const key = trimmed.slice(0, equalsAt).trim();
    valuesFromFile[key] = unquoteEnvValue(trimmed.slice(equalsAt + 1).trim());
  }
  return valuesFromFile;
}

function pickProcessEnv(names) {
  return Object.fromEntries(names.filter((name) => process.env[name]?.trim()).map((name) => [name, process.env[name]]));
}

function unquoteEnvValue(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function hasProductionLangGraph(value) {
  if (!value?.trim()) return false;
  try {
    const url = new URL(value);
    return !['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function findVercelCli() {
  const candidates = [
    process.env.VERCEL_CLI,
    path.join(process.env.HOME || '', 'Library', 'pnpm', 'bin', 'vercel'),
    'vercel',
    '/opt/homebrew/bin/vercel',
    '/usr/local/bin/vercel',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (result.status === 0) return candidate;
  }
  return '';
}

function findDeploymentUrl(output) {
  const jsonUrl = output.match(/"url":\s*"(https:\/\/[^"]+\.vercel\.app)"/)?.[1];
  if (jsonUrl) return jsonUrl;
  return output.match(/https:\/\/[a-z0-9-]+\.vercel\.app/i)?.[0] || '';
}

function parseJsonObject(output) {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return JSON.parse(output.slice(start, end + 1));
}

function formatMissingNext(items) {
  const groups = new Set(items.map((item) => item.group));
  const parts = [];
  if (groups.has('workspace-access')) parts.push('WORKSPACE_ACCESS_TOKEN');
  if (groups.has('durable-storage')) parts.push('durable storage credentials');
  if (groups.has('live-llm')) parts.push('one live LLM credential set');
  if (groups.has('issue-export')) parts.push('one issue export credential set');
  return `Fill ${parts.join(', ')}, then rerun npm run production:launch -- --apply.`;
}

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [key, value] = arg.slice(2).split('=');
    parsed[key] = value ?? true;
  }
  return parsed;
}
