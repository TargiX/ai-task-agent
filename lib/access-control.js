import crypto from 'node:crypto';

const ACCESS_HEADER = 'x-ai-task-agent-access-token';
const PUBLIC_ROUTES = new Set(['/api/health', '/api/preflight']);

export function accessControlStatus() {
  const configured = Boolean(process.env.WORKSPACE_ACCESS_TOKEN?.trim());
  return {
    configured,
    mode: configured ? 'guarded' : 'demo-open',
    header: ACCESS_HEADER,
    publicRoutes: Array.from(PUBLIC_ROUTES),
  };
}

export function verifyWorkspaceAccess({ pathname, headers = {} } = {}) {
  const status = accessControlStatus();
  if (!status.configured || PUBLIC_ROUTES.has(pathname)) return { ok: true, status };
  const expected = process.env.WORKSPACE_ACCESS_TOKEN.trim();
  const provided = accessTokenFromHeaders(headers);
  if (timingSafeEqual(provided, expected)) return { ok: true, status };
  return {
    ok: false,
    status,
    response: {
      status: 401,
      body: {
        error: 'Workspace access token required.',
        detail: `Set ${ACCESS_HEADER} or Authorization: Bearer <token>.`,
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
