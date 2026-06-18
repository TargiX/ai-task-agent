import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { handleApiRequest } from '../lib/api-core.js';
import { streamAgentRun } from '../lib/agent-stream.js';

const idea =
  'A lightweight customer feedback portal for B2B SaaS teams. Users submit feature requests, product managers cluster similar ideas, and approved requests sync into engineering planning.';

test('agent workflow creates PRD/tasks, enforces approval, then exports issues', async () => {
  await isolateJsonStorage();

  const invalidRun = await handleApiRequest({
    method: 'POST',
    pathname: '/api/agent/run',
    body: { idea: 'too short' },
  });
  assert.equal(invalidRun.status, 400);

  const reset = await handleApiRequest({ method: 'DELETE', pathname: '/api/workspace' });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.tasks.length, 0);

  const preflight = await handleApiRequest({ method: 'GET', pathname: '/api/preflight' });
  assert.equal(preflight.status, 200);
  assert.equal(preflight.body.summary.total, 5);
  assert.equal(preflight.body.checks.find((check) => check.id === 'agent-runtime').status, 'ready');
  assert.equal(preflight.body.checks.find((check) => check.id === 'ai-provider').status, 'fallback');
  assert.equal(preflight.body.checks.find((check) => check.id === 'storage').status, 'fallback');
  assert.equal(preflight.body.capabilities.find((item) => item.id === 'idea-to-prd').status, 'ready');
  assert.equal(preflight.body.capabilities.find((item) => item.id === 'human-approval').status, 'ready');
  assert.equal(preflight.body.capabilities.find((item) => item.id === 'langgraph-backend').status, 'fallback');
  assert.equal(preflight.body.capabilities.find((item) => item.id === 'rag-memory').status, 'ready');
  assert.equal(preflight.body.capabilities.find((item) => item.id === 'evals-tracing').status, 'ready');
  assert.equal(preflight.body.capabilities.find((item) => item.id === 'external-tracing').status, 'ready');
  assert.equal(preflight.body.capabilities.find((item) => item.id === 'workspace-isolation').status, 'ready');
  assert.equal(preflight.body.setup.productionReady, false);
  assert.equal(preflight.body.setup.groups.find((group) => group.id === 'durable-storage').active, 'json');
  assert.ok(
    preflight.body.setup.groups
      .find((group) => group.id === 'durable-storage')
      .commands.some((command) => command.includes('d1:setup')),
  );
  assert.ok(preflight.body.setup.missingRequired.includes('CLOUDFLARE_D1_DATABASE_ID'));
  assert.deepEqual(preflight.body.setup.acceptedSecretSets.liveLlm[0], ['OPENROUTER_API_KEY']);
  assert.deepEqual(preflight.body.setup.acceptedSecretSets.issueExport[1], [
    'GITHUB_TOKEN',
    'GITHUB_REPOSITORY',
  ]);
  assert.ok(preflight.body.setup.launchChecklist.some((item) => item.includes('production:launch')));
  assert.match(preflight.body.setup.launchCommand, /production:launch/);

  const setupVerify = await handleApiRequest({ method: 'GET', pathname: '/api/setup/verify' });
  assert.equal(setupVerify.status, 200);
  assert.equal(setupVerify.body.provider.storage, 'json');
  assert.ok(setupVerify.body.checks.some((check) => check.id === 'api-runtime' && check.status === 'ready'));
  assert.ok(setupVerify.body.checks.some((check) => check.id === 'storage-roundtrip' && check.status === 'fallback'));
  assert.ok(setupVerify.body.checks.some((check) => check.id === 'planner-provider' && check.status === 'fallback'));
  assert.ok(setupVerify.body.blockers.includes('CLOUDFLARE_D1_DATABASE_ID'));

  const integrationVerify = await handleApiRequest({ method: 'GET', pathname: '/api/integrations/verify' });
  assert.equal(integrationVerify.status, 200);
  assert.equal(integrationVerify.body.ok, false);
  assert.equal(integrationVerify.body.providers.github.status, 'missing');
  assert.equal(integrationVerify.body.providers.linear.status, 'missing');

  const demoReport = await handleApiRequest({ method: 'GET', pathname: '/api/demo/report' });
  assert.equal(demoReport.status, 200);
  assert.equal(demoReport.body.ok, true);
  assert.equal(demoReport.body.dryRun, true);
  assert.equal(demoReport.body.summary.tasks, 5);
  assert.equal(demoReport.body.summary.approved, 5);
  assert.equal(demoReport.body.issuePackage.status, 'ready');
  assert.ok(demoReport.body.checks.every((check) => check.status === 'ready'));

  const memory = await handleApiRequest({ method: 'GET', pathname: '/api/memory' });
  assert.equal(memory.status, 200);
  assert.ok(memory.body.documents.length >= 6);
  assert.ok(memory.body.sample.matches.some((match) => match.id === 'customer-feedback-domain'));

  const health = await handleApiRequest({ method: 'GET', pathname: '/api/health' });
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.service, 'ai-task-agent');
  assert.equal(health.body.readiness.total, 5);
  assert.equal(health.body.provider.ai, 'local-planner');

  const run = await handleApiRequest({
    method: 'POST',
    pathname: '/api/agent/run',
    body: { idea },
  });
  assert.equal(run.status, 200);
  assert.match(run.body.prd.title, /Feedback|Portal|MVP/i);
  assert.equal(run.body.tasks.length, 5);
  assert.ok(run.body.prd.context.some((item) => item.includes('Customer feedback')));
  assert.ok(run.body.prd.validation.includes('All required agent output fields passed validation'));
  assert.equal(run.body.graph.at(-2).id, 'approval');
  assert.equal(run.body.graph.at(-2).status, 'active');
  assert.deepEqual(run.body.logs.slice(0, 6).map((log) => log.label), [
    'graph.input.accepted',
    'memory.retrieve_context',
    'planner.select_model',
    'local-planner.generate_prd',
    'schema.validate_agent_output',
    'tasks.create_many',
  ]);
  assert.deepEqual(run.body.logs.slice(0, 7).map((log) => log.label), [
    'graph.input.accepted',
    'memory.retrieve_context',
    'planner.select_model',
    'local-planner.generate_prd',
    'schema.validate_agent_output',
    'tasks.create_many',
    'interrupt.wait_for_human',
  ]);

  const traces = await handleApiRequest({ method: 'GET', pathname: '/api/traces' });
  assert.equal(traces.status, 200);
  assert.equal(traces.body.service, 'ai-task-agent');
  assert.equal(traces.body.run.taskCount, 5);
  assert.ok(traces.body.spans.some((span) => span.name === 'memory.retrieve_context'));
  assert.ok(traces.body.spans.some((span) => span.name === 'interrupt.wait_for_human'));

  const blockedExport = await handleApiRequest({
    method: 'POST',
    pathname: '/api/export',
    body: { target: 'GitHub' },
  });
  assert.equal(blockedExport.status, 400);
  assert.match(blockedExport.body.error, /Approve at least one task/i);

  const taskId = run.body.tasks[0].id;
  const approval = await handleApiRequest({
    method: 'PATCH',
    pathname: `/api/tasks/${encodeURIComponent(taskId)}`,
    body: { status: 'approved', reviewNote: 'Ready for issue export.' },
  });
  assert.equal(approval.status, 200);
  assert.equal(approval.body.tasks[0].status, 'approved');
  assert.equal(approval.body.tasks[0].reviewNote, 'Ready for issue export.');
  assert.equal(approval.body.graph.find((node) => node.id === 'approval').status, 'done');
  assert.equal(approval.body.graph.find((node) => node.id === 'export').status, 'active');

  const issuePackage = await handleApiRequest({
    method: 'GET',
    pathname: '/api/export-package',
    query: { target: 'GitHub' },
  });
  assert.equal(issuePackage.status, 200);
  assert.equal(issuePackage.body.status, 'ready');
  assert.equal(issuePackage.body.summary.approvedCount, 1);
  assert.equal(issuePackage.body.payload.length, 1);
  assert.match(issuePackage.body.markdown, /GitHub Issue Package/i);
  assert.match(issuePackage.body.markdown, /Ready for issue export/i);

  const exportRun = await handleApiRequest({
    method: 'POST',
    pathname: '/api/export',
    body: { target: 'GitHub' },
  });
  assert.equal(exportRun.status, 200);
  assert.equal(exportRun.body.exports[0].target, 'GitHub');
  assert.equal(exportRun.body.exports[0].status, 'payload-only');
  assert.equal(exportRun.body.exports[0].payload.length, 1);
  assert.equal(exportRun.body.graph.at(-1).status, 'done');
  assert.equal(exportRun.body.logs[0].label, 'github.issues.create_batch');
});

