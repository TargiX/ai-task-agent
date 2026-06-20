import { runProductAgent } from './agent-runtime.js';
import { verifyWorkspaceAccess } from './access-control.js';
import { providerStatus } from './domain.js';
import { getStorage } from './storage.js';
import { workspaceContextFromRequest } from './workspace-context.js';

export async function streamAgentRun({ body = {}, headers = {}, query = {}, writeEvent }) {
  const workspaceContext = workspaceContextFromRequest({ headers, query });
  const access = verifyWorkspaceAccess({ pathname: '/api/agent/stream', headers, workspaceId: workspaceContext.id });
  if (!access.ok) {
    await writeEvent({
      type: 'error',
      message: access.response.body.error,
      detail: access.response.body.detail,
    });
    return null;
  }

  const idea = body.idea?.trim();
  if (!idea || idea.length < 12) {
    await writeEvent({
      type: 'error',
      message: 'Write a product idea with at least 12 characters.',
    });
    return null;
  }

  const storage = getStorage(workspaceContext.id);
  const workspace = decorateWorkspace(await runProductAgent({
    idea,
    storage,
    onEvent: writeEvent,
  }), providerStatus({ access: access.status.effectiveMode }), access.status);

  await writeEvent({
    type: 'complete',
    message: 'Agent run persisted and paused at the human approval gate',
    workspace,
  });
  return workspace;
}

function decorateWorkspace(workspace, provider, accessStatus) {
  if (!workspace || !workspace.provider) return workspace;
  return {
    ...workspace,
    provider,
    workspace: {
      ...(workspace.workspace || {}),
      access: accessStatus.effectiveMode,
      team: accessStatus.team,
    },
  };
}

export function writeSse(res, event) {
  res.write(`event: ${event.type || 'message'}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
