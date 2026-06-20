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
  assert.equal(preflight.body.summary.total, 6);
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
  assert.ok(preflight.body.setup.missingRequired.includes('SUPABASE_URL'));
  assert.deepEqual(preflight.body.setup.acceptedSecretSets.durableStorage[2], [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
  ]);
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
  assert.equal(health.body.readiness.total, 6);
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

test('real issue export is idempotent and only sends newly approved tasks', async () => {
  await isolateJsonStorage();
  process.env.GITHUB_TOKEN = 'github-token';
  process.env.GITHUB_REPOSITORY = 'owner/repo';
  process.env.ALLOW_PUBLIC_REAL_ISSUE_EXPORT = '1';
  const previousFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    return {
      ok: true,
      status: 201,
      json: async () => ({
        id: calls.length,
        number: calls.length,
        html_url: `https://github.com/owner/repo/issues/${calls.length}`,
      }),
    };
  };

  try {
    const run = await handleApiRequest({
      method: 'POST',
      pathname: '/api/agent/run',
      body: { idea },
    });
    const [first, second, third] = run.body.tasks;

    await handleApiRequest({
      method: 'PATCH',
      pathname: '/api/tasks/batch',
      body: {
        taskIds: [first.id, second.id],
        status: 'approved',
        reviewNote: 'Ready for first GitHub export.',
      },
    });

    const firstExport = await handleApiRequest({
      method: 'POST',
      pathname: '/api/export',
      body: { target: 'GitHub' },
    });
    assert.equal(firstExport.status, 200);
    assert.equal(firstExport.body.exports[0].status, 'created');
    assert.equal(firstExport.body.exports[0].payload.length, 2);
    assert.equal(firstExport.body.exports[0].payload[0].sourceTaskId, first.id);
    assert.equal(firstExport.body.exports[0].delivery[0].sourceTaskId, first.id);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.sourceTaskId, undefined);

    const duplicateExport = await handleApiRequest({
      method: 'POST',
      pathname: '/api/export',
      body: { target: 'GitHub' },
    });
    assert.equal(duplicateExport.status, 409);
    assert.match(duplicateExport.body.error, /already been exported/i);
    assert.equal(calls.length, 2);

    const blockedPackage = await handleApiRequest({
      method: 'GET',
      pathname: '/api/export-package',
      query: { target: 'GitHub' },
    });
    assert.equal(blockedPackage.body.status, 'blocked');
    assert.equal(blockedPackage.body.summary.pendingExportCount, 0);
    assert.equal(blockedPackage.body.summary.exportedCount, 2);

    await handleApiRequest({
      method: 'PATCH',
      pathname: `/api/tasks/${encodeURIComponent(third.id)}`,
      body: { status: 'approved', reviewNote: 'Ready for incremental export.' },
    });
    const incrementalPackage = await handleApiRequest({
      method: 'GET',
      pathname: '/api/export-package',
      query: { target: 'GitHub' },
    });
    assert.equal(incrementalPackage.body.status, 'ready');
    assert.equal(incrementalPackage.body.payload.length, 1);
    assert.equal(incrementalPackage.body.payload[0].sourceTaskId, third.id);

    const secondExport = await handleApiRequest({
      method: 'POST',
      pathname: '/api/export',
      body: { target: 'GitHub' },
    });
    assert.equal(secondExport.status, 200);
    assert.equal(secondExport.body.exports[0].payload.length, 1);
    assert.equal(secondExport.body.exports[0].payload[0].sourceTaskId, third.id);
    assert.equal(calls.length, 3);
  } finally {
    global.fetch = previousFetch;
  }
});

