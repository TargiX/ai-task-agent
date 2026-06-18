const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:5173').replace(/\/$/, '');
const idea =
  'A lightweight customer feedback portal for B2B SaaS teams. Users submit feature requests, product managers cluster similar ideas, and approved requests sync into engineering planning.';

const health = await getJson('/api/health');
assert(health.ok === true, 'health.ok must be true');
assert(health.service === 'ai-task-agent', 'health.service must be ai-task-agent');

const preflight = await getJson('/api/preflight');
assert(preflight.summary?.total === 6, 'preflight must report 6 checks');
assert(
  preflight.capabilities?.some((item) => item.id === 'rag-memory' && item.status === 'ready'),
  'preflight must report RAG/memory ready',
);

const setupVerify = await getJson('/api/setup/verify');
assert(setupVerify.checks?.some((check) => check.id === 'api-runtime' && check.status === 'ready'), 'setup verification must prove API runtime');
assert(setupVerify.checks?.some((check) => check.id === 'issue-package' && check.status === 'ready'), 'setup verification must prove issue package builder');
const integrationVerify = await getJson('/api/integrations/verify');
assert(integrationVerify.providers?.github, 'integration verifier must include GitHub');
assert(integrationVerify.providers?.linear, 'integration verifier must include Linear');

const demoReport = await getJson('/api/demo/report');
assert(demoReport.ok === true, 'demo report must be ok');
assert(demoReport.dryRun === true, 'demo report must be dry-run');
assert(demoReport.summary?.tasks === 5, 'demo report must create 5 tasks');
assert(demoReport.summary?.approved === 5, 'demo report must approve 5 tasks');
assert(demoReport.issuePackage?.status === 'ready', 'demo report must prepare issue package');
assert(demoReport.checks?.every((check) => check.status === 'ready'), 'demo report checks must all be ready');

const memory = await getJson('/api/memory');
assert(memory.documents?.length >= 6, 'memory corpus must include knowledge docs');

const streamResponse = await fetch(`${baseUrl}/api/agent/stream`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ idea }),
});
assert(streamResponse.ok, `agent stream returned ${streamResponse.status}`);
const streamBody = await streamResponse.text();
const events = parseSse(streamBody);
const complete = events.find((event) => event.type === 'complete');
assert(complete?.workspace?.tasks?.length === 5, 'agent stream must complete with 5 tasks');
assert(complete.workspace.runHistory?.length >= 1, 'agent stream must return run history');
assert(complete.workspace.prd?.context?.length >= 3, 'agent stream must include retrieved PRD context');
assert(
  events.filter((event) => event.type === 'log').some((event) => event.log?.label === 'memory.retrieve_context'),
  'agent stream must include memory retrieval log',
);
assert(
  events.filter((event) => event.type === 'log').some((event) => event.log?.label === 'interrupt.wait_for_human'),
  'agent stream must include human interrupt log',
);

const runs = await getJson('/api/runs');
assert(runs.runs?.length >= 1, 'run history endpoint must include at least one run');
assert(runs.runs[0].taskCount >= 5, 'run history summary must include task count');

const firstTask = complete.workspace.tasks[0];
const approved = await patchJson(`/api/tasks/${encodeURIComponent(firstTask.id)}`, {
  status: 'approved',
  reviewNote: 'HTTP smoke approved this task for issue packaging.',
});
assert(approved.tasks?.some((task) => task.id === firstTask.id && task.status === 'approved'), 'task must be approved');

const issuePackage = await getJson('/api/export-package?target=GitHub');
assert(issuePackage.status === 'ready', 'issue package must be ready after approval');
assert(issuePackage.payload?.length >= 1, 'issue package must include approved issue payload');
assert(issuePackage.markdown?.includes('HTTP smoke approved'), 'issue package markdown must include review note');

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl,
      health: { runtime: health.runtime, environment: health.environment },
      preflight: preflight.summary,
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
      streamEvents: events.length,
      tasks: complete.workspace.tasks.length,
      runs: runs.runs.length,
      issuePackage: issuePackage.status,
    },
    null,
    2,
  ),
);

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  assert(response.ok, `${path} returned ${response.status}`);
  return response.json();
}

async function patchJson(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert(response.ok, `${path} returned ${response.status}`);
  return response.json();
}

function parseSse(body) {
  return body
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      return JSON.parse(data);
    });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
