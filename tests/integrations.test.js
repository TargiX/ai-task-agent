import assert from 'node:assert/strict';
import test from 'node:test';
import { preflightStatus } from '../lib/domain.js';
import { verifyIssueIntegrations } from '../lib/integration-verify.js';
import { createGitHubIssues, createLinearIssues } from '../lib/integrations.js';
import { getConfiguredFreeModels, planWithGateway } from '../lib/llm.js';

test('GitHub export creates issues with repository, token, labels, and body', async () => {
  const calls = [];
  const result = await createGitHubIssues(
    [
      {
        sourceTaskId: 'TASK-1',
        title: 'Build agent planning endpoint',
        body: 'Acceptance criteria',
        labels: ['ai-task-agent', 'ai'],
      },
    ],
    {
      env: { GITHUB_TOKEN: 'gh_token', GITHUB_REPOSITORY: 'owner/repo' },
      fetchImpl: async (url, options) => {
        calls.push({ url, options, body: JSON.parse(options.body) });
        return {
          ok: true,
          status: 201,
          json: async () => ({ id: 123, number: 42, html_url: 'https://github.com/owner/repo/issues/42' }),
        };
      },
    },
  );

  assert.equal(calls[0].url, 'https://api.github.com/repos/owner/repo/issues');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.authorization, 'Bearer gh_token');
  assert.deepEqual(calls[0].body.labels, ['ai-task-agent', 'ai']);
  assert.equal(calls[0].body.sourceTaskId, undefined);
  assert.deepEqual(result, [
    {
      ok: true,
      title: 'Build agent planning endpoint',
      sourceTaskId: 'TASK-1',
      id: 123,
      number: 42,
      url: 'https://github.com/owner/repo/issues/42',
    },
  ]);
});

test('GitHub export reports per-issue network failures instead of throwing', async () => {
  const result = await createGitHubIssues(
    [{ title: 'Issue title', body: 'Issue body' }],
    {
      env: { GITHUB_TOKEN: 'gh_token', GITHUB_REPOSITORY: 'owner/repo' },
      fetchImpl: async () => {
        throw new Error('socket closed');
      },
    },
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].ok, false);
  assert.equal(result[0].status, 'network');
  assert.match(result[0].error, /socket closed/);
});

test('Linear export creates enriched GraphQL issue payloads', async () => {
  const calls = [];
  const result = await createLinearIssues(
    [
      {
        sourceTaskId: 'TASK-9',
        title: 'Implement human approval queue',
        description: 'Users can approve generated tasks.',
        priority: 'High',
        estimate: '3 pts',
        labels: ['ai-task-agent', 'frontend'],
      },
    ],
    {
      env: { LINEAR_API_KEY: 'lin_token', LINEAR_TEAM_ID: 'team-id' },
      fetchImpl: async (url, options) => {
        calls.push({ url, options, body: JSON.parse(options.body) });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              issueCreate: {
                success: true,
                issue: { id: 'issue-id', identifier: 'ENG-12', title: 'Implement human approval queue', url: 'https://linear.app/x/ENG-12' },
              },
            },
          }),
        };
      },
    },
  );

  assert.equal(calls[0].url, 'https://api.linear.app/graphql');
  assert.equal(calls[0].options.headers.authorization, 'lin_token');
  assert.equal(calls[0].body.variables.input.teamId, 'team-id');
  assert.match(calls[0].body.variables.input.description, /Priority: High/);
  assert.match(calls[0].body.variables.input.description, /Estimate: 3 pts/);
  assert.match(calls[0].body.variables.input.description, /Labels: ai-task-agent, frontend/);
  assert.doesNotMatch(calls[0].body.variables.input.description, /sourceTaskId/);
  assert.equal(result[0].ok, true);
  assert.equal(result[0].identifier, 'ENG-12');
  assert.equal(result[0].sourceTaskId, 'TASK-9');
});

test('Linear export reports GraphQL errors per issue', async () => {
  const result = await createLinearIssues(
    [{ title: 'Issue title', description: 'Issue description' }],
    {
      env: { LINEAR_API_KEY: 'lin_token', LINEAR_TEAM_ID: 'team-id' },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ errors: [{ message: 'Invalid team id' }] }),
      }),
    },
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].ok, false);
  assert.equal(result[0].error, 'Invalid team id');
});

