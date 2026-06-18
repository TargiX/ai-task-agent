import { localPlan } from './domain.js';
import { contextForPrd, formatRetrievedContext } from './memory.js';

const PLANNER_SYSTEM_PROMPT =
  'You are an AI product planning agent. Use the create_prd_and_tasks tool to return a structured PRD and exactly 5 implementation tasks. Keep tasks actionable for a SaaS product team.';
const PLANNER_TOOL_NAME = 'create_prd_and_tasks';
const PLANNER_TOOLS = [
  {
    type: 'function',
    function: {
      name: PLANNER_TOOL_NAME,
      description: 'Create a PRD and normalized engineering task list from a product idea.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['prd', 'tasks'],
        properties: {
          prd: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'problem', 'audience', 'goals', 'scope', 'sourceIdea'],
            properties: {
              title: { type: 'string' },
              problem: { type: 'string' },
              audience: { type: 'string' },
              goals: { type: 'array', items: { type: 'string' } },
              scope: { type: 'array', items: { type: 'string' } },
              sourceIdea: { type: 'string' },
            },
          },
          tasks: {
            type: 'array',
            minItems: 5,
            maxItems: 5,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'owner', 'priority', 'effort', 'acceptance'],
              properties: {
                title: { type: 'string' },
                owner: { type: 'string' },
                priority: { type: 'string', enum: ['High', 'Medium', 'Low'] },
                effort: { type: 'string' },
                acceptance: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
];
const PLANNER_TOOL_CHOICE = {
  type: 'function',
  function: { name: PLANNER_TOOL_NAME },
};

export async function planWithGateway(idea, { retrieval = null } = {}) {
  const attempts = [];
  for (const planner of [langGraphBackendPlan, openRouterPlan, freeLlmApiPlan, openAiPlan]) {
    try {
      const plan = await planner(idea, retrieval);
      if (plan) return { ...plan, attempts };
    } catch (error) {
      attempts.push({ provider: planner.name, error: error.message });
    }
  }

  const plan = localPlan(idea, { context: retrieval ? contextForPrd(retrieval) : [] });
  attempts.push({ provider: 'localPlan', ok: true });
  return { ...plan, attempts };
}

async function langGraphBackendPlan(idea, retrieval) {
  if (!process.env.LANGGRAPH_BACKEND_URL) return null;
  const baseUrl = process.env.LANGGRAPH_BACKEND_URL.replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/agent/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      thread_id: `node-${Date.now()}`,
      message: idea,
      product_context: retrieval ? formatRetrievedContext(retrieval) : 'AI Task Agent SaaS planning workflow',
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LangGraph backend ${response.status}: ${body.slice(0, 400)}`);
  }
  const json = await response.json();
  if (!json.prd || !Array.isArray(json.tasks)) {
    throw new Error('LangGraph backend response is missing prd or tasks');
  }
  return normalizePlan(
    {
      prd: json.prd,
      tasks: json.tasks,
    },
    'python-langgraph',
    'fastapi-langgraph',
  );
}

export async function getConfiguredFreeModels({ only = null, strict = false } = {}) {
  const sources = [];
  const errors = [];

  async function loadSource(id, loader) {
    try {
      const models = await loader();
      sources.push({ id, status: 'ready', count: models.length });
      return models.map((model) => ({ ...model, source: id }));
    } catch (error) {
      errors.push({ source: id, error: error.message });
      sources.push({ id, status: 'failed', error: error.message, count: 0 });
      if (strict) throw error;
      return [];
    }
  }

  const models = [];
  if ((!only || only === 'openrouter') && process.env.OPENROUTER_API_KEY) {
    models.push(...(await loadSource('openrouter', getFreeOpenRouterModels)));
  }
  if ((!only || only === 'freellmapi') && process.env.FREELLMAPI_BASE_URL && process.env.FREELLMAPI_API_KEY) {
    models.push(...(await loadSource('freellmapi', getFreeLlmApiModels)));
  }

  return {
    models: models.sort(scoreFreeModel),
    sources,
    errors,
  };
}

export async function getFreeOpenRouterModels() {
  if (!process.env.OPENROUTER_API_KEY) return [];
  const response = await fetch('https://openrouter.ai/api/v1/models?output_modalities=text', {
    headers: {
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter models ${response.status}: ${body.slice(0, 300)}`);
  }

  const json = await response.json();
  return (json.data || [])
    .filter((model) => {
      const prompt = Number(model.pricing?.prompt ?? 1);
      const completion = Number(model.pricing?.completion ?? 1);
      return prompt === 0 && completion === 0;
    })
    .map((model) => ({
      id: model.id,
      name: model.name,
      contextLength: model.context_length || model.top_provider?.context_length || 0,
      supportedParameters: model.supported_parameters || [],
      created: model.created || 0,
    }))
    .sort(scoreFreeModel);
}

