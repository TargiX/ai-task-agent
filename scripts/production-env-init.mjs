import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const envFile = path.resolve(args.from || '.env.production.local');
const templateFile = path.resolve(args.template || '.env.example');
const dryRun = Boolean(args['dry-run']);
const rotateWorkspaceToken = Boolean(args['rotate-workspace-token']);
const generateWorkspaceToken = rotateWorkspaceToken || Boolean(args['generate-workspace-token']);
const tokenBytes = Number(args['token-bytes'] || 32);
const UNSAFE_PRODUCTION_DEFAULTS = {
  LANGGRAPH_BACKEND_URL: new Set(['http://127.0.0.1:8000', 'http://localhost:8000']),
  PUBLIC_APP_URL: new Set(['http://localhost:5173', 'http://127.0.0.1:5173']),
  GITHUB_REPOSITORY: new Set(['owner/repo']),
};

const template = readDotEnvLines(templateFile);
const existing = fs.existsSync(envFile) ? readDotEnvLines(envFile) : [];
const merged = mergeTemplate(existing, template);
const beforeValues = valuesFromLines(merged);
const generated = [];
const updated = [];

for (const line of merged) {
  if (isUnsafeProductionDefault(line.key, line.value)) {
    setLineValue(line, '');
  }
}

if (generateWorkspaceToken) {
  upsertValue(merged, 'WORKSPACE_ACCESS_TOKEN', `wat_${crypto.randomBytes(tokenBytes).toString('base64url')}`);
  generated.push('WORKSPACE_ACCESS_TOKEN');
}

const afterValues = valuesFromLines(merged);
for (const key of Object.keys(afterValues)) {
  if ((beforeValues[key] || '') !== (afterValues[key] || '') && !generated.includes(key)) {
    updated.push(key);
  }
}

if (!dryRun) {
  await fsp.mkdir(path.dirname(envFile), { recursive: true });
  await fsp.writeFile(envFile, `${merged.map((line) => line.raw).join('\n').replace(/\n*$/, '')}\n`);
}

const readiness = productionReadiness(afterValues);
console.log(
  JSON.stringify(
    {
      ok: readiness.missingExternal.length === 0,
      dryRun,
      envFile,
      created: !existing.length && !dryRun,
      generated,
      updated,
      readiness,
      next: readiness.missingExternal.length
        ? 'Fill the missing external credential groups, then run npm run production:launch.'
        : 'Run npm run production:launch -- --apply to verify, sync Vercel env, and deploy.',
    },
    null,
    2,
  ),
);

