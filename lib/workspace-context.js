import { DEFAULT_WORKSPACE_ID } from './domain.js';

const DEFAULT_WORKSPACE_ALIASES = new Set(['', 'default', 'default-team', DEFAULT_WORKSPACE_ID]);

export function workspaceContextFromRequest({ headers = {}, query = {} } = {}) {
  const requested =
    query.workspaceId ||
    query.workspace ||
    getHeader(headers, 'x-ai-task-agent-workspace') ||
    getHeader(headers, 'x-workspace-id') ||
    '';
  const id = normalizeWorkspaceId(requested);
  return {
    id,
    label: workspaceDisplayName(id),
    requested: String(requested || ''),
    isDefault: id === DEFAULT_WORKSPACE_ID,
  };
}

export function normalizeWorkspaceId(value = '') {
  const raw = String(value || '').trim();
  if (DEFAULT_WORKSPACE_ALIASES.has(raw.toLowerCase())) return DEFAULT_WORKSPACE_ID;
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || DEFAULT_WORKSPACE_ID;
}

export function workspaceDisplayName(workspaceId = DEFAULT_WORKSPACE_ID) {
  if (workspaceId === DEFAULT_WORKSPACE_ID) return 'default';
  return workspaceId;
}

function getHeader(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  const lowerName = name.toLowerCase();
  return headers[name] || headers[lowerName] || '';
}
