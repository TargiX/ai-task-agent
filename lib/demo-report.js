import { runProductAgent } from './agent-runtime.js';
import { graphTrace, initialWorkspace, logEntry, providerStatus } from './domain.js';
import { createIssueExportPackage } from './export-package.js';
import { traceEnvelope } from './tracing.js';

const DEMO_IDEA =
  'An AI task agent for SaaS teams that converts product ideas into PRDs, approved implementation tasks, and issue tracker exports.';

export async function createDemoReport({ idea = DEMO_IDEA } = {}) {
  const storage = memoryStorage();
  const events = [];
  const startedAt = Date.now();
  const plannedWorkspace = await runProductAgent({
    idea,
    storage,
    onEvent: async (event) => events.push(event),
  });

  const taskIds = plannedWorkspace.tasks.map((task) => task.id);
  const approvedWorkspace = await storage.patchTasks(
    taskIds,
    {
      status: 'approved',
      reviewNote: 'Demo report approved this task for issue packaging.',
    },
    graphTrace('approved'),
    logEntry('approval', 'human.bulk_approve_tasks', `${taskIds.length} demo tasks approved for export readiness.`),
  );
  const issuePackage = createIssueExportPackage('GitHub', approvedWorkspace, providerStatus());
  const exportedWorkspace = await storage.createExport(
    {
      id: `demo-export-${Date.now()}`,
      target: 'GitHub',
      status: 'payload-only',
      createdAt: new Date().toISOString(),
      payload: issuePackage.payload,
      delivery: null,
    },
    graphTrace('exported'),
    logEntry('api', 'github.issues.create_batch', `Demo report prepared ${issuePackage.payload.length} GitHub issues.`),
  );
  const trace = traceEnvelope(exportedWorkspace);

  return {
    ok: true,
    dryRun: true,
    service: 'ai-task-agent',
    provider: providerStatus(),
    summary: {
      title: exportedWorkspace.prd.title,
      tasks: exportedWorkspace.tasks.length,
      approved: exportedWorkspace.tasks.filter((task) => task.status === 'approved').length,
      exports: exportedWorkspace.exports.length,
      logs: exportedWorkspace.logs.length,
      events: events.length,
      traceSpans: trace.spans.length,
      durationMs: Date.now() - startedAt,
    },
    checks: [
      {
        id: 'idea-to-prd',
        label: 'Idea to PRD',
        status: exportedWorkspace.prd?.title ? 'ready' : 'failed',
        detail: exportedWorkspace.prd?.title || 'PRD was not generated.',
      },
      {
        id: 'task-breakdown',
        label: 'Task breakdown',
        status: exportedWorkspace.tasks.length >= 4 ? 'ready' : 'failed',
        detail: `${exportedWorkspace.tasks.length} implementation tasks generated.`,
      },
      {
        id: 'human-approval',
        label: 'Human approval',
        status: exportedWorkspace.tasks.every((task) => task.status === 'approved') ? 'ready' : 'failed',
        detail: `${taskIds.length} tasks approved through the workflow gate.`,
      },
      {
        id: 'issue-package',
        label: 'Issue package',
        status: issuePackage.status === 'ready' ? 'ready' : 'failed',
        detail: `${issuePackage.payload.length} GitHub issue payloads prepared.`,
      },
      {
        id: 'trace-export',
        label: 'Trace export',
        status: trace.spans.length >= 8 ? 'ready' : 'failed',
        detail: `${trace.spans.length} trace spans generated from tool-call logs.`,
      },
    ],
    issuePackage: {
      target: issuePackage.target,
      status: issuePackage.status,
      payloadCount: issuePackage.payload.length,
      markdownPreview: issuePackage.markdown.slice(0, 1200),
    },
    trace: {
      traceId: trace.traceId,
      spanCount: trace.spans.length,
      graphStatus: trace.run.graphStatus,
    },
    generatedAt: new Date().toISOString(),
  };
}

function memoryStorage() {
  let workspace = {
    ...initialWorkspace(),
    runHistory: [],
  };

  function withProvider(nextWorkspace) {
    return { ...nextWorkspace, provider: providerStatus() };
  }

  function summarizeRun(run) {
    const approved = run.tasks.filter((task) => task.status === 'approved').length;
    const rejected = run.tasks.filter((task) => task.status === 'rejected').length;
    return {
      runId: run.runId,
      title: run.prd?.title || 'Untitled demo run',
      idea: run.idea || '',
      status: run.exports.length ? 'exported' : approved ? 'approved' : 'planned',
      taskCount: run.tasks.length,
      approvedCount: approved,
      rejectedCount: rejected,
      exportCount: run.exports.length,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  }

  function commit(nextWorkspace) {
    const runHistory = nextWorkspace.runId ? [summarizeRun(nextWorkspace)] : [];
    workspace = { ...nextWorkspace, runHistory };
    return withProvider(workspace);
  }

  return {
    async getWorkspace() {
      return withProvider(workspace);
    },
    async resetWorkspace() {
      workspace = { ...initialWorkspace(), runHistory: [] };
      return withProvider(workspace);
    },
    async listRuns() {
      return workspace.runId ? [summarizeRun(workspace)] : [];
    },
    async selectRun(runId) {
      if (workspace.runId !== runId) throw new Error('Run not found.');
      return withProvider(workspace);
    },
    async saveRun({ idea, prd, tasks, graph, logs }) {
      const now = new Date().toISOString();
      return commit({
        runId: crypto.randomUUID(),
        idea,
        prd,
        tasks,
        graph,
        logs: [...logs, ...initialWorkspace().logs],
        exports: [],
        createdAt: now,
        updatedAt: now,
      });
    },
    async patchTask(taskId, patch, graph, log) {
      return commit({
        ...workspace,
        tasks: workspace.tasks.map((task) => (task.id === taskId ? { ...task, ...patch } : task)),
        graph,
        logs: [log, ...workspace.logs],
        updatedAt: new Date().toISOString(),
      });
    },
    async patchTasks(taskIds, patch, graph, log) {
      const ids = new Set(taskIds);
      return commit({
        ...workspace,
        tasks: workspace.tasks.map((task) => (ids.has(task.id) ? { ...task, ...patch } : task)),
        graph,
        logs: [log, ...workspace.logs],
        updatedAt: new Date().toISOString(),
      });
    },
    async createExport(exportRecord, graph, log) {
      return commit({
        ...workspace,
        graph,
        exports: [exportRecord, ...workspace.exports],
        logs: [log, ...workspace.logs],
        updatedAt: new Date().toISOString(),
      });
    },
  };
}
