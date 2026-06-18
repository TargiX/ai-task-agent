import '../lib/env.js';
import { createClient } from '@supabase/supabase-js';

const expectedTables = [
  'agent_workspaces',
  'agent_runs',
  'agent_prds',
  'agent_tasks',
  'agent_tool_calls',
  'agent_exports',
];

const env = assertSupabaseEnv();
const supabase = createClient(env.url, env.key, {
  auth: { persistSession: false },
});

const checks = [];
for (const table of expectedTables) {
  const { error } = await supabase.from(table).select('*', { count: 'exact', head: true });
  if (error) {
    throw new Error(`Supabase table ${table} is not reachable: ${error.message}`);
  }
  checks.push({ table, status: 'ready' });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      url: env.url,
      keyType: env.keyType,
      tables: checks,
    },
    null,
    2,
  ),
);

function assertSupabaseEnv() {
  const url = process.env.SUPABASE_URL?.trim();
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url) throw new Error('Missing SUPABASE_URL.');
  try {
    new URL(url);
  } catch {
    throw new Error('SUPABASE_URL is not a valid URL.');
  }
  if (!serviceRole) {
    throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY for the server-side storage adapter.');
  }
  return {
    url,
    key: serviceRole,
    keyType: 'service-role',
  };
}
