import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import '../lib/env.js';
import { preflightStatus } from '../lib/domain.js';

const cwd = process.cwd();
const preflight = preflightStatus();
const vercelCli = await findVercelCli();
const vercelVersion = vercelCli ? run(vercelCli, ['--version']) : { ok: false, stdout: '', stderr: '' };
const gitRemote = run('git', ['remote', '-v']);
const vercelProject = await readJsonIfExists(path.join(cwd, '.vercel', 'project.json'));

const checks = [
  {
    id: 'vercel-cli',
    label: 'Vercel CLI',
    status: vercelVersion.ok ? 'ready' : 'missing',
    blocks: true,
    detail: vercelVersion.ok
      ? `Detected ${vercelVersion.stdout.split('\n')[0]} at ${vercelCli}`
      : 'Vercel CLI is not installed or is not on PATH.',
  },
  {
    id: 'vercel-project-link',
    label: 'Vercel project link',
    status: vercelProject ? 'ready' : 'missing',
    blocks: true,
    detail: vercelProject
      ? `Linked to project ${vercelProject.projectId || 'unknown'} in org ${vercelProject.orgId || 'unknown'}.`
      : 'No .vercel/project.json found; link or create the Vercel project before deploy.',
  },
  {
    id: 'git-remote',
    label: 'Git remote',
    status: gitRemote.ok && gitRemote.stdout.trim() ? 'ready' : 'missing',
    blocks: false,
    detail:
      gitRemote.ok && gitRemote.stdout.trim()
        ? gitRemote.stdout.trim().split('\n')[0]
        : 'No git remote configured; Vercel can deploy local files, but Git-backed previews need a remote.',
  },
  {
    id: 'durable-production-state',
    label: 'Durable production state',
    status: preflight.checks.find((check) => check.id === 'storage')?.status || 'missing',
    blocks: !['supabase', 'cloudflare-d1'].includes(preflight.provider.storage),
    detail:
      preflight.provider.storage === 'supabase'
        ? 'Durable Supabase storage is configured.'
        : preflight.provider.storage === 'cloudflare-d1'
          ? 'Durable Cloudflare D1 storage is configured.'
          : 'Production state will be volatile until Supabase or Cloudflare D1 server-side env vars are set.',
  },
  {
    id: 'llm-production-provider',
    label: 'LLM provider',
    status: preflight.provider.ai === 'local-planner' ? 'fallback' : 'ready',
    blocks: false,
    detail:
      preflight.provider.ai === 'local-planner'
        ? 'Local deterministic planner is active; configure LangGraph, OpenRouter, FreeLLMAPI, or OpenAI for live AI planning.'
        : `Planner provider is ${preflight.provider.ai}.`,
  },
  {
    id: 'linear-export',
    label: 'Linear export',
    status: preflight.provider.linear === 'configured' ? 'ready' : 'missing',
    blocks: false,
    detail:
      preflight.provider.linear === 'configured'
        ? 'Linear credentials are configured.'
        : 'Linear export will stay payload-only until LINEAR_API_KEY and LINEAR_TEAM_ID are set.',
  },
  {
    id: 'github-export',
    label: 'GitHub export',
    status: preflight.provider.github === 'configured' ? 'ready' : 'missing',
    blocks: false,
    detail:
      preflight.provider.github === 'configured'
        ? 'GitHub issue credentials are configured.'
        : 'GitHub export will stay payload-only until GITHUB_TOKEN and GITHUB_REPOSITORY are set.',
  },
];

const blockers = checks.filter((check) => check.blocks && check.status !== 'ready');
const report = {
  ok: blockers.length === 0,
  service: 'ai-task-agent',
  cwd,
  provider: preflight.provider,
  blockers: blockers.map(({ id, label, detail }) => ({ id, label, detail })),
  checks,
  next: blockers.length ? nextSteps(blockers) : ['Run vercel deploy, then run BASE_URL=https://your-preview.vercel.app npm run smoke.'],
};

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;

function run(command, args) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || result.error?.message || '',
  };
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function findVercelCli() {
  const candidates = [
    'vercel',
    path.join(process.env.HOME || '', 'Library', 'pnpm', 'bin', 'vercel'),
    '/opt/homebrew/bin/vercel',
    '/usr/local/bin/vercel',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = run(candidate, ['--version']);
    if (result.ok) return candidate;
  }
  return null;
}

function nextSteps(blockers) {
  const steps = [];
  if (blockers.some((blocker) => blocker.id === 'vercel-cli')) {
    steps.push('Install or authenticate Vercel CLI.');
  }
  if (blockers.some((blocker) => blocker.id === 'vercel-project-link')) {
    steps.push('Link or create the Vercel project.');
  }
  if (blockers.some((blocker) => blocker.id === 'durable-production-state')) {
    steps.push('For Cloudflare D1, run npm run d1:setup -- --name=ai-task-agent --location=apac --write-env.');
    steps.push('For Supabase, apply supabase/migrations/0001_ai_task_agent.sql, set SUPABASE_URL plus SUPABASE_SERVICE_ROLE_KEY, then run npm run supabase:smoke.');
    steps.push('Then run npm run vercel:env:sync -- --apply --scope=targixs-projects and redeploy.');
    steps.push('If reusing an existing database, run npm run d1:migrate and npm run d1:smoke before redeploy.');
    steps.push('Once production secrets are present, run npm run production:launch -- --apply --scope=targixs-projects.');
  }
  steps.push('Run BASE_URL=https://your-preview.vercel.app npm run production:smoke after deploy.');
  return steps;
}
