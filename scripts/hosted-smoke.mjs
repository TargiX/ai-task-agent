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
const requireTeamWorkspace = process.env.REQUIRE_TEAM_WORKSPACE === '1';
const teamWorkspaceId = process.env.TEAM_WORKSPACE_ID?.trim() || '';
const teamWorkspaceToken = process.env.TEAM_WORKSPACE_TOKEN?.trim() || '';
const shouldSmokeTeamWorkspace = requireTeamWorkspace || Boolean(teamWorkspaceId && teamWorkspaceToken);

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

let teamWorkspace = null;
if (shouldSmokeTeamWorkspace) {
  teamWorkspace = await smokeTeamWorkspace();
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
      teamWorkspace,
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

async function smokeTeamWorkspace() {
  assert(teamWorkspaceId, 'TEAM_WORKSPACE_ID is required for private team workspace smoke');
  assert(teamWorkspaceToken, 'TEAM_WORKSPACE_TOKEN is required for private team workspace smoke');
  assert(
    transport === 'fetch' || transport === 'fixture',
    'private team workspace smoke requires HOSTED_SMOKE_TRANSPORT=fetch or fixture',
  );

  const teams = await smokeJson('/api/team/workspaces');
  assert(teams.configured === true, 'team workspace metadata must report configured=true');
  assert(
    teams.teams?.some((team) => team.id === teamWorkspaceId || teamWorkspaceId.startsWith(`${team.id}-`)),
    `team workspace metadata must include ${teamWorkspaceId} or a matching base team prefix`,
  );

  const session = await smokeJson('/api/team/session', {
    method: 'POST',
    body: { workspaceId: teamWorkspaceId, token: teamWorkspaceToken },
  });
  assert(session.ok === true, 'team workspace session must be ok');
  assert(session.access === 'guarded', 'team workspace session must return guarded access');
  assert(session.workspace?.id === teamWorkspaceId, `team workspace session id must be ${teamWorkspaceId}`);

  await smokeJson('/api/workspace', { method: 'DELETE', team: true });
  const run = await smokeJson('/api/agent/run', {
    method: 'POST',
    team: true,
    body: {
      idea:
        process.env.TEAM_SMOKE_IDEA ||
        'A private team planning workspace for SaaS operators that converts approved product requests into engineering issues.',
    },
  });
  assert(run.provider?.access === 'guarded', 'private run must return guarded provider access');
  assert(run.workspace?.team?.label, 'private run must include team metadata');
  assert(run.tasks?.length === 5, 'private team smoke must create five tasks');

  const approved = await smokeJson('/api/tasks/batch', {
    method: 'PATCH',
    team: true,
    body: {
      taskIds: run.tasks.slice(0, 2).map((task) => task.id),
      status: 'approved',
      reviewNote: 'Hosted team smoke approved these tasks for package verification.',
    },
  });
  assert(
    approved.tasks?.filter((task) => task.status === 'approved').length >= 2,
    'private team smoke must approve tasks',
  );

  const target = process.env.TEAM_EXPORT_TARGET || 'GitHub';
  const issuePackage = await smokeJson(`/api/export-package?target=${encodeURIComponent(target)}`, { team: true });
  assert(issuePackage.status === 'ready', 'private team issue package must be ready');
  assert(
    issuePackage.mode?.mode === 'real-issue-creation',
    `private team issue package must be real-issue-creation, got ${issuePackage.mode?.mode}`,
  );

  return {
    ok: true,
    workspace: teamWorkspaceId,
    team: session.team || null,
    providerAccess: run.provider.access,
    tasks: run.tasks.length,
    approved: approved.tasks.filter((task) => task.status === 'approved').length,
    issuePackage: issuePackage.status,
    mode: issuePackage.mode.mode,
  };
}

async function smokeJson(resourcePath, options = {}) {
  if (transport === 'fixture') return fixtureJson(`${options.method || 'GET'} ${resourcePath}`);
  return fetchJson(resourcePath, options);
}

async function fetchJson(resourcePath, options = {}) {
  const response = await fetch(`${baseUrl}${resourcePath}`, {
    method: options.method || 'GET',
    body: options.body ? JSON.stringify(options.body) : undefined,
    headers: {
      'content-type': 'application/json',
      ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET
        ? { 'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET }
        : {}),
      ...(process.env.WORKSPACE_ACCESS_TOKEN
        ? { 'x-ai-task-agent-access-token': process.env.WORKSPACE_ACCESS_TOKEN }
        : {}),
      ...(options.team
        ? {
            'x-ai-task-agent-workspace': teamWorkspaceId,
            'x-ai-task-agent-access-token': teamWorkspaceToken,
          }
        : {}),
      ...(options.headers || {}),
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
  const args = ['curl', resourcePath, '--deployment', baseUrl];
  if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
    args.push('--protection-bypass', process.env.VERCEL_AUTOMATION_BYPASS_SECRET);
  }
  if (process.env.WORKSPACE_ACCESS_TOKEN) {
    args.push('--', '--header', `x-ai-task-agent-access-token: ${process.env.WORKSPACE_ACCESS_TOKEN}`);
  }
  const result = spawnSync(vercelCli, args, {
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