test('issue integration verifier checks GitHub repository and Linear team without creating issues', async () => {
  const calls = [];
  const verification = await verifyIssueIntegrations({
    env: {
      GITHUB_TOKEN: 'gh_token',
      GITHUB_REPOSITORY: 'owner/repo',
      LINEAR_API_KEY: 'lin_token',
      LINEAR_TEAM_ID: 'team-id',
    },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
      if (url === 'https://api.github.com/repos/owner/repo') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ full_name: 'owner/repo', private: true, has_issues: true }),
        };
      }
      if (url === 'https://api.linear.app/graphql') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { team: { id: 'team-id', key: 'ENG', name: 'Engineering' } } }),
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    },
  });

  assert.equal(verification.ok, true);
  assert.equal(verification.configured, 2);
  assert.equal(verification.providers.github.status, 'ready');
  assert.equal(verification.providers.linear.status, 'ready');
  assert.equal(calls[0].options.method, undefined);
  assert.equal(calls[1].body.query.includes('team(id: $id)'), true);
});

test('issue integration verifier reports missing, malformed, and failed providers safely', async () => {
  const missing = await verifyIssueIntegrations({ env: {}, fetchImpl: async () => assert.fail('fetch should not run') });
  assert.equal(missing.ok, false);
  assert.equal(missing.configured, 0);
  assert.equal(missing.providers.github.status, 'missing');
  assert.equal(missing.providers.linear.status, 'missing');

  const malformed = await verifyIssueIntegrations({
    env: { GITHUB_TOKEN: 'gh_token', GITHUB_REPOSITORY: 'not-owner-repo', LINEAR_API_KEY: 'lin_token' },
    fetchImpl: async () => assert.fail('fetch should not run for malformed env'),
  });
  assert.equal(malformed.providers.github.status, 'misconfigured');
  assert.equal(malformed.providers.linear.status, 'misconfigured');

  const failed = await verifyIssueIntegrations({
    env: { GITHUB_TOKEN: 'gh_token', GITHUB_REPOSITORY: 'owner/repo' },
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      json: async () => ({ message: 'Not Found' }),
    }),
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.configured, 1);
  assert.equal(failed.providers.github.status, 'failed');
  assert.equal(failed.providers.github.detail, 'Not Found');
});

test('LangGraph backend is the first planner provider when configured', async () => {
  const previousUrl = process.env.LANGGRAPH_BACKEND_URL;
  const previousFetch = global.fetch;
  process.env.LANGGRAPH_BACKEND_URL = 'http://127.0.0.1:8000';
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        prd: {
          title: 'Backend PRD',
          problem: 'Problem',
          audience: 'SaaS teams',
          goals: ['Goal'],
          scope: ['Scope'],
          sourceIdea: 'Idea',
          generatedBy: 'python-langgraph',
        },
        tasks: [
          {
            id: 'TASK-1',
            title: 'Backend task',
            owner: 'AI',
            priority: 'High',
            effort: '3 pts',
            acceptance: 'The backend task has clear acceptance criteria.',
            status: 'pending',
            createdAt: '2026-06-18T00:00:00.000Z',
            source: 'python-langgraph',
          },
        ],
      }),
    };
  };

  try {
    const plan = await planWithGateway('A product idea long enough for the backend planner.');

    assert.equal(calls[0].url, 'http://127.0.0.1:8000/agent/run');
    assert.equal(calls[0].body.message, 'A product idea long enough for the backend planner.');
    assert.equal(plan.prd.generatedBy, 'python-langgraph');
    assert.equal(plan.prd.model, 'fastapi-langgraph');
    assert.equal(plan.tasks[0].source, 'python-langgraph');
  } finally {
    global.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.LANGGRAPH_BACKEND_URL;
    else process.env.LANGGRAPH_BACKEND_URL = previousUrl;
  }
});