export async function getFreeLlmApiModels() {
  if (!process.env.FREELLMAPI_BASE_URL || !process.env.FREELLMAPI_API_KEY) return [];
  const response = await fetch(`${normalizeOpenAiBaseUrl(process.env.FREELLMAPI_BASE_URL)}/models`, {
    headers: {
      authorization: `Bearer ${process.env.FREELLMAPI_API_KEY}`,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`FreeLLMAPI models ${response.status}: ${body.slice(0, 300)}`);
  }

  const json = await response.json();
  const models = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
  return models
    .map((model) => ({
      id: model.id || model.name,
      name: model.name || model.id,
      contextLength: model.context_length || model.contextLength || model.top_provider?.context_length || 0,
      supportedParameters: model.supported_parameters || model.supportedParameters || [],
      created: model.created || 0,
    }))
    .filter((model) => model.id)
    .sort(scoreFreeModel);
}

function scoreFreeModel(a, b) {
  const aTool = a.supportedParameters.includes('tools') ? 1 : 0;
  const bTool = b.supportedParameters.includes('tools') ? 1 : 0;
  if (aTool !== bTool) return bTool - aTool;
  if (a.contextLength !== b.contextLength) return b.contextLength - a.contextLength;
  return b.created - a.created;
}

async function openRouterPlan(idea, retrieval) {
  if (!process.env.OPENROUTER_API_KEY) return null;
  const model = process.env.OPENROUTER_MODEL || (await getFreeOpenRouterModels())[0]?.id || 'openrouter/free';
  const json = await chatCompletion({
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    model,
    messages: plannerMessages(idea, retrieval),
    headers: {
      'HTTP-Referer': process.env.PUBLIC_APP_URL || 'http://localhost:5173',
      'X-Title': 'AI Task Agent',
    },
  });
  const { payload, toolCall } = extractPlannerPayload(json);
  return { ...normalizePlan(payload, 'openrouter', model), toolCall };
}

async function freeLlmApiPlan(idea, retrieval) {
  if (!process.env.FREELLMAPI_BASE_URL || !process.env.FREELLMAPI_API_KEY) return null;
  const model = process.env.FREELLMAPI_MODEL || 'auto';
  const json = await chatCompletion({
    baseUrl: normalizeOpenAiBaseUrl(process.env.FREELLMAPI_BASE_URL),
    apiKey: process.env.FREELLMAPI_API_KEY,
    model,
    messages: plannerMessages(idea, retrieval),
  });
  const { payload, toolCall } = extractPlannerPayload(json);
  return { ...normalizePlan(payload, 'freellmapi', model), toolCall };
}

async function openAiPlan(idea, retrieval) {
  if (!process.env.OPENAI_API_KEY) return null;
  const model = process.env.OPENAI_MODEL || 'gpt-4.1';
  const json = await chatCompletion({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY,
    model,
    messages: plannerMessages(idea, retrieval),
  });
  const { payload, toolCall } = extractPlannerPayload(json);
  return { ...normalizePlan(payload, 'openai', model), toolCall };
}

async function chatCompletion({ baseUrl, apiKey, model, messages, headers = {} }) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      tools: PLANNER_TOOLS,
      tool_choice: PLANNER_TOOL_CHOICE,
      parallel_tool_calls: false,
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${baseUrl} ${response.status}: ${body.slice(0, 400)}`);
  }
  return response.json();
}

function normalizeOpenAiBaseUrl(value) {
  const baseUrl = value.replace(/\/+$/, '');
  return /\/v\d+$/i.test(baseUrl) ? baseUrl : `${baseUrl}/v1`;
}

function plannerMessages(idea, retrieval) {
  return [
    { role: 'system', content: PLANNER_SYSTEM_PROMPT },
    { role: 'user', content: plannerUserMessage(idea, retrieval) },
  ];
}

function plannerUserMessage(idea, retrieval) {
  const context = retrieval?.matches?.length ? `\n\nRetrieved planning context:\n${formatRetrievedContext(retrieval)}` : '';
  return `Product idea:\n${idea}${context}`;
}

function normalizePlan(plan, provider, model) {
  return {
    prd: { ...plan.prd, generatedBy: provider, model },
    tasks: plan.tasks.map((task, index) => ({
      id: `TASK-${Date.now().toString().slice(-4)}-${index + 1}`,
      status: 'pending',
      createdAt: new Date().toISOString(),
      source: provider,
      ...task,
    })),
  };
}

function extractPlannerPayload(response) {
  const message = response.choices?.[0]?.message || {};
  const toolCall =
    message.tool_calls?.find((call) => call.function?.name === PLANNER_TOOL_NAME) || message.tool_calls?.[0];
  if (toolCall?.function?.arguments) {
    return {
      payload: parseJsonObject(toolCall.function.arguments),
      toolCall: {
        id: toolCall.id || null,
        name: toolCall.function.name || PLANNER_TOOL_NAME,
      },
    };
  }

  return {
    payload: parseJsonObject(message.content || ''),
    toolCall: null,
  };
}

function parseJsonObject(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) throw new Error('No JSON object found');
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}
