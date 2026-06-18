import { runProductAgent } from './agent-runtime.js';
import { getStorage } from './storage.js';
import { workspaceContextFromRequest } from './workspace-context.js';

export async function streamAgentRun({ body = {}, headers = {}, query = {}, writeEvent }) {
  const idea = body.idea?.trim();
  if (!idea || idea.length < 12) {
    await writeEvent({
      type: 'error',
      message: 'Write a product idea with at least 12 characters.',
    });
    return null;
  }

  const workspaceContext = workspaceContextFromRequest({ headers, query });
  const storage = getStorage(workspaceContext.id);
  const workspace = await runProductAgent({
    idea,
    storage,
    onEvent: writeEvent,
  });

  await writeEvent({
    type: 'complete',
    message: 'Agent run persisted and paused at the human approval gate',
    workspace,
  });
  return workspace;
}

export function writeSse(res, event) {
  res.write(`event: ${event.type || 'message'}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