test('agent stream emits graph, log, and complete events in order', async () => {
  await isolateJsonStorage();
  const events = [];

  const workspace = await streamAgentRun({
    body: { idea },
    writeEvent: async (event) => events.push(event),
  });

  assert.ok(workspace);
  assert.equal(workspace.tasks.length, 5);
  assert.equal(events.at(0).type, 'graph');
  assert.equal(events.at(-1).type, 'complete');
  assert.equal(events.at(-1).workspace.tasks.length, 5);
  assert.deepEqual(
    events.filter((event) => event.type === 'log').map((event) => event.log.label),
    [
      'graph.input.accepted',
      'memory.retrieve_context',
      'planner.select_model',
      'local-planner.generate_prd',
      'schema.validate_agent_output',
      'tasks.create_many',
      'interrupt.wait_for_human',
    ],
  );
  assert.ok(events.some((event) => event.stage === 'validation'));
  assert.equal(events.at(-1).workspace.graph.find((node) => node.id === 'approval').status, 'active');
});

test('batch approval moves pending tasks through the human gate for export', async () => {
  await isolateJsonStorage();
  const run = await handleApiRequest({
    method: 'POST',
    pathname: '/api/agent/run',
    body: { idea },
  });
  const pendingIds = run.body.tasks.map((task) => task.id);

  const approval = await handleApiRequest({
    method: 'PATCH',
    pathname: '/api/tasks/batch',
    body: {
      taskIds: pendingIds,
      status: 'approved',
      reviewNote: 'Bulk approved for release planning.',
    },
  });

  assert.equal(approval.status, 200);
  assert.equal(approval.body.tasks.filter((task) => task.status === 'approved').length, pendingIds.length);
  assert.equal(approval.body.graph.find((node) => node.id === 'approval').status, 'done');
  assert.equal(approval.body.graph.find((node) => node.id === 'export').status, 'active');
  assert.equal(approval.body.logs[0].label, 'human.bulk_approve_tasks');

  const exportRun = await handleApiRequest({
    method: 'POST',
    pathname: '/api/export',
    body: { target: 'Linear' },
  });
  assert.equal(exportRun.status, 200);
  assert.equal(exportRun.body.exports[0].target, 'Linear');
  assert.equal(exportRun.body.exports[0].payload.length, pendingIds.length);
});