test('FreeLLMAPI discovery and planner use OpenAI-compatible /v1 endpoints', async () => {
  const previousFetch = global.fetch;
  const calls = [];

  try {
    await withRelevantEnv(
      {
        FREELLMAPI_BASE_URL: 'http://127.0.0.1:3001',
        FREELLMAPI_API_KEY: 'freellmapi-key',
        FREELLMAPI_MODEL: 'auto',
      },
      async () => {
        global.fetch = async (url, options = {}) => {
          calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
          if (url === 'http://127.0.0.1:3001/v1/models') {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                data: [
                  {
                    id: 'auto',
                    name: 'Auto Router',
                    context_length: 128000,
                    supported_parameters: ['tools'],
                  },
                ],
              }),
            };
          }
          if (url === 'http://127.0.0.1:3001/v1/chat/completions') {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        prd: {
                          title: 'FreeLLM PRD',
                          problem: 'Teams need planning support.',
                          audience: 'SaaS teams',
                          goals: ['Create a structured plan'],
                          scope: ['PRD', 'Tasks'],
                          sourceIdea: 'Idea',
                        },
                        tasks: [
                          {
                            title: 'Create FreeLLM task',
                            owner: 'AI',
                            priority: 'High',
                            effort: '3 pts',
                            acceptance: 'The FreeLLM task has clear acceptance criteria.',
                          },
                        ],
                      }),
                    },
                  },
                ],
              }),
            };
          }
          throw new Error(`Unexpected fetch ${url}`);
        };

        const catalog = await getConfiguredFreeModels({ only: 'freellmapi', strict: true });
        assert.equal(catalog.models[0].id, 'auto');
        assert.equal(catalog.models[0].source, 'freellmapi');
        assert.equal(catalog.sources[0].status, 'ready');

        const plan = await planWithGateway('A product idea long enough for the FreeLLMAPI planner.');
        assert.equal(plan.prd.generatedBy, 'freellmapi');
        assert.equal(plan.prd.model, 'auto');
        assert.equal(plan.tasks[0].source, 'freellmapi');
        const completion = calls.find((call) => call.url.endsWith('/chat/completions'));
        assert.equal(completion.body.model, 'auto');
        assert.equal(completion.body.tools[0].function.name, 'create_prd_and_tasks');
        assert.equal(completion.body.tool_choice.function.name, 'create_prd_and_tasks');
        assert.equal(calls.every((call) => call.options.headers.authorization === 'Bearer freellmapi-key'), true);
      },
    );
  } finally {
    global.fetch = previousFetch;
  }
});

