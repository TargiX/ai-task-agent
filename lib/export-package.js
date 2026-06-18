import { exportPayload } from './domain.js';

export function createIssueExportPackage(target, workspace, provider) {
  const payload = exportPayload(target, workspace.prd, workspace.tasks);
  const approvedTasks = workspace.tasks.filter((task) => task.status === 'approved');
  const blockedReason = payload.length ? '' : 'Approve at least one task before preparing an issue package.';

  return {
    target,
    runId: workspace.runId || null,
    status: payload.length ? 'ready' : 'blocked',
    provider: provider[target.toLowerCase()],
    generatedAt: new Date().toISOString(),
    summary: {
      prdTitle: workspace.prd?.title || 'Untitled PRD',
      approvedCount: approvedTasks.length,
      totalTasks: workspace.tasks.length,
      blockedReason,
    },
    payload,
    markdown: payload.length ? issuePackageMarkdown(target, workspace, approvedTasks, payload) : '',
  };
}

function issuePackageMarkdown(target, workspace, approvedTasks, payload) {
  const prd = workspace.prd || {};
  const lines = [
    `# ${target} Issue Package: ${prd.title || 'Untitled PRD'}`,
    '',
    `Source idea: ${workspace.idea || prd.sourceIdea || 'Not captured'}`,
    '',
    '## PRD Summary',
    '',
    `Problem: ${prd.problem || 'Not captured'}`,
    '',
    `Audience: ${prd.audience || 'Not captured'}`,
    '',
    '## Approved Issues',
    '',
  ];

  approvedTasks.forEach((task, index) => {
    lines.push(
      `### ${index + 1}. ${task.title}`,
      '',
      `Owner: ${task.owner}`,
      `Priority: ${task.priority}`,
      `Estimate: ${task.effort}`,
      '',
      'Acceptance criteria:',
      '',
      task.acceptance,
    );

    if (task.reviewNote) {
      lines.push('', `Review note: ${task.reviewNote}`);
    }

    lines.push('', 'Provider payload:', '', '```json', JSON.stringify(payload[index], null, 2), '```', '');
  });

  return `${lines.join('\n').trim()}\n`;
}