test('partial issue export retries only failed tasks', async () => {
  await isolateJsonStorage();
  process.env.GITHUB_TOKEN = 'github-token';
  process.env.GITHUB_REPOSITORY = 'owner/repo';
  process.env.ALLOW_PUBLIC_REAL_ISSUE_EXPORT = '1';
  const previousFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    const title = calls.at(-1).body.title;
    if (calls.length === 2) {
      return {
        ok: false,
        status: 502,
        json: async () => ({ message: `Temporary failure for ${title}` }),
      };
    }
    return {
      ok: true,
      status: 201,
      json: async () => ({
        id: calls.length,
        number: calls.length,
        html_url: `https://github.com/owner/repo/issues/${calls.length}`,
      }),
    };
  };

  try {
    const run = await handleApiRequest({
      method: 'POST',
      pathname: '/api/agent/run',
      body: { idea },
    });
    const [first, second, third] = run.body.tasks;
    await handleApiRequest({
      method: 'PATCH',
      pathname: '/api/tasks/batch',
      body: {
        taskIds: [first.id, second.id, third.id],
        status: 'approved',
        reviewNote: 'Ready for partial retry test.',
      },
    });

    const firstExport = await handleApiRequest({
      method: 'POST',
      pathname: '/api/export',
      body: { target: 'GitHub' },
    });
    assert.equal(firstExport.status, 200);
    assert.equal(firstExport.body.exports[0].status, 'partial-or-failed');
    assert.equal(firstExport.body.exports[0].delivery.filter((item) => item.ok).length, 2);
    assert.equal(firstExport.body.exports[0].delivery.find((item) => !item.ok).sourceTaskId, second.id);
    assert.equal(calls.length, 3);

    const retryPackage = await handleApiRequest({
      method: 'GET',
      pathname: '/api/export-package',
      query: { target: 'GitHub' },
    });
    assert.equal(retryPackage.body.status, 'ready');
    assert.equal(retryPackage.body.summary.pendingExportCount, 1);
    assert.equal(retryPackage.body.summary.exportedCount, 2);
    assert.equal(retryPackage.body.payload[0].sourceTaskId, second.id);

    const retryExport = await handleApiRequest({
      method: 'POST',
      pathname: '/api/export',
      body: { target: 'GitHub' },
    });
    assert.equal(retryExport.status, 200);
    assert.equal(retryExport.body.exports[0].status, 'created');
    assert.equal(retryExport.body.exports[0].payload.length, 1);
    assert.equal(retryExport.body.exports[0].payload[0].sourceTaskId, second.id);
    assert.equal(calls.length, 4);
    assert.equal(calls[3].body.title, second.title);
  } finally {
    global.fetch = previousFetch;
  }
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

test('workspace access token guards data routes when configured', async () => {
  await isolateJsonStorage();
  process.env.WORKSPACE_ACCESS_TOKEN = 'secret-token';

  const health = await handleApiRequest({ method: 'GET', pathname: '/api/health' });
  const preflight = await handleApiRequest({ method: 'GET', pathname: '/api/preflight' });
  assert.equal(health.status, 200);
  assert.equal(preflight.status, 200);
  assert.equal(preflight.body.provider.access, 'guarded');
  assert.equal(preflight.body.checks.find((check) => check.id === 'workspace-access').status, 'ready');

  const blocked = await handleApiRequest({ method: 'GET', pathname: '/api/workspace' });
  assert.equal(blocked.status, 401);
  assert.match(blocked.body.error, /access token/i);

  const allowed = await handleApiRequest({
    method: 'GET',
    pathname: '/api/workspace',
    headers: { authorization: 'Bearer secret-token' },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.provider.access, 'guarded');

  const events = [];
  const stream = await streamAgentRun({
    body: { idea },
    writeEvent: async (event) => events.push(event),
  });
  assert.equal(stream, null);
  assert.equal(events[0].type, 'error');
  assert.match(events[0].message, /access token/i);
});

test('guarded workspace token unlocks real issue creation without public override', async () => {
  await isolateJsonStorage();
  process.env.WORKSPACE_ACCESS_TOKEN = 'secret-token';
  process.env.GITHUB_TOKEN = 'github-token';
  process.env.GITHUB_REPOSITORY = 'owner/repo';
  const headers = { authorization: 'Bearer secret-token' };
  const previousFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    return {
      ok: true,
      status: 201,
      json: async () => ({
        id: calls.length,
        number: calls.length,
        html_url: `https://github.com/owner/repo/issues/${calls.length}`,
      }),
    };
  };

  try {
    const blockedRun = await handleApiRequest({
      method: 'POST',
      pathname: '/api/agent/run',
      body: { idea },
    });
    assert.equal(blockedRun.status, 401);

    const run = await handleApiRequest({
      method: 'POST',
      pathname: '/api/agent/run',
      headers,
      body: { idea },
    });
    assert.equal(run.status, 200);

    const approval = await handleApiRequest({
      method: 'PATCH',
      pathname: '/api/tasks/batch',
      headers,
      body: {
        taskIds: run.body.tasks.slice(0, 2).map((task) => task.id),
        status: 'approved',
        reviewNote: 'Ready for private GitHub creation.',
      },
    });
    assert.equal(approval.status, 200);

    const issuePackage = await handleApiRequest({
      method: 'GET',
      pathname: '/api/export-package',
      headers,
      query: { target: 'GitHub' },
    });
    assert.equal(issuePackage.status, 200);
    assert.equal(issuePackage.body.mode.mode, 'real-issue-creation');
    assert.equal(issuePackage.body.mode.canCreateIssues, true);
    assert.match(issuePackage.body.mode.reason, /Private guarded mode/i);

    const exported = await handleApiRequest({
      method: 'POST',
      pathname: '/api/export',
      headers,
      body: { target: 'GitHub' },
    });
    assert.equal(exported.status, 200);
    assert.equal(exported.body.exports[0].status, 'created');
    assert.equal(exported.body.exports[0].mode.mode, 'real-issue-creation');
    assert.equal(exported.body.exports[0].delivery.length, 2);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://api.github.com/repos/owner/repo/issues');
  } finally {
    global.fetch = previousFetch;
  }
});

test('team workspace token unlocks a private workspace on a public deployment', async () => {
  await isolateJsonStorage();
  process.env.TEAM_WORKSPACES = JSON.stringify({
    targix: { label: 'TargiX Product', token: 'team-token' },
  });
  process.env.GITHUB_TOKEN = 'github-token';
  process.env.GITHUB_REPOSITORY = 'owner/repo';
  const teamWorkspaceId = 'targix-smoke-1';
  const workspaceHeaders = { 'x-ai-task-agent-workspace': teamWorkspaceId };
  const privateHeaders = { ...workspaceHeaders, 'x-ai-task-agent-access-token': 'team-token' };
  const previousFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    return {
      ok: true,
      status: 201,
      json: async () => ({
        id: calls.length,
        number: calls.length,
        html_url: `https://github.com/owner/repo/issues/${calls.length}`,
      }),
    };
  };

  try {
    const teams = await handleApiRequest({ method: 'GET', pathname: '/api/team/workspaces' });
    assert.equal(teams.status, 200);
    assert.equal(teams.body.access, 'team-guarded');
    assert.deepEqual(teams.body.teams, [{ id: 'targix', label: 'TargiX Product' }]);
    assert.equal(JSON.stringify(teams.body).includes('team-token'), false);

    const blockedWorkspace = await handleApiRequest({
      method: 'GET',
      pathname: '/api/workspace',
      headers: workspaceHeaders,
    });
    assert.equal(blockedWorkspace.status, 401);
    assert.match(blockedWorkspace.body.error, /team workspace access token/i);

    const badSession = await handleApiRequest({
      method: 'POST',
      pathname: '/api/team/session',
      body: { workspaceId: 'targix', token: 'wrong-token' },
    });
    assert.equal(badSession.status, 401);

    const session = await handleApiRequest({
      method: 'POST',
      pathname: '/api/team/session',
      body: { workspaceId: teamWorkspaceId, token: 'team-token' },
    });
    assert.equal(session.status, 200);
    assert.equal(session.body.workspace.id, teamWorkspaceId);
    assert.equal(session.body.workspace.label, 'TargiX Product');
    assert.equal(session.body.access, 'guarded');
    assert.equal(session.body.team.id, 'targix');

    const run = await handleApiRequest({
      method: 'POST',
      pathname: '/api/agent/run',
      headers: privateHeaders,
      body: { idea },
    });
    assert.equal(run.status, 200);
    assert.equal(run.body.provider.access, 'guarded');
    assert.equal(run.body.workspace.id, teamWorkspaceId);
    assert.equal(run.body.workspace.team.id, 'targix');
    assert.equal(run.body.workspace.team.label, 'TargiX Product');

    await handleApiRequest({
      method: 'PATCH',
      pathname: '/api/tasks/batch',
      headers: privateHeaders,
      body: {
        taskIds: run.body.tasks.slice(0, 2).map((task) => task.id),
        status: 'approved',
        reviewNote: 'Team approved for GitHub creation.',
      },
    });

    const issuePackage = await handleApiRequest({
      method: 'GET',
      pathname: '/api/export-package',
      headers: privateHeaders,
      query: { target: 'GitHub' },
    });
    assert.equal(issuePackage.body.mode.mode, 'real-issue-creation');

    const exported = await handleApiRequest({
      method: 'POST',
      pathname: '/api/export',
      headers: privateHeaders,
      body: { target: 'GitHub' },
    });
    assert.equal(exported.status, 200);
    assert.equal(exported.body.provider.access, 'guarded');
    assert.equal(exported.body.exports[0].status, 'created');
    assert.equal(calls.length, 2);
  } finally {
    global.fetch = previousFetch;
  }
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
  delete process.env.WORKSPACE_ACCESS_TOKEN;
  delete process.env.TEAM_WORKSPACES;
  delete process.env.WORKSPACE_TEAM_TOKENS;
  delete process.env.ALLOW_PUBLIC_REAL_ISSUE_EXPORT;

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ai-task-agent-test-'));
  process.env.TASK_AGENT_DB_FILE = path.join(tmpDir, 'task-agent-db.json');
}
