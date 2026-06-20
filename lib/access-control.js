import crypto from 'node:crypto';
import { findTeamWorkspace, publicTeamWorkspaceConfig } from './team-workspaces.js';
import { normalizeWorkspaceId } from './workspace-context.js';

const ACCESS_HEADER = 'x-ai-task-agent-access-token';
const PUBLIC_ROUTES = new Set(['/api/health', '/api/preflight', '/api/team/workspaces', '/api/team/session']);

export function accessControlStatus() {
  const configured = Boolean(process.env.WORKSPACE_ACCESS_TOKEN?.trim());
  const teamWorkspaces = publicTeamWorkspaceConfig();
  return {
    configured,
    mode: configured ? 'guarded' : 'demo-open',
    teamWorkspaces,
    header: ACCESS_HEADER,
    publicRoutes: Array.from(PUBLIC_ROUTES),
  };
}

export function verifyWorkspaceAccess({ pathname, headers = {}, workspaceId = '' } = {}) {
  const status = accessControlStatus();
  const provided = accessTokenFromHeaders(headers);
  const globalToken = process.env.WORKSPACE_ACCESS_TOKEN?.trim() || '';
  if (PUBLIC_ROUTES.has(pathname)) return { ok: true, status: effectiveStatus(status, 'demo-open') };
  if (globalToken) {
    if (timingSafeEqual(provided, globalToken)) return { ok: true, status: effectiveStatus(status, 'guarded') };
    return accessDenied(status, 'Workspace access token required.', `Set ${ACCESS_HEADER} or Authorization: Bearer <token>.`);
  }

  const team = findTeamWorkspace(normalizeWorkspaceId(workspaceId));
  if (team) {
    if (timingSafeEqual(provided, team.token)) {
      return {
        ok: true,
        status: effectiveStatus(status, 'guarded', { id: team.teamId || team.id, workspaceId: team.id, label: team.label }),
      };
    }
    return accessDenied(status, 'Team workspace access token required.', `Open ${team.label} with its team token.`);
  }

  return { ok: true, status: effectiveStatus(status, 'demo-open') };
}

export function verifyTeamWorkspaceSession({ workspaceId, token } = {}) {
  const id = normalizeWorkspaceId(workspaceId);
  const provided = String(token || '').trim();
  const globalToken = process.env.WORKSPACE_ACCESS_TOKEN?.trim() || '';
  if (globalToken && timingSafeEqual(provided, globalToken)) {
    return {
      ok: true,
      workspace: { id, label: id },
      access: 'guarded',
      global: true,
    };
  }

  const team = findTeamWorkspace(id);
  if (team && timingSafeEqual(provided, team.token)) {
    return {
      ok: true,
      workspace: { id: team.id, label: team.label },
      access: 'guarded',
      global: false,
      team: { id: team.teamId || team.id, label: team.label },
    };
  }

  return {
    ok: false,
    response: {
      status: 401,
      body: {
        error: 'Private workspace token is invalid.',
        detail: 'Check the workspace key and team access token.',
      },
    },
  };
}

function effectiveStatus(status, mode, team = null) {
  return {
    ...status,
    effectiveMode: mode,
    team,
  };
}

function accessDenied(status, error, detail) {
  return {
    ok: false,
    status,
    response: {
      status: 401,
      body: {
        error,
        detail,
      },
    },
  };
}

function accessTokenFromHeaders(headers) {
  const explicit = getHeader(headers, ACCESS_HEADER);
  if (explicit) return explicit.trim();
  const authorization = getHeader(headers, 'authorization');
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

function getHeader(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  const lowerName = name.toLowerCase();
  return headers[name] || headers[lowerName] || '';
}

function timingSafeEqual(a, b) {
  if (!a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
