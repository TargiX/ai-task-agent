# AI Task Agent Walkthrough

This project is a small agentic SaaS prototype, built to be demoed from both the UI and the code.

## Live Workflow

```text
User product idea
  -> graph.input.accepted
  -> memory.retrieve_context
  -> planner.select_model
  -> generate_prd
  -> schema.validate_agent_output
  -> tasks.create_many
  -> interrupt.wait_for_human
  -> human.approve_task / human.reject_task
  -> linear.issue.create_batch / github.issues.create_batch
```

The important distinction is that side-effect actions are gated. The agent can plan, validate, persist draft tasks, and prepare export payloads, but issue creation only resumes after human approval.
Each run is also kept in history and can be resumed later as the active workspace.

## Code Tour

- Frontend workspace: `src/main.jsx`
  - Product idea input
  - Streaming agent timeline
  - PRD and retrieved context tab
  - Editable task DB
  - Human approval controls
  - Linear/GitHub export panel
  - Production preflight and setup state
  - Run history and resume controls

- Node API runtime: `lib/agent-runtime.js`, `lib/api-core.js`
  - Runs the default agent workflow used by Vercel functions.
  - Streams graph/log events from `POST /api/agent/stream`.
  - Persists runs through JSON, Supabase, or Cloudflare D1 storage.
  - Blocks export until at least one task is approved.
  - Exposes `GET /api/runs` and `POST /api/runs/select` for checkpoint-style resume.

- Planner/model routing: `lib/llm.js`
  - Tries FastAPI + LangGraph first when `LANGGRAPH_BACKEND_URL` is configured.
  - Falls back through OpenRouter, FreeLLMAPI-compatible proxies, OpenAI, then deterministic local planning.
  - Fetches and ranks free OpenRouter models by tool support, context length, and recency.

- Storage tools: `lib/storage.js`
  - JSON local fallback.
  - Supabase adapter.
  - Cloudflare D1 adapter through the D1 HTTP query API.
  - Persists PRDs, tasks, tool-call logs, approvals, and exports.

- Python agent backend: `backend/app/agents/graph.py`
  - Defines a LangGraph `StateGraph` when LangGraph is installed.
  - Uses typed graph state with `thread_id`, `idea`, `product_context`, PRD, tasks, graph trace, logs, and approval payload.
  - Keeps a fallback deterministic graph runner so tests and demos still work without optional packages.

- Python tools: `backend/app/tools/task_tools.py`
  - `validate_prd_tasks`
  - `create_many_tasks`
  - `approval_interrupt`
  - Exposed as LangChain tools when `langchain_core` is installed.

## Production Readiness

Required for a real deployed demo:

- Durable storage: Cloudflare D1 or Supabase
- Live LLM provider: OpenRouter, FreeLLMAPI-compatible gateway, OpenAI, or LangGraph backend
- Real issue export: Linear or GitHub credentials

Useful commands:

```bash
npm test
npm run backend:test
npm run eval:agent
npm run build
npm run smoke
npm run visual:smoke
npm run deploy:check
```

Cloudflare D1 path:

```bash
npm run d1:migrate
npm run d1:smoke
npm run vercel:env:sync -- --apply --scope=targixs-projects
BASE_URL=https://your-preview.vercel.app npm run production:smoke
```

## What To Show In A Demo

1. Run the app and enter a product idea.
2. Watch the streaming graph and tool-call log.
3. Generate a second idea and use Run history to resume the first one.
4. Open the PRD tab and show retrieved context.
5. Open the task DB, edit a task, approve/reject tasks.
6. Try exporting before approval to show the safety gate.
7. Approve a task and export to Linear/GitHub payloads or real issues.
8. Open `/api/preflight`, `/api/runs`, and `/api/traces`.
9. Walk through `backend/app/agents/graph.py` and `lib/agent-runtime.js`.

## Current Known Gap

The code is production-capable, but the hosted preview remains in JSON fallback mode until real D1/Supabase environment variables are set in Vercel. `npm run deploy:check` intentionally fails while that gap exists.
