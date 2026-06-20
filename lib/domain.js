export const DEFAULT_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';

export function graphTrace(stage = 'draft') {
  const order = [
    ['idea', 'Idea captured'],
    ['planner', 'Planner selected'],
    ['prd', 'PRD generated'],
    ['tasks', 'Tasks planned'],
    ['validation', 'Output validated'],
    ['db', 'Tasks inserted in DB'],
    ['approval', 'Human approval gate'],
    ['export', 'Issue export'],
  ];
  const completeUntil = {
    draft: 0,
    idea: 1,
    planner: 2,
    prd: 3,
    tasks: 4,
    validation: 5,
    db: 6,
    planned: 6,
    approved: 7,
    exported: 8,
  }[stage] ?? 0;
  return order.map(([id, label], index) => ({
    id,
    label,
    status: index < completeUntil ? 'done' : index === completeUntil ? 'active' : 'waiting',
    updatedAt: index < completeUntil ? new Date().toISOString() : null,
  }));
}

export function initialWorkspace() {
  return {
    runId: null,
    idea: '',
    prd: null,
    tasks: [],
    graph: graphTrace('draft'),
    logs: [
      {
        id: 'log-start',
        type: 'agent',
        label: 'langgraph.start',
        detail: 'Waiting for product idea',
        createdAt: new Date().toISOString(),
      },
    ],
    exports: [],
    runHistory: [],
  };
}