test('run history keeps previous agent runs and can resume one as current', async () => {
  await isolateJsonStorage();
  const first = await handleApiRequest({
    method: 'POST',
    pathname: '/api/agent/run',
    body: { idea },
  });
  const second = await handleApiRequest({
    method: 'POST',
    pathname: '/api/agent/run',
    body: {
      idea: 'A billing operations assistant for SaaS finance teams that audits failed payments and creates approved engineering follow-up tasks.',
    },
  });

  assert.ok(first.body.runId);
  assert.ok(second.body.runId);
  assert.notEqual(first.body.runId, second.body.runId);
  assert.equal(second.body.runHistory.length, 2);

  const runs = await handleApiRequest({ method: 'GET', pathname: '/api/runs' });
  assert.equal(runs.status, 200);
  assert.equal(runs.body.runs.length, 2);
  assert.equal(runs.body.runs[0].runId, second.body.runId);
  assert.equal(runs.body.runs[1].runId, first.body.runId);

  const selected = await handleApiRequest({
    method: 'POST',
    pathname: '/api/runs/select',
    body: { runId: first.body.runId },
  });
  assert.equal(selected.status, 200);
  assert.equal(selected.body.runId, first.body.runId);
  assert.equal(selected.body.prd.title, first.body.prd.title);
  assert.equal(selected.body.runHistory.length, 2);
});

