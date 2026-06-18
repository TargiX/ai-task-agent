import { preflightStatus } from './domain.js';
import { createIssueExportPackage } from './export-package.js';
import { verifyIssueIntegrations } from './integration-verify.js';
import { getConfiguredFreeModels } from './llm.js';

export async function verifyRuntimeSetup(storage) {
  const startedAt = Date.now();
  const preflight = preflightStatus();
  const checks = [];
  let workspace = null;
  let runs = [];

  checks.push({
    id: 'api-runtime',
    label: 'API runtime',
    status: 'ready',
    detail: `${process.env.VERCEL ? 'Vercel serverless' : 'Node server'} runtime accepted the verification request.`,
  });

  try {
    workspace = await storage.getWorkspace();
    runs = await storage.listRuns();
    const durable = ['supabase', 'cloudflare-d1'].includes(preflight.provider.storage);
    checks.push({
      id: 'storage-roundtrip',
      label: 'Storage roundtrip',
      status: durable ? 'ready' : 'fallback',
      detail:
        preflight.provider.storage === 'json' && process.env.VERCEL
          ? 'JSON storage responded, but Vercel serverless state is volatile across functions; configure D1 or Supabase.'
          : `Storage adapter returned ${runs.length} run summaries and an active workspace.`,
      evidence: {
        provider: preflight.provider.storage,
        runCount: runs.length,
        activeRunId: workspace.runId || null,
      },
    });
  } catch (error) {
    checks.push({
      id: 'storage-roundtrip',
      label: 'Storage roundtrip',
      status: 'failed',
      detail: error.message,
      evidence: { provider: preflight.provider.storage },
    });
  }

  try {
    const issuePackage = createIssueExportPackage('GitHub', workspace || { tasks: [], prd: null }, preflight.provider);
    checks.push({
      id: 'issue-package',
      label: 'Issue package',
      status: 'ready',
      detail:
        issuePackage.status === 'ready'
          ? `${issuePackage.payload.length} approved GitHub issue payloads can be packaged.`
          : issuePackage.summary.blockedReason,
      evidence: {
        status: issuePackage.status,
        target: issuePackage.target,
        payloadCount: issuePackage.payload.length,
      },
    });
  } catch (error) {
    checks.push({
      id: 'issue-package',
      label: 'Issue package',
      status: 'failed',
      detail: error.message,
    });
  }

  checks.push(await verifyPlanner(preflight.provider));
  checks.push(await verifyIssueProvider(preflight.provider));

  const hardFailures = checks.filter((check) => check.status === 'failed');
  const productionBlockers = preflight.setup.missingRequired;
  return {
    ok: hardFailures.length === 0 && productionBlockers.length === 0,
    service: 'ai-task-agent',
    runtime: process.env.VERCEL ? 'vercel' : 'node',
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
    provider: preflight.provider,
    checks,
    blockers: productionBlockers,
    summary: summarizeChecks(checks),
    durationMs: Date.now() - startedAt,
    checkedAt: new Date().toISOString(),
  };
}

async function verifyIssueProvider(provider) {
  const hasConfiguredProvider = provider.linear === 'configured' || provider.github === 'configured';
  if (!hasConfiguredProvider) {
    return {
      id: 'issue-provider',
      label: 'Issue provider',
      status: 'fallback',
      detail: 'Linear/GitHub credentials are missing; exports remain payload-only.',
      evidence: {
        linear: provider.linear,
        github: provider.github,
      },
    };
  }

  const verification = await verifyIssueIntegrations();
  const readyProviders = Object.values(verification.providers).filter((item) => item.status === 'ready');
  return {
    id: 'issue-provider',
    label: 'Issue provider',
    status: readyProviders.length ? 'ready' : 'failed',
    detail: readyProviders.length
      ? `${readyProviders.map((item) => item.label).join(' and ')} read-only checks passed.`
      : 'Issue provider credentials are present, but read-only checks failed.',
    evidence: verification.providers,
  };
}

async function verifyPlanner(provider) {
  if (provider.ai === 'local-planner') {
    return {
      id: 'planner-provider',
      label: 'Planner provider',
      status: 'fallback',
      detail: 'Local deterministic planner is active; configure OpenRouter, FreeLLMAPI, OpenAI, or LangGraph for live AI.',
      evidence: { provider: provider.ai },
    };
  }

  if (provider.ai === 'openrouter' || provider.ai === 'freellmapi') {
    try {
      const catalog = await getConfiguredFreeModels({ only: provider.ai, strict: true });
      const models = catalog.models;
      return {
        id: 'planner-provider',
        label: 'Planner provider',
        status: 'ready',
        detail: models.length
          ? `${provider.ai} responded with ${models.length} model catalog entries.`
          : `${provider.ai} is configured; no model catalog entries were returned.`,
        evidence: {
          provider: provider.ai,
          modelCount: models.length,
          topModel: models[0]?.id || null,
          sources: catalog.sources,
        },
      };
    } catch (error) {
      return {
        id: 'planner-provider',
        label: 'Planner provider',
        status: 'failed',
        detail: error.message,
        evidence: { provider: provider.ai },
      };
    }
  }

  return {
    id: 'planner-provider',
    label: 'Planner provider',
    status: 'ready',
    detail: `${provider.ai} planner is configured.`,
    evidence: { provider: provider.ai },
  };
}

function summarizeChecks(checks) {
  return {
    ready: checks.filter((check) => check.status === 'ready').length,
    fallback: checks.filter((check) => check.status === 'fallback').length,
    missing: checks.filter((check) => check.status === 'missing').length,
    failed: checks.filter((check) => check.status === 'failed').length,
    total: checks.length,
  };
}
