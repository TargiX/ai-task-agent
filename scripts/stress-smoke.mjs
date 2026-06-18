const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:5173').replace(/\/$/, '');
const idea =
  'A stress-tested AI task agent for SaaS teams that turns product ideas into PRDs, approvals, and issue exports.';

const before = await getJson('/api/health');
assert(before.ok === true, 'health must pass before stress run');

await request('/api/workspace', { method: 'DELETE' });

const jobs = [
  ...Array.from({ length: 4 }, (_, index) =>
    postJson('/api/agent/run', {
      idea: `${idea} Parallel JSON run ${index + 1}.`,
    }).then((body) => ({ type: 'run', body })),
  ),
  ...Array.from({ length: 3 }, (_, index) =>
    postStream('/api/agent/stream', {
      idea: `${idea} Parallel stream run ${index + 1}.`,
    }).then((events) => ({ type: 'stream', events })),
  ),
  getJson('/api/demo/report').then((body) => ({ type: 'demo', body })),
  getJson('/api/setup/verify').then((body) => ({ type: 'verify', body })),
  getJson('/api/preflight').then((body) => ({ type: 'preflight', body })),
];

const results = await Promise.all(jobs);
const runs = results.filter((result) => result.type === 'run');
const streams = results.filter((result) => result.type === 'stream');
const demo = results.find((result) => result.type === 'demo')?.body;
const verify = results.find((result) => result.type === 'verify')?.body;

assert(runs.every((result) => result.body.tasks?.length === 5), 'parallel JSON runs must create 5 tasks');
assert(
  streams.every((result) => result.events.some((event) => event.type === 'complete' && event.workspace?.tasks?.length === 5)),
  'parallel stream runs must complete with 5 tasks',
);
assert(demo?.ok === true && demo.summary?.approved === 5, 'demo report must remain healthy during stress');
assert(verify?.checks?.some((check) => check.id === 'api-runtime' && check.status === 'ready'), 'setup verify must pass runtime check');

const history = await getJson('/api/runs');
assert(history.runs?.length >= 7, 'run history must include stress-created runs');

const after = await getJson('/api/health');
assert(after.ok === true, 'health must pass after stress run');

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl,
      jsonRuns: runs.length,
      streamRuns: streams.length,
      runHistory: history.runs.length,
      demoReport: {
        tasks: demo.summary.tasks,
        approved: demo.summary.approved,
        traceSpans: demo.summary.traceSpans,
      },
      setupVerification: verify.summary,
    },
    null,
    2,
  ),
);

async function getJson(path) {
  const response = await request(path);
  return response.json();
}

async function postJson(path, body) {
  const response = await request(path, { method: 'POST', body: JSON.stringify(body) });
  return response.json();
}

async function postStream(path, body) {
  const response = await request(path, { method: 'POST', body: JSON.stringify(body) });
  const streamBody = await response.text();
  return parseSse(streamBody);
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${path} returned ${response.status}: ${body.slice(0, 500)}`);
  }
  return response;
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
  if (!condition) throw new Error(message);
}
