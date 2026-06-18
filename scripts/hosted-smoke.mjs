import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';

const baseUrl = requiredEnv('BASE_URL').replace(/\/$/, '');
const transport = process.env.HOSTED_SMOKE_TRANSPORT || (isVercelUrl(baseUrl) ? 'vercel-curl' : 'fetch');
const vercelCli = process.env.VERCEL_CLI || findVercelCli();
const requireDurable = process.env.REQUIRE_DURABLE !== '0';
const requireLiveLlm = process.env.REQUIRE_LIVE_LLM === '1';
const requireIssueExport = process.env.REQUIRE_ISSUE_EXPORT === '1';
const requireAccessGuard = process.env.REQUIRE_ACCESS_GUARD === '1';
const requireVercelRuntime = process.env.REQUIRE_VERCEL_RUNTIME === '1' || isVercelUrl(baseUrl);

const health = await getJson('/api/health');
assert(health.ok === true, 'health.ok must be true');
assert(health.service === 'ai-task-agent', 'health.service must be ai-task-agent');
if (requireVercelRuntime) {
  assert(health.runtime === 'vercel', `runtime must be vercel, got ${health.runtime}`);
}

const preflight = await getJson('/api/preflight');
const setupVerify = await getJson('/api/setup/verify');
const integrationVerify = await getJson('/api/integrations/verify');
const demoReport = await getJson('/api/demo/report');
const freeModels = await getJson('/api/llm/free-models');

assert(setupVerify.checks?.some((check) => check.id === 'api-runtime' && check.status === 'ready'), 'setup verification must prove API runtime');
assert(setupVerify.checks?.some((check) => check.id === 'storage-roundtrip'), 'setup verification must include storage roundtrip');
assert(setupVerify.checks?.some((check) => check.id === 'issue-package' && check.status === 'ready'), 'setup verification must prove issue package generation');
assert(integrationVerify.providers?.github, 'integration verifier must include GitHub');
assert(integrationVerify.providers?.linear, 'integration verifier must include Linear');
assert(demoReport.ok === true, 'demo report must be ok');
assert(demoReport.checks?.every((check) => check.status === 'ready'), 'demo report checks must all be ready');
assertCapability(preflight, 'idea-to-prd', 'ready');
assertCapability(preflight, 'task-breakdown', 'ready');
assertCapability(preflight, 'tool-calling', 'ready');
assertCapability(preflight, 'human-approval', 'ready');
assertCapability(preflight, 'workspace-isolation', 'ready');

if (requireDurable) {
  assert(
    ['supabase', 'cloudflare-d1'].includes(preflight.provider?.storage),
    `production storage must be durable, got ${preflight.provider?.storage}`,
  );
  assert(
    setupVerify.checks?.some((check) => check.id === 'storage-roundtrip' && check.status === 'ready'),
    'setup verification storage roundtrip must be ready when durable storage is required',
  );
}
if (requireLiveLlm) {
  assert(preflight.provider?.ai !== 'local-planner', 'production LLM provider must not be local-planner');
}
if (requireIssueExport) {
  assert(
    preflight.provider?.linear === 'configured' || preflight.provider?.github === 'configured',
    'at least one issue export provider must be configured',
  );
  assert(integrationVerify.ok === true, 'at least one issue export provider must pass read-only verification');
}
if (requireAccessGuard) {
  assert(preflight.provider?.access === 'guarded', 'workspace access guard must be configured');
}

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl,
      transport,
      runtime: health.runtime,
      environment: health.environment,
      provider: preflight.provider,
      readiness: preflight.summary,
      setupVerification: setupVerify.summary,
      integrationVerifier: {
        ok: integrationVerify.ok,
        configured: integrationVerify.configured,
      },
      demoReport: {
        tasks: demoReport.summary.tasks,
        approved: demoReport.summary.approved,
        traceSpans: demoReport.summary.traceSpans,
      },
      freeModels: {
        count: freeModels.models?.length || 0,
        sources: freeModels.sources || [],
      },
    },
    null,
    2,
  ),
);

async function getJson(resourcePath) {
  if (transport === 'fetch') return fetchJson(resourcePath);
  if (transport === 'vercel-curl') return vercelCurlJson(resourcePath);
  if (transport === 'fixture') return fixtureJson(resourcePath);
  throw new Error(`Unsupported HOSTED_SMOKE_TRANSPORT=${transport}`);
}

async function fetchJson(resourcePath) {
  const response = await fetch(`${baseUrl}${resourcePath}`, {
    headers: {
      ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET
        ? { 'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET }
        : {}),
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${resourcePath} returned ${response.status}: ${body.slice(0, 500)}`);
  }
  return response.json();
}

function vercelCurlJson(resourcePath) {
  if (!vercelCli) throw new Error('Vercel CLI was not found for protected hosted smoke.');
  const result = spawnSync(vercelCli, ['curl', `${baseUrl}${resourcePath}`], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`vercel curl ${resourcePath} failed: ${(result.stderr || result.stdout || result.error?.message || '').trim()}`);
  }
  return parseJsonFromCliOutput(result.stdout || '');
}

async function fixtureJson(resourcePath) {
  const fixturePath = requiredEnv('HOSTED_SMOKE_FIXTURE');
  const fixtures = JSON.parse(await fsp.readFile(fixturePath, 'utf8'));
  const payload = fixtures[resourcePath];
  if (!payload) throw new Error(`No hosted smoke fixture for ${resourcePath}`);
  return payload;
}

function parseJsonFromCliOutput(output) {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error(`No JSON response found in vercel curl output: ${output.slice(0, 500)}`);
  }
  return JSON.parse(output.slice(start, end + 1));
}

function assertCapability(preflight, id, expectedStatus) {
  const capability = preflight.capabilities?.find((item) => item.id === id);
  assert(capability?.status === expectedStatus, `${id} capability must be ${expectedStatus}`);
}

function requiredEnv(name) {
  if (!process.env[name]?.trim()) throw new Error(`Missing required env var ${name}`);
  return process.env[name].trim();
}

function isVercelUrl(value) {
  try {
    return new URL(value).hostname.endsWith('.vercel.app');
  } catch {
    return false;
  }
}

function findVercelCli() {
  const candidates = [
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