export function logEntry(type, label, detail) {
  return {
    id: `log-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type,
    label,
    detail,
    createdAt: new Date().toISOString(),
  };
}

export function providerStatus(options = {}) {
  const access =
    options.access ||
    (process.env.WORKSPACE_ACCESS_TOKEN || process.env.TEAM_WORKSPACES || process.env.WORKSPACE_TEAM_TOKENS
      ? 'guarded'
      : 'demo-open');
  const ai = process.env.LANGGRAPH_BACKEND_URL
    ? 'langgraph'
    : process.env.OPENROUTER_API_KEY
    ? 'openrouter'
    : process.env.FREELLMAPI_BASE_URL && process.env.FREELLMAPI_API_KEY
      ? 'freellmapi'
      : process.env.OPENAI_API_KEY
        ? 'openai'
        : 'local-planner';

  return {
    ai,
    langgraph: process.env.LANGGRAPH_BACKEND_URL ? 'configured' : 'not-configured',
    storage: cloudflareD1Configured()
      ? 'cloudflare-d1'
      : process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
        ? 'supabase'
        : 'json',
    linear:
      process.env.LINEAR_API_KEY && process.env.LINEAR_TEAM_ID ? 'configured' : 'not-configured',
    github: process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY ? 'configured' : 'not-configured',
    access,
  };
}

export function issueExportMode(target, provider = providerStatus(), env = process.env) {
  const targetKey = String(target || '').toLowerCase();
  const connector = provider[targetKey] || 'not-configured';
  const connectorConfigured = connector === 'configured';
  const privateAccess = provider.access === 'guarded';
  const publicOverride = env.ALLOW_PUBLIC_REAL_ISSUE_EXPORT === '1';
  const canCreateIssues = connectorConfigured && (privateAccess || publicOverride);

  return {
    mode: canCreateIssues ? 'real-issue-creation' : 'package-only',
    canCreateIssues,
    connector,
    access: provider.access,
    reason: !connectorConfigured
      ? `${target} connector is not configured; the app can still prepare a safe issue package.`
      : canCreateIssues
        ? `Private guarded mode is active, so approved tasks can create real ${target} issues.`
        : `Public demo mode prepares ${target} packages only; enable guarded private access for real issue creation.`,
  };
}

export function preflightStatus() {
  const provider = providerStatus();
  const ai = aiPreflight();
  const storage = storagePreflight();
  const linear = keyedPairPreflight({
    configured: provider.linear === 'configured',
    hasPrimary: hasEnv('LINEAR_API_KEY'),
    hasSecondary: hasEnv('LINEAR_TEAM_ID'),
    readyDetail: 'Linear API key and team id are configured.',
    missingDetail: 'Missing LINEAR_API_KEY or LINEAR_TEAM_ID; exports will remain payload-only.',
    partialDetail: 'Linear export is partially configured; set both LINEAR_API_KEY and LINEAR_TEAM_ID.',
  });
  const github = githubPreflight(provider.github === 'configured');
  const access = accessPreflight(provider.access === 'guarded');
  const checks = [
    {
      id: 'agent-runtime',
      label: 'Agent runtime',
      status: 'ready',
      detail: 'Graph runtime, schema validation, tool-call logs, and human interrupt are available.',
    },
    {
      id: 'ai-provider',
      label: 'AI planner',
      status: ai.status,
      detail: ai.detail,
    },
    {
      id: 'storage',
      label: 'Persistence',
      status: storage.status,
      detail: storage.detail,
    },
    {
      id: 'linear',
      label: 'Linear export',
      status: linear.status,
      detail: linear.detail,
    },
    {
      id: 'github',
      label: 'GitHub export',
      status: github.status,
      detail: github.detail,
    },
    {
      id: 'workspace-access',
      label: 'Workspace access',
      status: access.status,
      detail: access.detail,
    },
  ];

  return {
    provider,
    checks,
    capabilities: capabilityMatrix(provider),
    setup: productionSetup(provider),
    summary: {
      ready: checks.filter((check) => check.status === 'ready').length,
      fallback: checks.filter((check) => check.status === 'fallback').length,
      missing: checks.filter((check) => check.status === 'missing').length,
      misconfigured: checks.filter((check) => check.status === 'misconfigured').length,
      total: checks.length,
    },
  };
}

export function productionSetup(provider = providerStatus()) {
  const storageReady = ['supabase', 'cloudflare-d1'].includes(provider.storage);
  const llmReady = provider.ai !== 'local-planner';
  const issueExportReady = provider.linear === 'configured' || provider.github === 'configured';
  const accessReady = provider.access === 'guarded';
  const acceptedSecretSets = {
    workspaceAccess: [['WORKSPACE_ACCESS_TOKEN'], ['TEAM_WORKSPACES'], ['WORKSPACE_TEAM_TOKENS']],
    durableStorage: [
      ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_D1_DATABASE_ID', 'CLOUDFLARE_API_TOKEN'],
      ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'],
      ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    ],
    cloudflareRuntime: [['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_D1_DATABASE_ID', 'CLOUDFLARE_API_TOKEN']],
    liveLlm: [
      ['OPENROUTER_API_KEY'],
      ['FREELLMAPI_BASE_URL', 'FREELLMAPI_API_KEY'],
      ['OPENAI_API_KEY'],
      ['LANGGRAPH_BACKEND_URL'],
    ],
    issueExport: [
      ['LINEAR_API_KEY', 'LINEAR_TEAM_ID'],
      ['GITHUB_TOKEN', 'GITHUB_REPOSITORY'],
    ],
  };
  const groups = [
    {
      id: 'workspace-access',
      label: 'Workspace access',
      status: accessReady ? 'ready' : 'fallback',
      active: provider.access,
      missing: [],
      alternatives: ['public-demo', 'shared-access-token', 'team-workspace-tokens'],
      commands: [
        'npm run vercel:env:sync -- --allow-partial --only=WORKSPACE_ACCESS_TOKEN --apply',
        'npm run vercel:env:sync -- --allow-partial --only=TEAM_WORKSPACES --apply',
      ],
    },
    {
      id: 'durable-storage',
      label: 'Durable storage',
      status: storageReady ? 'ready' : 'missing',
      active: storageReady ? provider.storage : 'json',
      missing: storageReady ? [] : ['CLOUDFLARE_D1_DATABASE_ID', 'SUPABASE_URL'],
      alternatives: ['cloudflare-d1', 'supabase'],
      commands: [
        'npm run d1:setup -- --name=ai-task-agent --location=apac --write-env',
        'npm run d1:migrate',
        'npm run d1:smoke',
        'npm run supabase:smoke',
        'npm run vercel:env:sync -- --apply',
      ],
    },
    {
      id: 'live-llm',
      label: 'Live LLM',
      status: llmReady ? 'ready' : 'fallback',
      active: provider.ai,
      missing: llmReady ? [] : ['OPENROUTER_API_KEY'],
      alternatives: ['openrouter', 'freellmapi', 'openai', 'langgraph'],
      commands: ['npm run vercel:env:sync -- --apply'],
    },
    {
      id: 'issue-export',
      label: 'Issue export',
      status: issueExportReady ? 'ready' : 'missing',
      active:
        provider.linear === 'configured' && provider.github === 'configured'
          ? 'linear+github'
          : provider.linear === 'configured'
            ? 'linear'
            : provider.github === 'configured'
              ? 'github'
              : 'payload-only',
      missing: issueExportReady ? [] : ['LINEAR_API_KEY', 'LINEAR_TEAM_ID', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY'],
      alternatives: ['linear', 'github'],
      commands: ['npm run vercel:env:sync -- --apply'],
    },
  ];

  return {
    groups,
    acceptedSecretSets,
    productionReady: storageReady && llmReady && issueExportReady,
    launchCommand: 'npm run production:launch -- --apply --scope=targixs-projects',
    launchChecklist: [
      'Fill .env.production.local with durable storage, one live LLM set, and one issue export set.',
      'Run npm run production:launch to verify the release path in dry-run mode.',
      'Run npm run production:launch -- --apply --scope=targixs-projects to test, sync env, and deploy.',
      'Run BASE_URL=<preview-url> npm run hosted:smoke for protected preview verification.',
    ],
    missingRequired: groups
      .filter((group) => group.id !== 'workspace-access')
      .flatMap((group) => group.missing),
  };
}

export function capabilityMatrix(provider = providerStatus()) {
  const issueExportReady = provider.linear === 'configured' || provider.github === 'configured';
  return [
    {
      id: 'idea-to-prd',
      label: 'Idea to PRD',
      status: 'ready',
      detail: 'Product idea input creates a structured PRD with goals, audience, scope, and validation notes.',
    },
    {
      id: 'task-breakdown',
      label: 'Task breakdown',
      status: 'ready',
      detail: 'The agent produces normalized tasks with owner, priority, estimate, and acceptance criteria.',
    },
    {
      id: 'tool-calling',
      label: 'Tool calling',
      status: 'ready',
      detail: 'Agent steps are recorded as tool-call logs, including validation, persistence, approval, and export.',
    },
    {
      id: 'human-approval',
      label: 'Human approval',
      status: 'ready',
      detail: 'Export is blocked until a reviewer approves individual tasks or the pending task batch.',
    },
    {
      id: 'streaming-trace',
      label: 'Streaming trace',
      status: 'ready',
      detail: 'The UI consumes SSE graph/log events while the agent is planning and creating tasks.',
    },
    {
      id: 'durable-state',
      label: 'Durable state',
      status: ['supabase', 'cloudflare-d1'].includes(provider.storage) ? 'ready' : 'fallback',
      detail:
        provider.storage === 'supabase'
          ? 'Supabase storage is configured for runs, PRDs, tasks, tool calls, and exports.'
          : provider.storage === 'cloudflare-d1'
            ? 'Cloudflare D1 storage is configured through the HTTP API for durable production state.'
            : 'JSON storage works locally; production durability requires Supabase or Cloudflare D1 environment variables.',
    },
    {
      id: 'workspace-isolation',
      label: 'Workspace isolation',
      status: 'ready',
      detail:
        'Each request can carry a workspace key so runs, tasks, approvals, and exports stay isolated per team workspace.',
    },
    {
      id: 'external-issues',
      label: 'Issue export',
      status: issueExportReady ? 'ready' : 'fallback',
      detail: issueExportReady
        ? 'At least one issue provider is configured for real issue creation.'
        : 'Linear/GitHub payloads are generated; real issue creation needs provider credentials.',
    },
    {
      id: 'llm-provider',
      label: 'LLM provider',
      status: provider.ai === 'local-planner' ? 'fallback' : 'ready',
      detail:
        provider.ai === 'local-planner'
          ? 'The deterministic planner is active; configure LangGraph, OpenRouter, FreeLLMAPI, or OpenAI for live LLM planning.'
          : `Live planner provider is ${provider.ai}.`,
    },
    {
      id: 'langgraph-backend',
      label: 'Python LangGraph',
      status: provider.langgraph === 'configured' ? 'ready' : 'fallback',
      detail:
        provider.langgraph === 'configured'
          ? 'FastAPI + LangGraph backend URL is configured as the first planner provider.'
          : 'FastAPI + LangGraph backend package is included; set LANGGRAPH_BACKEND_URL to delegate planning runs.',
    },
    {
      id: 'rag-memory',
      label: 'RAG and memory',
      status: 'ready',
      detail: 'A local knowledge retriever injects relevant product, task, approval, and integration context into agent planning.',
    },
    {
      id: 'evals-tracing',
      label: 'Agent evals',
      status: 'ready',
      detail: 'Eval cases exercise multiple product ideas and require PRD, tasks, retrieved context, approval gate, and blocked export.',
    },
    {
      id: 'external-tracing',
      label: 'Trace export',
      status: 'ready',
      detail: 'Structured trace export is available from /api/traces; hosted LangSmith ingestion can be added when credentials exist.',
    },
  ];
}

function hasEnv(name) {
  return Boolean(process.env[name]?.trim());
}

function cloudflareD1Configured() {
  return hasEnv('CLOUDFLARE_ACCOUNT_ID') && hasEnv('CLOUDFLARE_D1_DATABASE_ID') && hasEnv('CLOUDFLARE_API_TOKEN');
}

function aiPreflight() {
  if (hasEnv('LANGGRAPH_BACKEND_URL')) {
    try {
      new URL(process.env.LANGGRAPH_BACKEND_URL);
      return { status: 'ready', detail: 'FastAPI + LangGraph backend is configured as the planner.' };
    } catch {
      return {
        status: 'misconfigured',
        detail: 'LANGGRAPH_BACKEND_URL is not a valid URL.',
      };
    }
  }
  if (hasEnv('OPENROUTER_API_KEY')) {
    return { status: 'ready', detail: 'OpenRouter is configured for PRD and task generation.' };
  }
  const freeLlmPartial = hasEnv('FREELLMAPI_BASE_URL') || hasEnv('FREELLMAPI_API_KEY');
  if (freeLlmPartial && !(hasEnv('FREELLMAPI_BASE_URL') && hasEnv('FREELLMAPI_API_KEY'))) {
    return {
      status: 'misconfigured',
      detail: 'FreeLLMAPI fallback is partially configured; set both FREELLMAPI_BASE_URL and FREELLMAPI_API_KEY.',
    };
  }
  if (hasEnv('FREELLMAPI_BASE_URL') && hasEnv('FREELLMAPI_API_KEY')) {
    return { status: 'ready', detail: 'FreeLLMAPI-compatible planner is configured.' };
  }
  if (hasEnv('OPENAI_API_KEY')) {
    return { status: 'ready', detail: 'OpenAI planner is configured.' };
  }
  return {
    status: 'fallback',
    detail: 'No external LLM key is configured; deterministic local planner is active.',
  };
}

function storagePreflight() {
  const d1Partial = hasEnv('CLOUDFLARE_ACCOUNT_ID') || hasEnv('CLOUDFLARE_D1_DATABASE_ID') || hasEnv('CLOUDFLARE_API_TOKEN');
  if (cloudflareD1Configured()) {
    return {
      status: 'ready',
      detail: 'Cloudflare D1 HTTP API persistence is configured for runs, PRDs, tasks, logs, traces, and exports.',
    };
  }

  const hasUrl = hasEnv('SUPABASE_URL');
  const hasServiceRole = hasEnv('SUPABASE_SERVICE_ROLE_KEY');
  const hasPublicOnlyKey = hasEnv('SUPABASE_PUBLISHABLE_KEY') || hasEnv('SUPABASE_ANON_KEY');
  if (hasUrl && hasServiceRole) {
    try {
      new URL(process.env.SUPABASE_URL);
      return {
        status: 'ready',
        detail: 'Supabase service-role persistence is configured for runs, PRDs, tasks, logs, traces, and exports.',
      };
    } catch {
      return {
        status: 'misconfigured',
        detail: 'SUPABASE_URL is not a valid URL.',
      };
    }
  }
  if (d1Partial) {
    return {
      status: 'misconfigured',
      detail: 'Cloudflare D1 is partially configured; set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, and CLOUDFLARE_API_TOKEN.',
    };
  }
  if (hasUrl || hasServiceRole || hasPublicOnlyKey) {
    return {
      status: 'misconfigured',
      detail: 'Supabase persistence is partially configured; set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for the server-side write path.',
    };
  }
  return {
    status: 'fallback',
    detail: process.env.VERCEL
      ? 'Using volatile serverless JSON persistence in /tmp; configure Supabase or Cloudflare D1 env vars for durable production state.'
      : 'Using local JSON persistence; configure Supabase or Cloudflare D1 env vars for production serverless state.',
  };
}

function keyedPairPreflight({ configured, hasPrimary, hasSecondary, readyDetail, missingDetail, partialDetail }) {
  if (configured) return { status: 'ready', detail: readyDetail };
  if (hasPrimary || hasSecondary) return { status: 'misconfigured', detail: partialDetail };
  return { status: 'missing', detail: missingDetail };
}

function githubPreflight(configured) {
  const hasToken = hasEnv('GITHUB_TOKEN');
  const repository = process.env.GITHUB_REPOSITORY?.trim() || '';
  if (configured && /^[^/\s]+\/[^/\s]+$/.test(repository)) {
    return { status: 'ready', detail: 'GitHub token and repository are configured.' };
  }
  if (hasToken || repository) {
    if (repository && !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
      return {
        status: 'misconfigured',
        detail: 'GITHUB_REPOSITORY must use owner/repo format.',
      };
    }
    return {
      status: 'misconfigured',
      detail: 'GitHub export is partially configured; set both GITHUB_TOKEN and GITHUB_REPOSITORY.',
    };
  }
  return {
    status: 'missing',
    detail: 'Missing GITHUB_TOKEN or GITHUB_REPOSITORY; exports will remain payload-only.',
  };
}

function accessPreflight(configured) {
  if (configured) {
    return {
      status: 'ready',
      detail: 'Workspace data routes require x-ai-task-agent-access-token or Authorization bearer token.',
    };
  }
  return {
    status: 'fallback',
    detail:
      'Workspace routes are open for the public demo; set WORKSPACE_ACCESS_TOKEN for a private deployment or TEAM_WORKSPACES for private pilot workspaces.',
  };
}

function titleFromIdea(idea) {
  const firstSentence = idea.split(/[.!?\n]/).find(Boolean)?.trim() || 'SaaS Workflow';
  const base = firstSentence
    .replace(/^(a|an|the)\s+/i, '')
    .split(/\b(that|where|which|so users|so teams|with users)\b/i)[0]
    .replace(/\s+/g, ' ')
    .trim();
  const words = base.split(' ').filter(Boolean);
  const cleaned = words.slice(0, 8).join(' ') || 'SaaS Workflow';
  return `${toTitleCase(cleaned)} MVP`;
}

function toTitleCase(value) {
  return value
    .split(' ')
    .map((word) => (word ? `${word[0].toUpperCase()}${word.slice(1)}` : word))
    .join(' ');
}

function inferDomain(idea) {
  const lower = idea.toLowerCase();
  if (lower.includes('feedback') || lower.includes('request')) return 'customer feedback';
  if (lower.includes('onboarding')) return 'user onboarding';
  if (lower.includes('analytics') || lower.includes('dashboard')) return 'analytics';
  if (lower.includes('billing') || lower.includes('subscription')) return 'billing';
  if (lower.includes('crm') || lower.includes('sales') || lower.includes('forecast')) return 'sales';
  return 'SaaS';
}

export function localPlan(idea, { context = [] } = {}) {
  const domain = inferDomain(idea);
  const title = titleFromIdea(idea);
  const productNoun = title.replace(/\s+MVP$/, '');
  const taskBase = Number(Date.now().toString().slice(-4));
  const prd = {
    title,
    problem: `Teams need a structured way to turn "${idea.slice(0, 180)}${idea.length > 180 ? '...' : ''}" into clear product scope and engineering-ready work.`,
    audience:
      'Product managers, founders, engineering leads, designers, and operators working on SaaS product delivery.',
    goals: [
      `Define the core ${domain} workflow and success criteria.`,
      'Produce an implementation-ready task list with owners, priority, and acceptance criteria.',
      'Keep a human approval step before any issue export.',
      'Preserve a traceable tool-call log from idea to exported issue payload.',
    ],
    scope: [
      'Idea capture and PRD generation',
      'Task planning and DB persistence',
      'Approval and rejection workflow',
      'Export payloads for Linear and GitHub Issues',
      'Audit log for agent and tool calls',
    ],
    context,
    sourceIdea: idea,
    generatedBy: 'local-planner',
  };

  const taskTemplates = [
    {
      title: `Map the ${domain} workflow`,
      owner: 'Product UI',
      priority: 'High',
      effort: '3 pts',
      acceptance: `The primary ${domain} workflow is documented with entry point, happy path, empty state, and approval checkpoint.`,
    },
    {
      title: `Create data model for ${productNoun}`,
      owner: 'Backend',
      priority: 'High',
      effort: '5 pts',
      acceptance:
        'The backend stores idea, PRD, generated tasks, approval status, export target, and audit timestamps.',
    },
    {
      title: 'Build agent planning endpoint',
      owner: 'AI',
      priority: 'High',
      effort: '5 pts',
      acceptance:
        'POST /api/agent/run accepts a product idea, returns PRD plus tasks, and records tool-call logs.',
    },
    {
      title: 'Implement human approval queue',
      owner: 'Frontend',
      priority: 'High',
      effort: '3 pts',
      acceptance:
        'Users can approve or reject individual tasks, and the task DB reflects the persisted status immediately.',
    },
    {
      title: 'Generate Linear and GitHub issue payloads',
      owner: 'Integrations',
      priority: 'Medium',
      effort: '5 pts',
      acceptance:
        'Approved tasks export with title, labels, priority, source PRD, and acceptance criteria in provider-specific shape.',
    },
  ];

  return {
    prd,
    tasks: taskTemplates.map((task, index) => ({
      id: `TASK-${taskBase + index + 1}`,
      status: 'pending',
      createdAt: new Date().toISOString(),
      source: 'local-planner',
      ...task,
    })),
  };
}

export function exportPayload(target, prd, tasks) {
  const approved = tasks.filter((task) => task.status === 'approved');
  if (target === 'GitHub') {
    return approved.map((task) => ({
      sourceTaskId: task.id,
      title: task.title,
      labels: ['ai-task-agent', task.owner.toLowerCase().replaceAll(' ', '-')],
      body: [
        `Source PRD: ${prd?.title || 'Untitled PRD'}`,
        '',
        `Priority: ${task.priority}`,
        `Estimate: ${task.effort}`,
        '',
        'Acceptance criteria:',
        task.acceptance,
      ].join('\n'),
    }));
  }

  return approved.map((task) => ({
    sourceTaskId: task.id,
    title: task.title,
    description: `${task.acceptance}\n\nSource PRD: ${prd?.title || 'Untitled PRD'}`,
    priority: task.priority,
    estimate: task.effort,
    team: task.owner,
    labels: ['ai-task-agent', task.owner.toLowerCase().replaceAll(' ', '-')],
  }));
}

export function exportableApprovedTasks(target, tasks = [], exports = []) {
  const exportedIds = exportedTaskIdsForTarget(target, tasks, exports);
  return tasks.filter((task) => task.status === 'approved' && !exportedIds.has(task.id));
}

export function exportedTaskIdsForTarget(target, tasks = [], exports = []) {
  const ids = new Set();
  const titleToId = new Map(tasks.map((task) => [task.title, task.id]));

  for (const record of exports || []) {
    if (record.target !== target || !['created', 'partial-or-failed'].includes(record.status)) continue;
    const payload = Array.isArray(record.payload) ? record.payload : [];
    const delivery = Array.isArray(record.delivery) ? record.delivery : [];
    for (const [index, issue] of payload.entries()) {
      const delivered = record.status === 'created' || delivery[index]?.ok === true;
      if (!delivered) continue;
      const taskId = issue.sourceTaskId || titleToId.get(issue.title);
      if (taskId) ids.add(taskId);
    }
  }

  return ids;
}