test('OpenRouter planner selects a free tool-capable model and reads tool call arguments', async () => {
  const previousFetch = global.fetch;
  const calls = [];

  try {
    await withRelevantEnv({ OPENROUTER_API_KEY: 'openrouter-key' }, async () => {
      global.fetch = async (url, options = {}) => {
        calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
        if (url === 'https://openrouter.ai/api/v1/models?output_modalities=text') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: [
                {
                  id: 'free/no-tools',
                  name: 'Free No Tools',
                  pricing: { prompt: '0', completion: '0' },
                  context_length: 200000,
                  supported_parameters: [],
                  created: 2,
                },
                {
                  id: 'free/tools',
                  name: 'Free Tools',
                  pricing: { prompt: '0', completion: '0' },
                  context_length: 32000,
                  supported_parameters: ['tools'],
                  created: 1,
                },
              ],
            }),
          };
        }
        if (url === 'https://openrouter.ai/api/v1/chat/completions') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              choices: [
                {
                  message: {
                    tool_calls: [
                      {
                        id: 'call-plan',
                        type: 'function',
                        function: {
                          name: 'create_prd_and_tasks',
                          arguments: JSON.stringify(plannerToolArguments('OpenRouter PRD')),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
          };
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const plan = await planWithGateway('A product idea long enough for the OpenRouter planner.');
      const completion = calls.find((call) => call.url.endsWith('/chat/completions'));
      assert.equal(completion.body.model, 'free/tools');
      assert.equal(completion.body.tools[0].function.name, 'create_prd_and_tasks');
      assert.equal(completion.body.tool_choice.function.name, 'create_prd_and_tasks');
      assert.equal(completion.options.headers.authorization, 'Bearer openrouter-key');
      assert.equal(plan.prd.generatedBy, 'openrouter');
      assert.equal(plan.prd.title, 'OpenRouter PRD');
      assert.equal(plan.toolCall.name, 'create_prd_and_tasks');
    });
  } finally {
    global.fetch = previousFetch;
  }
});

test('OpenAI planner uses chat tool calling for PRD and task planning', async () => {
  const previousFetch = global.fetch;
  const calls = [];

  try {
    await withRelevantEnv({ OPENAI_API_KEY: 'openai-key', OPENAI_MODEL: 'gpt-4.1' }, async () => {
      global.fetch = async (url, options = {}) => {
        calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
        if (url === 'https://api.openai.com/v1/chat/completions') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              choices: [
                {
                  message: {
                    tool_calls: [
                      {
                        id: 'call-openai-plan',
                        type: 'function',
                        function: {
                          name: 'create_prd_and_tasks',
                          arguments: JSON.stringify(plannerToolArguments('OpenAI PRD')),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
          };
        }
        throw new Error(`Unexpected fetch ${url}`);
      };

      const plan = await planWithGateway('A product idea long enough for the OpenAI planner.');
      assert.equal(calls[0].body.model, 'gpt-4.1');
      assert.equal(calls[0].body.tools[0].function.name, 'create_prd_and_tasks');
      assert.equal(calls[0].options.headers.authorization, 'Bearer openai-key');
      assert.equal(plan.prd.generatedBy, 'openai');
      assert.equal(plan.prd.title, 'OpenAI PRD');
      assert.equal(plan.toolCall.name, 'create_prd_and_tasks');
    });
  } finally {
    global.fetch = previousFetch;
  }
});

test('preflight distinguishes fallback, missing, ready, and misconfigured env states', async () => {
  await withRelevantEnv({}, async () => {
    const preflight = preflightStatus();
    assert.equal(preflight.summary.ready, 1);
    assert.equal(preflight.summary.fallback, 3);
    assert.equal(preflight.summary.missing, 2);
    assert.equal(preflight.summary.misconfigured, 0);
  });

  await withRelevantEnv(
    {
      OPENROUTER_API_KEY: 'openrouter',
      SUPABASE_URL: 'not-a-url',
      GITHUB_TOKEN: 'token',
      GITHUB_REPOSITORY: 'wrong-format',
      LINEAR_API_KEY: 'linear-token',
    },
    async () => {
      const preflight = preflightStatus();
      assert.equal(preflight.checks.find((check) => check.id === 'ai-provider').status, 'ready');
      assert.equal(preflight.checks.find((check) => check.id === 'storage').status, 'misconfigured');
      assert.equal(preflight.checks.find((check) => check.id === 'github').status, 'misconfigured');
      assert.equal(preflight.checks.find((check) => check.id === 'linear').status, 'misconfigured');
    },
  );

  await withRelevantEnv({ LANGGRAPH_BACKEND_URL: 'http://127.0.0.1:8000' }, async () => {
    const preflight = preflightStatus();
    assert.equal(preflight.provider.ai, 'langgraph');
    assert.equal(preflight.checks.find((check) => check.id === 'ai-provider').status, 'ready');
    assert.equal(preflight.capabilities.find((item) => item.id === 'langgraph-backend').status, 'ready');
  });

  await withRelevantEnv({ LANGGRAPH_BACKEND_URL: 'not-a-url' }, async () => {
    const preflight = preflightStatus();
    assert.equal(preflight.checks.find((check) => check.id === 'ai-provider').status, 'misconfigured');
  });

  await withRelevantEnv(
    {
      CLOUDFLARE_ACCOUNT_ID: 'cf-account',
      CLOUDFLARE_D1_DATABASE_ID: 'cf-d1-db',
      CLOUDFLARE_API_TOKEN: 'cf-token',
    },
    async () => {
      const preflight = preflightStatus();
      assert.equal(preflight.provider.storage, 'cloudflare-d1');
      assert.equal(preflight.checks.find((check) => check.id === 'storage').status, 'ready');
      assert.equal(preflight.capabilities.find((item) => item.id === 'durable-state').status, 'ready');
      assert.equal(preflight.setup.groups.find((item) => item.id === 'durable-storage').status, 'ready');
    },
  );

  await withRelevantEnv({ CLOUDFLARE_D1_DATABASE_ID: 'cf-d1-db' }, async () => {
    const preflight = preflightStatus();
    assert.equal(preflight.checks.find((check) => check.id === 'storage').status, 'misconfigured');
    assert.match(preflight.checks.find((check) => check.id === 'storage').detail, /Cloudflare D1 is partially configured/);
  });

  await withRelevantEnv({ VERCEL: '1' }, async () => {
    const preflight = preflightStatus();
    const storage = preflight.checks.find((check) => check.id === 'storage');
    assert.equal(storage.status, 'fallback');
    assert.match(storage.detail, /volatile serverless JSON persistence/);
  });
});

async function withRelevantEnv(values, callback) {
  const names = [
    'OPENROUTER_API_KEY',
    'OPENROUTER_MODEL',
    'LANGGRAPH_BACKEND_URL',
    'FREELLMAPI_BASE_URL',
    'FREELLMAPI_API_KEY',
    'FREELLMAPI_MODEL',
    'OPENAI_API_KEY',
    'OPENAI_MODEL',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_PUBLISHABLE_KEY',
    'SUPABASE_ANON_KEY',
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_D1_DATABASE_ID',
    'CLOUDFLARE_API_TOKEN',
    'GITHUB_TOKEN',
    'GITHUB_REPOSITORY',
    'LINEAR_API_KEY',
    'LINEAR_TEAM_ID',
    'VERCEL',
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  Object.assign(process.env, values);
  try {
    await callback();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

function plannerToolArguments(title) {
  return {
    prd: {
      title,
      problem: 'Teams need planning support.',
      audience: 'SaaS teams',
      goals: ['Create a structured plan'],
      scope: ['PRD', 'Tasks'],
      sourceIdea: 'Idea',
    },
    tasks: [
      {
        title: 'Create planning task',
        owner: 'AI',
        priority: 'High',
        effort: '3 pts',
        acceptance: 'The planning task has clear acceptance criteria.',
      },
    ],
  };
}