function productionReadiness(values) {
  const hasCloudflareRuntime =
    has(values, 'CLOUDFLARE_ACCOUNT_ID') && has(values, 'CLOUDFLARE_D1_DATABASE_ID') && has(values, 'CLOUDFLARE_API_TOKEN');
  const hasCloudflareCreate = has(values, 'CLOUDFLARE_ACCOUNT_ID') && has(values, 'CLOUDFLARE_API_TOKEN');
  const hasSupabase = has(values, 'SUPABASE_URL') && has(values, 'SUPABASE_SERVICE_ROLE_KEY');
  const hasLiveLlm =
    hasProductionLangGraph(values) ||
    has(values, 'OPENROUTER_API_KEY') ||
    has(values, 'OPENAI_API_KEY') ||
    (has(values, 'FREELLMAPI_BASE_URL') && has(values, 'FREELLMAPI_API_KEY'));
  const hasIssueExport =
    (has(values, 'LINEAR_API_KEY') && has(values, 'LINEAR_TEAM_ID')) ||
    (has(values, 'GITHUB_TOKEN') && has(values, 'GITHUB_REPOSITORY'));

  const missingExternal = [];
  if (!(hasCloudflareRuntime || hasCloudflareCreate || hasSupabase)) {
    missingExternal.push({
      group: 'durable-storage',
      accepted: [
        ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'],
        ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_D1_DATABASE_ID', 'CLOUDFLARE_API_TOKEN'],
        ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
      ],
    });
  }
  if (!hasLiveLlm) {
    missingExternal.push({
      group: 'live-llm',
      accepted: [
        ['OPENROUTER_API_KEY'],
        ['FREELLMAPI_BASE_URL', 'FREELLMAPI_API_KEY'],
        ['OPENAI_API_KEY'],
        ['LANGGRAPH_BACKEND_URL'],
      ],
    });
  }
  if (!hasIssueExport) {
    missingExternal.push({
      group: 'issue-export',
      accepted: [
        ['GITHUB_TOKEN', 'GITHUB_REPOSITORY'],
        ['LINEAR_API_KEY', 'LINEAR_TEAM_ID'],
      ],
    });
  }

  return {
    workspaceAccess:
      has(values, 'WORKSPACE_ACCESS_TOKEN') || has(values, 'TEAM_WORKSPACES') || has(values, 'WORKSPACE_TEAM_TOKENS')
        ? 'guarded'
        : 'demo-open',
    durableStorage: hasCloudflareRuntime ? 'cloudflare-d1' : hasCloudflareCreate ? 'cloudflare-d1-create' : hasSupabase ? 'supabase' : 'missing',
    liveLlm: hasProductionLangGraph(values)
      ? 'langgraph'
      : has(values, 'OPENROUTER_API_KEY')
        ? 'openrouter'
        : has(values, 'FREELLMAPI_BASE_URL') && has(values, 'FREELLMAPI_API_KEY')
          ? 'freellmapi'
          : has(values, 'OPENAI_API_KEY')
            ? 'openai'
            : 'missing',
    issueExport: has(values, 'GITHUB_TOKEN') && has(values, 'GITHUB_REPOSITORY')
      ? 'github'
      : has(values, 'LINEAR_API_KEY') && has(values, 'LINEAR_TEAM_ID')
        ? 'linear'
        : 'missing',
    missingExternal,
  };
}

function mergeTemplate(existing, template) {
  if (!existing.length) return template.map((line) => ({ ...line }));
  const existingKeys = new Set(existing.map((line) => line.key).filter(Boolean));
  const next = existing.map((line) => ({ ...line }));
  const missingTemplateLines = template.filter((line) => line.key && !existingKeys.has(line.key));
  if (missingTemplateLines.length) {
    if (next.length && next.at(-1).raw.trim()) next.push({ raw: '' });
    next.push({ raw: '# Added by production env init' });
    next.push(...missingTemplateLines.map((line) => ({ ...line })));
  }
  return next;
}

function upsertValue(lines, key, value) {
  const quoted = quoteEnvValue(value);
  const match = lines.find((line) => line.key === key);
  if (match) {
    setLineValue(match, value);
    return;
  }
  if (lines.length && lines.at(-1).raw.trim()) lines.push({ raw: '' });
  lines.push({ raw: `${key}=${quoted}`, key, value });
}

function setLineValue(line, value) {
  line.raw = `${line.key}=${quoteEnvValue(value)}`;
  line.value = value;
}

function readDotEnvLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).map((raw) => {
    const trimmed = raw.trim();
    const equalsAt = trimmed.indexOf('=');
    if (!trimmed || trimmed.startsWith('#') || equalsAt <= 0) return { raw };
    const key = trimmed.slice(0, equalsAt).trim();
    const value = unquoteEnvValue(trimmed.slice(equalsAt + 1).trim());
    return { raw, key, value };
  });
}

function valuesFromLines(lines) {
  return Object.fromEntries(lines.filter((line) => line.key).map((line) => [line.key, line.value ?? '']));
}

function has(values, key) {
  return Boolean(values[key]?.trim());
}

function hasProductionLangGraph(values) {
  return has(values, 'LANGGRAPH_BACKEND_URL') && !isLoopbackUrl(values.LANGGRAPH_BACKEND_URL);
}

function isLoopbackUrl(value) {
  try {
    const url = new URL(value);
    return ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function isUnsafeProductionDefault(key, value) {
  return Boolean(key && UNSAFE_PRODUCTION_DEFAULTS[key]?.has(value || ''));
}

function quoteEnvValue(value) {
  const stringValue = String(value ?? '');
  if (!stringValue) return '';
  if (/[\s"'#]/.test(stringValue)) return JSON.stringify(stringValue);
  return stringValue;
}

function unquoteEnvValue(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
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
