import '../lib/env.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const D1_ENV_VARS = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_D1_DATABASE_ID', 'CLOUDFLARE_API_TOKEN'];
const args = parseArgs(process.argv.slice(2));
const envFile = path.resolve(args.from || '.env.production.local');
const schemaPath = path.resolve(args.schema || 'cloudflare/d1/schema.sql');
const databaseName = args.name || process.env.CLOUDFLARE_D1_DATABASE_NAME || 'ai-task-agent';
const primaryLocationHint = args.location || process.env.CLOUDFLARE_D1_PRIMARY_LOCATION_HINT || 'apac';
const dryRun = Boolean(args['dry-run']);
const shouldWriteEnv = Boolean(args['write-env']);
const shouldMigrate = !Boolean(args['no-migrate']);
const values = {
  ...readDotEnvIfExists(envFile),
  ...pickProcessEnv([...D1_ENV_VARS, 'CLOUDFLARE_D1_DATABASE_NAME', 'CLOUDFLARE_D1_PRIMARY_LOCATION_HINT']),
};

if (dryRun) {
  const missingForCreate = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'].filter((name) => !values[name]?.trim());
  console.log(
    JSON.stringify(
      {
        ok: missingForCreate.length === 0,
        dryRun: true,
        databaseName,
        primaryLocationHint,
        envFile,
        schemaPath,
        missingForCreate,
        planned: [
          `List D1 databases in account ${values.CLOUDFLARE_ACCOUNT_ID ? mask(values.CLOUDFLARE_ACCOUNT_ID) : '<missing>'}`,
          `Create "${databaseName}" if it does not exist`,
          shouldMigrate ? `Apply ${schemaPath}` : 'Skip schema migration because --no-migrate was set',
          shouldWriteEnv ? `Update ${envFile}` : 'Print env values without writing a file',
        ],
        next: missingForCreate.length
          ? `Set ${missingForCreate.join(', ')} and rerun without --dry-run.`
          : 'Rerun without --dry-run to create or reuse the D1 database.',
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const missingForCreate = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'].filter((name) => !values[name]?.trim());
if (missingForCreate.length) {
  throw new Error(`Missing Cloudflare D1 setup env vars: ${missingForCreate.join(', ')}`);
}

const existingById = values.CLOUDFLARE_D1_DATABASE_ID
  ? { uuid: values.CLOUDFLARE_D1_DATABASE_ID, name: databaseName, source: 'env' }
  : null;
const database = existingById || (await findDatabaseByName(databaseName, values)) || (await createDatabase(databaseName, values));
const finalValues = {
  ...values,
  CLOUDFLARE_D1_DATABASE_ID: database.uuid,
  CLOUDFLARE_D1_DATABASE_NAME: database.name || databaseName,
  CLOUDFLARE_D1_PRIMARY_LOCATION_HINT: primaryLocationHint,
};

let migration = null;
let smoke = null;
if (shouldMigrate) {
  migration = await migrateSchema(schemaPath, finalValues);
  smoke = await smokeSchema(finalValues);
}

if (shouldWriteEnv) {
  await writeDotEnv(envFile, {
    CLOUDFLARE_ACCOUNT_ID: finalValues.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_D1_DATABASE_ID: finalValues.CLOUDFLARE_D1_DATABASE_ID,
    CLOUDFLARE_API_TOKEN: finalValues.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_D1_DATABASE_NAME: finalValues.CLOUDFLARE_D1_DATABASE_NAME,
    CLOUDFLARE_D1_PRIMARY_LOCATION_HINT: finalValues.CLOUDFLARE_D1_PRIMARY_LOCATION_HINT,
  });
}

console.log(
  JSON.stringify(
    {
      ok: true,
      database: {
        id: database.uuid,
        name: database.name || databaseName,
        source: database.source || 'created',
        primaryLocationHint,
      },
      migration,
      smoke,
      envFile: shouldWriteEnv ? envFile : null,
      export: {
        CLOUDFLARE_ACCOUNT_ID: finalValues.CLOUDFLARE_ACCOUNT_ID,
        CLOUDFLARE_D1_DATABASE_ID: finalValues.CLOUDFLARE_D1_DATABASE_ID,
        CLOUDFLARE_API_TOKEN: '<redacted>',
      },
      next: shouldWriteEnv
        ? 'Run npm run vercel:env:sync -- --apply --scope=targixs-projects, redeploy, then run production smoke.'
        : `Add CLOUDFLARE_D1_DATABASE_ID=${finalValues.CLOUDFLARE_D1_DATABASE_ID} to ${envFile} or rerun with --write-env.`,
    },
    null,
    2,
  ),
);

async function findDatabaseByName(name, envValues) {
  let page = 1;
  while (page <= 20) {
    const json = await cloudflareRequest(envValues, `/d1/database?page=${page}&per_page=100`);
    const databases = Array.isArray(json.result) ? json.result : [];
    const match = databases.find((database) => database.name === name);
    if (match?.uuid) return { ...match, source: 'existing' };
    const totalPages = Math.ceil((json.result_info?.total_count || databases.length) / 100) || 1;
    if (page >= totalPages || !databases.length) return null;
    page += 1;
  }
  return null;
}

async function createDatabase(name, envValues) {
  const body = { name };
  if (primaryLocationHint) body.primary_location_hint = primaryLocationHint;
  const json = await cloudflareRequest(envValues, '/d1/database', {
    method: 'POST',
    body,
  });
  if (!json.result?.uuid) {
    throw new Error('Cloudflare created a D1 database but did not return a database UUID.');
  }
  return { ...json.result, source: 'created' };
}

async function migrateSchema(filePath, envValues) {
  const statements = splitSqlStatements(await fsp.readFile(filePath, 'utf8'));
  const results = [];
  for (const sql of statements) {
    const result = await d1Query(envValues, sql);
    results.push({
      statement: firstLine(sql),
      rowsRead: result.meta?.rows_read || 0,
      rowsWritten: result.meta?.rows_written || 0,
    });
  }
  return { schemaPath: filePath, statements: results };
}

async function smokeSchema(envValues) {
  const tables = await d1Query(
    envValues,
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
    throw new Error(`Cloudflare D1 schema is missing tables: ${missingTables.join(', ')}`);
  }
  return { tables: expectedTables };
}

async function d1Query(envValues, sql, params = []) {
  const json = await cloudflareRequest(envValues, `/d1/database/${encodeURIComponent(envValues.CLOUDFLARE_D1_DATABASE_ID)}/query`, {
    method: 'POST',
    body: { sql, params },
  });
  const result = Array.isArray(json.result) ? json.result[0] : json.result;
  const errors = [
    ...(Array.isArray(json.errors) ? json.errors : []),
    ...(Array.isArray(result?.errors) ? result.errors : []),
  ]
    .map((error) => error?.message)
    .filter(Boolean);
  if (json.success === false || result?.success === false || errors.length) {
    throw new Error(errors.join('; ') || 'Cloudflare D1 query failed.');
  }
  return result || { results: [] };
}

async function cloudflareRequest(envValues, resourcePath, options = {}) {
  const accountId = encodeURIComponent(envValues.CLOUDFLARE_ACCOUNT_ID);
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${resourcePath}`, {
    method: options.method || 'GET',
    headers: {
      authorization: `Bearer ${envValues.CLOUDFLARE_API_TOKEN}`,
      'content-type': 'application/json',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  const errors = (Array.isArray(json.errors) ? json.errors : []).map((error) => error?.message).filter(Boolean);
  if (!response.ok || json.success === false || errors.length) {
    throw new Error(errors.join('; ') || `Cloudflare API failed with HTTP ${response.status}`);
  }
  return json;
}

async function writeDotEnv(filePath, updates) {
  const existing = readDotEnvLines(filePath);
  const seen = new Set();
  const next = existing.map((line) => {
    const key = line.key;
    if (!key || updates[key] === undefined) return line.raw;
    seen.add(key);
    return `${key}=${quoteEnvValue(updates[key])}`;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) next.push(`${key}=${quoteEnvValue(value)}`);
  }
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${next.join('\n')}\n`);
}

function readDotEnvLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).map((raw) => {
    const trimmed = raw.trim();
    const equalsAt = trimmed.indexOf('=');
    if (!trimmed || trimmed.startsWith('#') || equalsAt <= 0) return { raw };
    return { raw, key: trimmed.slice(0, equalsAt).trim() };
  });
}

function readDotEnvIfExists(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const valuesFromFile = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equalsAt = trimmed.indexOf('=');
    if (equalsAt <= 0) continue;
    const key = trimmed.slice(0, equalsAt).trim();
    valuesFromFile[key] = unquoteEnvValue(trimmed.slice(equalsAt + 1).trim());
  }
  return valuesFromFile;
}

function pickProcessEnv(names) {
  return Object.fromEntries(names.filter((name) => process.env[name]?.trim()).map((name) => [name, process.env[name]]));
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

function quoteEnvValue(value) {
  const stringValue = String(value ?? '');
  if (!stringValue || /[\s"'#]/.test(stringValue)) return JSON.stringify(stringValue);
  return stringValue;
}

function unquoteEnvValue(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function mask(value) {
  if (!value || value.length < 8) return '<present>';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
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
