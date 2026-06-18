import '../lib/env.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const schemaPath = path.resolve(args.schema || 'cloudflare/d1/schema.sql');
const dryRun = Boolean(args['dry-run']);
const statements = splitSqlStatements(await fs.readFile(schemaPath, 'utf8'));

if (!statements.length) {
  throw new Error(`No SQL statements found in ${schemaPath}`);
}

if (dryRun) {
  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun: true,
        schemaPath,
        statements: statements.map((sql) => firstLine(sql)),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

assertD1Env();
const results = [];
for (const sql of statements) {
  const result = await d1Query(sql);
  results.push({
    statement: firstLine(sql),
    rowsRead: result.meta?.rows_read || 0,
    rowsWritten: result.meta?.rows_written || 0,
  });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,
      statements: results,
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
  return result || {};
}

function splitSqlStatements(sql) {
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function firstLine(sql) {
  return sql.split('\n').map((line) => line.trim()).find(Boolean) || sql.slice(0, 80);
}

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const [key, value] = arg.slice(2).split('=');
    parsed[key] = value ?? true;
  }
  return parsed;
}
