import { normalizeWorkspaceId, workspaceDisplayName } from './workspace-context.js';

export function teamWorkspaceRegistry(env = process.env) {
  const records = [
    ...parseJsonTeamWorkspaces(env.TEAM_WORKSPACES),
    ...parseTokenList(env.WORKSPACE_TEAM_TOKENS),
  ];
  const byId = new Map();
  for (const record of records) {
    const id = normalizeWorkspaceId(record.id);
    const token = String(record.token || '').trim();
    if (!id || !token) continue;
    byId.set(id, {
      id,
      label: String(record.label || workspaceDisplayName(id)).trim() || workspaceDisplayName(id),
      token,
    });
  }
  return byId;
}

export function publicTeamWorkspaceConfig(env = process.env) {
  return {
    configured: teamWorkspaceRegistry(env).size > 0,
    teams: Array.from(teamWorkspaceRegistry(env).values()).map((team) => ({
      id: team.id,
      label: team.label,
    })),
  };
}

export function findTeamWorkspace(workspaceId, env = process.env) {
  const id = normalizeWorkspaceId(workspaceId);
  const registry = teamWorkspaceRegistry(env);
  const exact = registry.get(id);
  if (exact) return { ...exact, teamId: exact.id };

  for (const team of registry.values()) {
    if (id.startsWith(`${team.id}-`)) {
      return {
        ...team,
        id,
        teamId: team.id,
      };
    }
  }

  return null;
}

function parseJsonTeamWorkspaces(value) {
  if (!value?.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
    return Object.entries(parsed).map(([id, config]) =>
      typeof config === 'string'
        ? { id, token: config }
        : { id, ...(config || {}) },
    );
  } catch {
    return [];
  }
}

function parseTokenList(value) {
  if (!value?.trim()) return [];
  return value
    .split(',')
    .map((entry) => {
      const [id, token, ...labelParts] = entry.split(':');
      return {
        id,
        token,
        label: labelParts.join(':'),
      };
    })
    .filter((entry) => entry.id?.trim() && entry.token?.trim());
}
