import '../lib/env.js';

assertD1Env();

const ping = await d1Query('select 1 as ok');
const tables = await d1Query(
  "select name from sqlite_master where type = 'table' and name in ('agent_workspaces', 'agent_runs', 'agent_prds', 'agent_tasks', 'agent_tool_calls', 'agent_exports') order by name",
);
const tableNames = new Set((tables.results || []).map((row) => row.name));
const expectedTables = [
  'agent_workspaces',
  'agent_runs',
  'agent_prds',
  'agent_tasks',
  'agent_tool_calls',
  'agent_exports',
];
const missingTables = expectedTables.filter((name) => !tableNames.has(name));

if (missingTables.length) {
  throw new Error(`Cloudflare D1 is reachable, but schema is missing tables: ${missingTables.join(', ')}`);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,
      ping: ping.results?.[0]?.ok === 1,
      tables: expectedTables,
    },
    null,
    2,
  ),
);

function assertD1Env() {
  const missing = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_D1_DATABASE_ID', 'CLOUDFLARE_API_TOKEN'].filter(
    (name) => !process.env[name]?.trim(),
  );
  if (missing.length) {
    throw new Error(`Missing Cloudflare D1 env vars: ${missing.join(', ')}`);
  }
}

async function d1Query(sql) {
  const accountId = encodeURIComponent(process.env.CLOUDFLARE_ACCOUNT_ID);
  const databaseId = encodeURIComponent(process.env.CLOUDFLARE_D1_DATABASE_ID);
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sql, params: [] }),
    },
  );
  const body = await response.json().catch(() => ({}));
  const result = Array.isArray(body.result) ? body.result[0] : body.result;
  const errors = [
    ...(Array.isArray(body.errors) ? body.errors : []),
    ...(Array.isArray(result?.errors) ? result.errors : []),
  ]
    .map((error) => error?.message)
    .filter(Boolean);
  if (!response.ok || body.success === false || result?.success === false || errors.length) {
    throw new Error(errors.join('; ') || `Cloudflare D1 query failed with HTTP ${response.status}`);
  }
  return result || { results: [] };
}
