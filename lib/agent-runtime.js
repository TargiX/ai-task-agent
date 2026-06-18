import { graphTrace, logEntry, providerStatus } from './domain.js';
import { planWithGateway } from './llm.js';
import { contextForPrd, retrieveContext } from './memory.js';

const MIN_TASKS = 4;
const MAX_TASKS = 8;

export async function runProductAgent({ idea, storage, onEvent }) {
  const state = {
    idea,
    prd: null,
    tasks: [],
    checks: [],
    logs: [],
    memory: null,
  };
  const emit = createEmitter(onEvent);

  await emit({
    type: 'graph',
    stage: 'draft',
    graph: graphTrace('draft'),
    message: 'Waiting for product idea',
  });
  await recordEvent(
    state,
    emit,
    'idea',
    'agent',
    'graph.input.accepted',
    'Captured user goal and initialized agent state',
  );
  await recordEvent(
    state,
    emit,
    'planner',
    'tool',
    'memory.retrieve_context',
    'Retrieving product planning context from the agent knowledge base',
  );
  state.memory = retrieveContext(idea);
  await recordEvent(
    state,
    emit,
    'planner',
    'agent',
    'planner.select_model',
    `Selected ${providerStatus().ai} planner adapter with ${state.memory.matches.length} retrieved context snippets`,
  );

  const plan = await planWithGateway(idea, { retrieval: state.memory });
  state.prd = {
    ...plan.prd,
    context: plan.prd.context || contextForPrd(state.memory),
    checks: [
      'Structured PRD generated from a user goal',
      `${state.memory.matches.length} retrieved planning context snippets used`,
      'Task schema validated before persistence',
      'Human approval required before export',
    ],
  };
  state.tasks = plan.tasks;
  await recordEvent(
    state,
    emit,
    'prd',
    'agent',
    `${plan.prd.generatedBy}.generate_prd`,
    `Generated PRD and ${plan.tasks.length} candidate tasks${plan.prd.model ? ` with ${plan.prd.model}` : ''}`,
  );
  await emit({
    type: 'graph',
    stage: 'tasks',
    graph: graphTrace('tasks'),
    message: `Planned ${plan.tasks.length} candidate tasks`,
  });

  for (const attempt of plan.attempts.filter((attempt) => attempt.error)) {
    await recordEvent(state, emit, 'tasks', 'agent', `${attempt.provider}.error`, attempt.error);
  }

  const validation = validateAgentOutput(state.prd, state.tasks);
  state.checks = validation.checks;
  state.tasks = validation.tasks;
  await recordEvent(
    state,
    emit,
    'validation',
    validation.ok ? 'tool' : 'agent',
    'schema.validate_agent_output',
    validation.ok
      ? `Validated ${state.tasks.length} tasks, priorities, estimates, and acceptance criteria`
      : validation.checks.join('; '),
  );

  await recordEvent(
    state,
    emit,
    'db',
    'tool',
    'tasks.create_many',
    `Persisting ${state.tasks.length} draft tasks in ${providerStatus().storage} storage`,
  );
  await recordEvent(
    state,
    emit,
    'planned',
    'agent',
    'interrupt.wait_for_human',
    'Agent paused before export until user approves tasks',
  );

  const workspace = await storage.saveRun({
    idea,
    prd: {
      ...state.prd,
      validation: state.checks,
    },
    tasks: state.tasks,
    graph: graphTrace('planned'),
    logs: state.logs,
  });

  return workspace;
}

function record(state, type, label, detail) {
  const log = logEntry(type, label, detail);
  state.logs.push(log);
  return log;
}

async function recordEvent(state, emit, stage, type, label, detail) {
  const log = record(state, type, label, detail);
  await emit({
    type: 'log',
    stage,
    graph: graphTrace(stage),
    log,
    message: detail,
  });
  return log;
}

function createEmitter(onEvent) {
  return async (event) => {
    if (!onEvent) return;
    await onEvent({
      id: `evt-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      createdAt: new Date().toISOString(),
      ...event,
    });
  };
}

function validateAgentOutput(prd, tasks) {
  const checks = [];
  const normalizedTasks = tasks
    .slice(0, MAX_TASKS)
    .map((task, index) => normalizeTask(task, index))
    .filter(Boolean);

  if (!prd?.title || !prd?.problem || !prd?.goals?.length) {
    checks.push('PRD is missing title, problem, or goals');
  }
  if (normalizedTasks.length < MIN_TASKS) {
    checks.push(`Task set has ${normalizedTasks.length} tasks; expected at least ${MIN_TASKS}`);
  }
  if (tasks.length > MAX_TASKS) {
    checks.push(`Trimmed task set from ${tasks.length} to ${MAX_TASKS} tasks`);
  }

  const missingAcceptance = normalizedTasks.filter((task) => task.acceptance.length < 24);
  if (missingAcceptance.length) {
    checks.push(`${missingAcceptance.length} tasks need stronger acceptance criteria`);
  }

  if (!checks.length) checks.push('All required agent output fields passed validation');
  return {
    ok: !checks.some((check) => check.includes('missing') || check.includes('expected')),
    checks,
    tasks: normalizedTasks,
  };
}

function normalizeTask(task, index) {
  if (!task?.title || !task?.acceptance) return null;
  const priority = ['High', 'Medium', 'Low'].includes(task.priority) ? task.priority : 'Medium';
  return {
    id: task.id || `TASK-${Date.now().toString().slice(-4)}-${index + 1}`,
    status: task.status || 'pending',
    createdAt: task.createdAt || new Date().toISOString(),
    source: task.source || task.generatedBy || 'agent',
    title: task.title,
    owner: task.owner || 'Product',
    priority,
    effort: task.effort || '3 pts',
    acceptance: task.acceptance,
    reviewNote: task.reviewNote || '',
  };
}
