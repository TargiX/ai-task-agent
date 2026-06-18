import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLOUDFLARE_ENV_VARS = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_D1_DATABASE_ID', 'CLOUDFLARE_API_TOKEN'];
const SUPABASE_ENV_VARS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const PRODUCTION_ENV_VARS = [
  ...CLOUDFLARE_ENV_VARS,
  ...SUPABASE_ENV_VARS,
  'LANGGRAPH_BACKEND_URL',
  'OPENROUTER_API_KEY',
  'OPENROUTER_MODEL',
  'FREELLMAPI_BASE_URL',
  'FREELLMAPI_API_KEY',
  'FREELLMAPI_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'LINEAR_API_KEY',
  'LINEAR_TEAM_ID',
  'GITHUB_TOKEN',
  'GITHUB_REPOSITORY',
  'WORKSPACE_ACCESS_TOKEN',
  'PUBLIC_APP_URL',
];

const args = parseArgs(process.argv.slice(2));
const envFile = path.resolve(args.from || '.env.production.local');
const environments = String(args.env || 'preview,production')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const apply = Boolean(args.apply);
const allowPartial = Boolean(args['allow-partial']);
const scope = args.scope || process.env.VERCEL_SCOPE || '';
const gitBranch = args['git-branch'] || process.env.VERCEL_GIT_BRANCH || '';
const vercelCli = args.vercel || findVercelCli();
const requestedOnly = parseCsv(args.only);
const selectedEnvVars = requestedOnly.length
  ? PRODUCTION_ENV_VARS.filter((name) => requestedOnly.includes(name))
  : PRODUCTION_ENV_VARS;
const unknownOnly = requestedOnly.filter((name) => !PRODUCTION_ENV_VARS.includes(name));
const values = {
  ...readDotEnvIfExists(envFile),
  ...pickProcessEnv(PRODUCTION_ENV_VARS),
};
const hasCloudflare = CLOUDFLARE_ENV_VARS.every((name) => values[name]?.trim());
const hasSupabase = values.SUPABASE_URL && values.SUPABASE_SERVICE_ROLE_KEY;
const missingRequired =
  allowPartial || hasCloudflare || hasSupabase
    ? []
    : ['CLOUDFLARE_D1_DATABASE_ID or SUPABASE_URL', 'CLOUDFLARE_API_TOKEN or SUPABASE_SERVICE_ROLE_KEY'];
const missingSelected = selectedEnvVars.filter((name) => !values[name]?.trim());
const missingOnlyForPartial = allowPartial && requestedOnly.length === 0;
const present = selectedEnvVars.filter((name) => values[name]?.trim());
const commands = [];

for (const environment of environments) {
  for (const name of present) {
    commands.push({ name, environment, value: values[name], args: vercelEnvArgs(name, environment, { scope, gitBranch }) });
  }
}

if (!apply) {
  console.log(
    JSON.stringify(
      {
        ok:
          unknownOnly.length === 0 &&
          !missingOnlyForPartial &&
          missingRequired.length === 0 &&
          !(requestedOnly.length && missingSelected.length),
        dryRun: true,
        envFile,
        environments,
        gitBranch: gitBranch || null,
        allowPartial,
        only: requestedOnly,
        unknownOnly,
        missingOnlyForPartial,
        missingRequired,
        missingSelected: requestedOnly.length ? missingSelected : [],
        present,
        commands:
          unknownOnly.length || missingOnlyForPartial || (requestedOnly.length && missingSelected.length)
            ? []
            : commands.map((command) => `vercel ${command.args.join(' ')}`),
        next: unknownOnly.length
          ? `Remove unsupported env names: ${unknownOnly.join(', ')}.`
          : missingOnlyForPartial
            ? 'Pass --only=<env names> with --allow-partial so the partial sync is explicit.'
          : missingRequired.length
            ? `Add ${missingRequired.join(', ')} to ${path.basename(envFile)} or the current shell, or pass --allow-partial for a scoped sync.`
            : requestedOnly.length && missingSelected.length
              ? `Add ${missingSelected.join(', ')} to ${path.basename(envFile)} or the current shell.`
          : 'Run this script again with --apply to write these variables to Vercel.',
      },
      null,
      2,
    ),
  );
  process.exit(
    unknownOnly.length || missingOnlyForPartial || missingRequired.length || (requestedOnly.length && missingSelected.length)
      ? 1
      : 0,
  );
}

