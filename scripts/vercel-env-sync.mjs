import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REQUIRED_ENV_VARS = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_D1_DATABASE_ID', 'CLOUDFLARE_API_TOKEN'];
const PRODUCTION_ENV_VARS = [
  ...REQUIRED_ENV_VARS,
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
const scope = args.scope || process.env.VERCEL_SCOPE || '';
const vercelCli = args.vercel || findVercelCli();
const values = {
  ...readDotEnvIfExists(envFile),
  ...pickProcessEnv(PRODUCTION_ENV_VARS),
};
const missingRequired = REQUIRED_ENV_VARS.filter((name) => !values[name]?.trim());
const present = PRODUCTION_ENV_VARS.filter((name) => values[name]?.trim());
const commands = [];

for (const environment of environments) {
  for (const name of present) {
    commands.push({ name, environment, args: vercelEnvArgs(name, environment, scope) });
  }
}

if (!apply) {
  console.log(
    JSON.stringify(
      {
        ok: missingRequired.length === 0,
        dryRun: true,
        envFile,
        environments,
        missingRequired,
        present,
        commands: commands.map((command) => `vercel ${command.args.join(' ')}`),
        next: missingRequired.length
          ? `Add ${missingRequired.join(', ')} to ${path.basename(envFile)} or the current shell.`
          : 'Run this script again with --apply to write these variables to Vercel.',
      },
      null,
      2,
    ),
  );
  process.exit(missingRequired.length ? 1 : 0);
}

if (!vercelCli) {
  throw new Error('Vercel CLI was not found. Install it or pass --vercel=/path/to/vercel.');
}
if (missingRequired.length) {
  throw new Error(`Missing required production env vars: ${missingRequired.join(', ')}`);
}

const applied = [];
for (const command of commands) {
  const result = spawnSync(vercelCli, command.args, {
    input: values[command.name],
    encoding: 'utf8',
    cwd: process.cwd(),
  });
  if (result.status !== 0) {
    throw new Error(
      `Failed to sync ${command.name} to ${command.environment}: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  applied.push({ name: command.name, environment: command.environment });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      applied,
      next: 'Redeploy after env sync, then run npm run production:smoke with BASE_URL set to the deployment URL.',
    },
    null,
    2,
  ),
);

function vercelEnvArgs(name, environment, scopeValue) {
  const command = ['env', 'add', name, environment, '--force', '--yes'];
  if (scopeValue) command.push('--scope', scopeValue);
  return command;
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
