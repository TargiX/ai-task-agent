const baseUrl = requiredEnv('BASE_URL').replace(/\/$/, '');
const exportTarget = process.env.EXPORT_TARGET || 'Linear';
const requireDurable = process.env.REQUIRE_DURABLE !== '0';
const requireLiveLlm = process.env.REQUIRE_LIVE_LLM === '1';
const requireIssueExport = process.env.REQUIRE_ISSUE_EXPORT === '1';
const idea =
  process.env.SMOKE_IDEA ||
  'A customer feedback portal for SaaS teams that turns product requests into approved engineering tasks.';

const health = await getJson('/api/health');
assert(health.ok === true, 'health.ok must be true');
assert(health.service === 'ai-task-agent', 'health.service must be ai-task-agent');

const preflight = await getJson('/api/preflight');
const setupVerify = await getJson('/api/setup/verify');
assert(setupVerify.checks?.some((check) => check.id === 'api-runtime' && check.status === 'ready'), 'setup verification must prove API runtime');
assert(setupVerify.checks?.some((check) => check.id === 'storage-roundtrip'), 'setup verification must include storage roundtrip');
const integrationVerify = await getJson('/api/integrations/verify');
assert(integrationVerify.providers?.github, 'integration verifier must include GitHub');
assert(integrationVerify.providers?.linear, 'integration verifier must include Linear');
const demoReport = await getJson('/api/demo/report');
assert(demoReport.ok === true, 'demo report must be ok');
assert(demoReport.checks?.every((check) => check.status === 'ready'), 'demo report checks must all be ready');
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

await request('/api/workspace', { method: 'DELETE' });
const run = await postJson('/api/agent/run', { idea });
assert(run.prd?.title, 'agent run must create PRD');
assert(run.prd?.context?.length >= 3, 'agent run must include retrieved context');
assert(run.tasks?.length === 5, 'agent run must create exactly 5 tasks');
assert(run.runHistory?.length >= 1, 'agent run must return run history');

const runs = await getJson('/api/runs');
assert(runs.runs?.some((item) => item.runId === run.runId), 'run history endpoint must include current run');

const firstTask = run.tasks[0];
const approved = await patchJson(`/api/tasks/${encodeURIComponent(firstTask.id)}`, {
  status: 'approved',
  reviewNote: 'Production smoke approved this task.',
});
assert(approved.tasks?.some((task) => task.id === firstTask.id && task.status === 'approved'), 'task must be approved');

const issuePackage = await getJson(`/api/export-package?target=${encodeURIComponent(exportTarget)}`);
assert(issuePackage.status === 'ready', 'issue package must be ready after approval');
assert(issuePackage.payload?.length >= 1, 'issue package must include at least one issue payload');
assert(issuePackage.markdown?.includes('Production smoke approved'), 'issue package markdown must include review note');

const exported = await postJson('/api/export', { target: exportTarget });
assert(exported.exports?.[0]?.target === exportTarget, 'export target must match');
assert(exported.exports?.[0]?.payload?.length >= 1, 'export must include at least one approved issue payload');
if (requireIssueExport) {
  assert(exported.exports[0].status === 'created', `issue export must create real issues, got ${exported.exports[0].status}`);
}

const traces = await getJson('/api/traces');
assert(traces.spans?.some((span) => span.name === 'tasks.create_many'), 'trace must include task persistence');
assert(traces.spans?.some((span) => span.name.includes('issue')), 'trace must include issue export');

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl,
      runtime: health.runtime,
      environment: health.environment,
      provider: preflight.provider,
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
      tasks: run.tasks.length,
      runs: runs.runs.length,
      issuePackage: issuePackage.status,
      exportStatus: exported.exports[0].status,
      traceSpans: traces.spans.length,
    },
    null,
    2,
  ),
);

function requiredEnv(name) {
  if (!process.env[name]?.trim()) throw new Error(`Missing required env var ${name}`);
  return process.env[name].trim();
}

async function getJson(path) {
  const response = await request(path);
  return response.json();
}

async function postJson(path, body) {
  const response = await request(path, { method: 'POST', body: JSON.stringify(body) });
  return response.json();
}

async function patchJson(path, body) {
  const response = await request(path, { method: 'PATCH', body: JSON.stringify(body) });
  return response.json();
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(process.env.AUTHORIZATION ? { authorization: process.env.AUTHORIZATION } : {}),
      ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET
        ? { 'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET }
        : {}),
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${path} returned ${response.status}: ${body.slice(0, 500)}`);
  }
  return response;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
