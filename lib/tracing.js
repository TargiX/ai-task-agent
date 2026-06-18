export function traceEnvelope(workspace) {
  const logs = workspace.logs || [];
  const graph = workspace.graph || [];
  const tasks = workspace.tasks || [];
  const approved = tasks.filter((task) => task.status === 'approved').length;
  const rejected = tasks.filter((task) => task.status === 'rejected').length;
  const spans = logs.map((log, index) => ({
    id: log.id || `span-${index + 1}`,
    name: log.label,
    kind: log.type,
    sequence: index + 1,
    startedAt: log.createdAt || null,
    attributes: {
      detail: log.detail,
      stage: stageForLog(log.label),
      provider: workspace.provider?.ai || 'unknown',
      storage: workspace.provider?.storage || 'unknown',
    },
  }));

  return {
    service: 'ai-task-agent',
    traceId: traceIdFromWorkspace(workspace),
    generatedAt: new Date().toISOString(),
    run: {
      idea: workspace.idea || '',
      title: workspace.prd?.title || null,
      provider: workspace.provider || {},
      graphStatus: Object.fromEntries(graph.map((node) => [node.id, node.status])),
      taskCount: tasks.length,
      approved,
      rejected,
      pending: Math.max(tasks.length - approved - rejected, 0),
      exportCount: workspace.exports?.length || 0,
      contextCount: workspace.prd?.context?.length || 0,
    },
    spans,
  };
}

function traceIdFromWorkspace(workspace) {
  const source = [
    workspace.idea || 'empty',
    workspace.prd?.title || 'untitled',
    workspace.logs?.[0]?.id || 'log-start',
  ].join(':');
  let hash = 0;
  for (let index = 0; index < source.length; index += 1) {
    hash = (hash * 31 + source.charCodeAt(index)) >>> 0;
  }
  return `trace-${hash.toString(16).padStart(8, '0')}`;
}

function stageForLog(label) {
  if (label.includes('input')) return 'idea';
  if (label.includes('memory') || label.includes('planner')) return 'planner';
  if (label.includes('generate_prd')) return 'prd';
  if (label.includes('validate')) return 'validation';
  if (label.includes('tasks.')) return 'db';
  if (label.includes('approve') || label.includes('reject') || label.includes('interrupt')) return 'approval';
  if (label.includes('issue') || label.includes('github') || label.includes('linear')) return 'export';
  return 'runtime';
}