if (!vercelCli) {
  throw new Error('Vercel CLI was not found. Install it or pass --vercel=/path/to/vercel.');
}
if (unknownOnly.length) {
  throw new Error(`Unsupported env vars in --only: ${unknownOnly.join(', ')}`);
}
if (missingOnlyForPartial) {
  throw new Error('Pass --only=<env names> with --allow-partial so the partial sync is explicit.');
}
if (missingRequired.length) {
  throw new Error(`Missing required production env vars: ${missingRequired.join(', ')}`);
}
if (requestedOnly.length && missingSelected.length) {
  throw new Error(`Missing selected env vars: ${missingSelected.join(', ')}`);
}
if (!commands.length) {
  throw new Error('No present production env vars matched the sync filters.');
}

const applied = [];
for (const command of commands) {
  const result = spawnSync(vercelCli, vercelEnvArgs(command.name, command.environment, { scope, gitBranch, value: command.value }), {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
  if (result.status !== 0) {
    throw new Error(
      `Failed to sync ${command.name} to ${command.environment}: ${formatVercelEnvError(result, command)}`,
    );
  }
  applied.push({ name: command.name, environment: command.environment });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      allowPartial,
      only: requestedOnly,
      applied,
      next: 'Redeploy after env sync, then run npm run production:smoke with BASE_URL set to the deployment URL.',
    },
    null,
    2,
  ),
);

function vercelEnvArgs(name, environment, { scope: scopeValue, gitBranch: branchValue = '', value } = {}) {
  const command = ['env', 'add', name, environment, '--force', '--yes'];
  if (environment === 'preview' && branchValue) command.splice(4, 0, branchValue);
  if (value !== undefined) command.push('--value', value);
  if (scopeValue) command.push('--scope', scopeValue);
  return command;
}

function formatVercelEnvError(result, command) {
  const output = (result.stderr || result.stdout || result.error?.message || '').trim();
  const payload = parseJsonObject(output);
  if (payload?.reason === 'git_branch_required') {
    return [
      payload.message,
      'Preview env sync needs a Git-connected Vercel project or an explicit --git-branch on projects connected to Git.',
      'For this Gitless local-deploy project, use --env=production for production env vars, or connect a Git repository before syncing Preview env vars.',
    ].join(' ');
  }
  if (/does not have a connected Git repository/i.test(payload?.message || output) && command.environment === 'preview') {
    return [
      payload?.message || output,
      'Preview env vars require a connected Git repository on this Vercel project. Use --env=production or connect Git before syncing Preview env vars.',
    ].join(' ');
  }
  return output || `vercel env add exited with status ${result.status}`;
}

function readDotEnvIfExists(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const values = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equalsAt = trimmed.indexOf('=');
    if (equalsAt <= 0) continue;
    const key = trimmed.slice(0, equalsAt).trim();
    values[key] = unquote(trimmed.slice(equalsAt + 1).trim());
  }
  return values;
}

function pickProcessEnv(names) {
  return Object.fromEntries(names.filter((name) => process.env[name]?.trim()).map((name) => [name, process.env[name]]));
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function findVercelCli() {
  const candidates = [
    'vercel',
    path.join(process.env.HOME || '', 'Library', 'pnpm', 'bin', 'vercel'),
    '/opt/homebrew/bin/vercel',
    '/usr/local/bin/vercel',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (result.status === 0) return candidate;
  }
  return '';
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

function parseCsv(value) {
  if (!value || value === true) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseJsonObject(output) {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(output.slice(start, end + 1));
  } catch {
    return null;
  }
}