test('workspace header isolates active runs and run history', async () => {
  await isolateJsonStorage();
  const teamA = { 'x-ai-task-agent-workspace': 'alpha-team' };
  const teamB = { 'x-ai-task-agent-workspace': 'beta-team' };

  const first = await handleApiRequest({
    method: 'POST',
    pathname: '/api/agent/run',
    headers: teamA,
    body: { idea },
  });
  const second = await handleApiRequest({
    method: 'POST',
    pathname: '/api/agent/run',
    headers: teamB,
    body: {
      idea: 'A billing operations assistant for SaaS finance teams that audits failed payments and creates approved engineering follow-up tasks.',
    },
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.workspace.label, 'alpha-team');
  assert.equal(second.body.workspace.label, 'beta-team');
  assert.notEqual(first.body.runId, second.body.runId);

  const alphaRuns = await handleApiRequest({ method: 'GET', pathname: '/api/runs', headers: teamA });
  const betaRuns = await handleApiRequest({ method: 'GET', pathname: '/api/runs', headers: teamB });
  const defaultRuns = await handleApiRequest({ method: 'GET', pathname: '/api/runs' });

  assert.deepEqual(alphaRuns.body.runs.map((run) => run.runId), [first.body.runId]);
  assert.deepEqual(betaRuns.body.runs.map((run) => run.runId), [second.body.runId]);
  assert.equal(defaultRuns.body.runs.length, 0);

  const crossWorkspaceSelect = await handleApiRequest({
    method: 'POST',
    pathname: '/api/runs/select',
    headers: teamB,
    body: { runId: first.body.runId },
  });
  assert.equal(crossWorkspaceSelect.status, 404);
});

test('expected API state errors return structured 4xx responses', async () => {
  await isolateJsonStorage();

  const missingRun = await handleApiRequest({
    method: 'POST',
    pathname: '/api/runs/select',
    body: { runId: 'missing-run-id' },
  });
  assert.equal(missingRun.status, 404);
  assert.equal(missingRun.body.error, 'Run not found.');

  const missingTaskIds = await handleApiRequest({
    method: 'PATCH',
    pathname: '/api/tasks/batch',
    body: { taskIds: ['TASK-NOPE'], status: 'approved' },
  });
  assert.equal(missingTaskIds.status, 400);
  assert.equal(missingTaskIds.body.error, 'No matching tasks to update.');
});

test('json storage serializes concurrent agent runs without corrupting the DB file', async () => {
  await isolateJsonStorage();
  const ideas = [
    idea,
    'A usage analytics review bot for SaaS teams that turns dashboard anomalies into approved engineering follow-up tasks.',
    'A billing operations assistant for SaaS teams that audits failed payments and creates approved engineering follow-up tasks.',
  ];

  const runs = await Promise.all(
    ideas.map((runIdea) =>
      handleApiRequest({
        method: 'POST',
        pathname: '/api/agent/run',
        body: { idea: runIdea },
      }),
    ),
  );

  assert.equal(runs.every((run) => run.status === 200), true);
  const history = await handleApiRequest({ method: 'GET', pathname: '/api/runs' });
  assert.equal(history.status, 200);
  assert.equal(history.body.runs.length, ideas.length);
  const dbBody = await readFile(process.env.TASK_AGENT_DB_FILE, 'utf8');
  assert.doesNotThrow(() => JSON.parse(dbBody));
});

async function isolateJsonStorage() {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_PUBLISHABLE_KEY;
  delete process.env.SUPABASE_ANON_KEY;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_D1_DATABASE_ID;
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.FREELLMAPI_BASE_URL;
  delete process.env.FREELLMAPI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.LINEAR_API_KEY;
  delete process.env.LINEAR_TEAM_ID;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_REPOSITORY;

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ai-task-agent-test-'));
  process.env.TASK_AGENT_DB_FILE = path.join(tmpDir, 'task-agent-db.json');
}
