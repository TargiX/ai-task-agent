import { runProductAgent } from './agent-runtime.js';
import { verifyWorkspaceAccess } from './access-control.js';
import { createDemoReport } from './demo-report.js';
import { exportPayload, graphTrace, logEntry, preflightStatus, providerStatus } from './domain.js';
import { createIssueExportPackage } from './export-package.js';
import { verifyIssueIntegrations } from './integration-verify.js';
import { createGitHubIssues, createLinearIssues } from './integrations.js';
import { getConfiguredFreeModels } from './llm.js';
import { DEFAULT_KNOWLEDGE_DOCS, retrieveContext } from './memory.js';
import { verifyRuntimeSetup } from './setup-verify.js';
import { getStorage } from './storage.js';
import { traceEnvelope } from './tracing.js';
import { workspaceContextFromRequest } from './workspace-context.js';

export async function handleApiRequest(request) {
  try {
    return await routeApiRequest(request);
  } catch (error) {
    const expected = expectedApiError(error);
    if (expected) return expected;
    throw error;
  }
}

async function routeApiRequest({ method, pathname, query = {}, body = {}, headers = {} }) {
  const access = verifyWorkspaceAccess({ pathname, headers });
  if (!access.ok) return access.response;
  const workspaceContext = workspaceContextFromRequest({ headers, query });
  const storage = getStorage(workspaceContext.id);

  if (method === 'GET' && pathname === '/api/workspace') {
    return { status: 200, body: await storage.getWorkspace() };
  }

  if (method === 'GET' && pathname === '/api/runs') {
    return { status: 200, body: { runs: await storage.listRuns() } };
  }

  if (method === 'POST' && pathname === '/api/runs/select') {
    const runId = body.runId?.trim();
    if (!runId) return { status: 400, body: { error: 'Missing runId.' } };
    return { status: 200, body: await storage.selectRun(runId) };
  }

  if (method === 'DELETE' && pathname === '/api/workspace') {
    return { status: 200, body: await storage.resetWorkspace() };
  }

  if (method === 'GET' && pathname === '/api/llm/free-models') {
    return { status: 200, body: { ...(await getConfiguredFreeModels()), provider: providerStatus() } };
  }

  if (method === 'GET' && pathname === '/api/integrations/verify') {
    return { status: 200, body: await verifyIssueIntegrations() };
  }

  if (method === 'GET' && pathname === '/api/preflight') {
    return { status: 200, body: preflightStatus() };
  }

  if (method === 'GET' && pathname === '/api/setup/verify') {
    return { status: 200, body: await verifyRuntimeSetup(storage) };
  }

  if (method === 'GET' && pathname === '/api/demo/report') {
    return { status: 200, body: await createDemoReport({ idea: query.idea }) };
  }

  if (method === 'GET' && pathname === '/api/memory') {
    return {
      status: 200,
      body: {
        documents: DEFAULT_KNOWLEDGE_DOCS,
        sample: retrieveContext('customer feedback portal that exports approved feature requests'),
      },
    };
  }

  if (method === 'GET' && pathname === '/api/traces') {
    return { status: 200, body: traceEnvelope(await storage.getWorkspace()) };
  }

  if (method === 'GET' && pathname === '/api/export-package') {
    const target = query.target || 'Linear';
    if (!['Linear', 'GitHub'].includes(target)) {
      return { status: 400, body: { error: 'Invalid export target.' } };
    }

    return {
      status: 200,
      body: createIssueExportPackage(target, await storage.getWorkspace(), providerStatus()),
    };
  }

  if (method === 'GET' && pathname === '/api/health') {
    const preflight = preflightStatus();
    return {
      status: 200,
      body: {
        ok: true,
        service: 'ai-task-agent',
        version: process.env.VERCEL_GIT_COMMIT_SHA || process.env.npm_package_version || 'local',
        runtime: process.env.VERCEL ? 'vercel' : 'node',
        environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
        provider: preflight.provider,
        readiness: preflight.summary,
        checkedAt: new Date().toISOString(),
      },
    };
  }

  if (method === 'POST' && pathname === '/api/agent/run') {
    const idea = body.idea?.trim();
    if (!idea || idea.length < 12) {
      return { status: 400, body: { error: 'Write a product idea with at least 12 characters.' } };
    }

    return { status: 200, body: await runProductAgent({ idea, storage }) };
  }

  if (method === 'PATCH' && pathname === '/api/tasks/batch') {
    if (!['approved', 'rejected', 'pending'].includes(body.status)) {
      return { status: 400, body: { error: 'Invalid task status.' } };
    }

    const workspace = await storage.getWorkspace();
    const requestedIds = Array.isArray(body.taskIds) ? body.taskIds.map(String) : [];
    const taskIds = requestedIds.length
      ? requestedIds.filter((id) => workspace.tasks.some((task) => task.id === id))
      : workspace.tasks.map((task) => task.id);
    if (!taskIds.length) {
      return { status: 400, body: { error: 'No matching tasks to update.' } };
    }

    const patch = {
      status: body.status,
      reviewNote: body.reviewNote || '',
    };
    const nextTasks = workspace.tasks.map((task) =>
      taskIds.includes(task.id) ? { ...task, ...patch } : task,
    );
    const graph = graphTrace(nextTasks.some((task) => task.status === 'approved') ? 'approved' : 'planned');
    const log = logEntry(
      'approval',
      body.status === 'approved'
        ? 'human.bulk_approve_tasks'
        : body.status === 'rejected'
          ? 'human.bulk_reject_tasks'
          : 'human.bulk_reset_tasks',
      `${taskIds.length} tasks marked ${body.status}; approval gate ${
        nextTasks.some((task) => task.status === 'approved') ? 'can resume to export' : 'is still waiting'
      }${body.reviewNote ? `: ${body.reviewNote}` : ''}`,
    );

    return { status: 200, body: await storage.patchTasks(taskIds, patch, graph, log) };
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (method === 'PATCH' && taskMatch) {
    if (body.status && !['approved', 'rejected', 'pending'].includes(body.status)) {
      return { status: 400, body: { error: 'Invalid task status.' } };
    }

    const workspace = await storage.getWorkspace();
    const taskId = decodeURIComponent(taskMatch[1]);
    if (!workspace.tasks.some((task) => task.id === taskId)) {
      return { status: 404, body: { error: 'Task not found.' } };
    }

    const allowedFields = ['title', 'owner', 'priority', 'effort', 'acceptance', 'status', 'reviewNote'];
    const patch = {};
    for (const field of allowedFields) {
      if (body[field] !== undefined) patch[field] = body[field];
    }

    const nextTasks = workspace.tasks.map((task) =>
      task.id === taskId ? { ...task, ...patch } : task,
    );
    const graph = graphTrace(nextTasks.some((task) => task.status === 'approved') ? 'approved' : 'planned');
    const log = logEntry(
      body.status ? 'approval' : 'tool',
      body.status
        ? body.status === 'approved'
          ? 'human.approve_task'
          : 'human.reject_task'
        : 'tasks.update_one',
      body.status
        ? `${taskId} marked ${body.status}; approval gate ${
            nextTasks.some((task) => task.status === 'approved') ? 'can resume to export' : 'is still waiting'
          }${body.reviewNote ? `: ${body.reviewNote}` : ''}`
        : `${taskId} fields updated`,
    );

    return { status: 200, body: await storage.patchTask(taskId, patch, graph, log) };
  }

  if (method === 'POST' && pathname === '/api/export') {
    const target = body.target;
    if (!['Linear', 'GitHub'].includes(target)) {
      return { status: 400, body: { error: 'Invalid export target.' } };
    }

    const workspace = await storage.getWorkspace();
    const payload = exportPayload(target, workspace.prd, workspace.tasks);
    if (!payload.length) {
      return { status: 400, body: { error: 'Approve at least one task before export.' } };
    }

    const provider = providerStatus();
    const statusKey = target.toLowerCase();
    let delivery = null;
    let exportStatus = 'payload-only';
    if (provider[statusKey] === 'configured') {
      delivery = target === 'GitHub' ? await createGitHubIssues(payload) : await createLinearIssues(payload);
      exportStatus = delivery?.every((result) => result.ok) ? 'created' : 'partial-or-failed';
    }

    const exportRecord = {
      id: `export-${Date.now()}`,
      target,
      status: exportStatus,
      createdAt: new Date().toISOString(),
      payload,
      delivery,
    };
    const log = logEntry(
      'api',
      target === 'Linear' ? 'linear.issue.create_batch' : 'github.issues.create_batch',
      `Agent resumed after approval and ${exportStatus === 'created' ? 'created' : 'prepared'} ${payload.length} ${target} issues`,
    );

    return {
      status: 200,
      body: await storage.createExport(exportRecord, graphTrace('exported'), log),
    };
  }

  return { status: 404, body: { error: 'API route not found.' } };
}

function expectedApiError(error) {
  const message = error?.message || '';
  if (message === 'Run not found.') {
    return { status: 404, body: { error: message } };
  }
  if (message === 'No active run.') {
    return { status: 409, body: { error: message } };
  }
  return null;
}
