# AI Task Agent

Small SaaS team workflow agent:

1. User writes a product idea.
2. Backend agent generates a PRD and task breakdown.
3. A graph-style runtime validates output and calls the task persistence tool.
4. User edits, approves, or rejects tasks with review notes.
5. Export creates Linear/GitHub issue payloads, or real issues when credentials are configured.

The current implementation is a Vercel-friendly Node runtime that mirrors a LangGraph flow:

```text
user goal
  -> graph.input.accepted
  -> planner.select_model
  -> generate_prd
  -> schema.validate_agent_output
  -> tasks.create_many
  -> interrupt.wait_for_human
  -> human.approve_task / human.reject_task
  -> linear.issue.create_batch / github.issues.create_batch
```

The runtime lives in `lib/agent-runtime.js`. It is intentionally separated from `lib/api-core.js` so it can later be moved to a Python `FastAPI + LangGraph` service without changing the product UI contract. The UI uses `POST /api/agent/stream` for live SSE graph/tool-call progress and falls back to `POST /api/agent/run` if streaming is unavailable.

For an interview-style code walkthrough, see `docs/agent-walkthrough.md`.

## Run locally

```bash
npm install
npm test
npm run backend:test
npm run eval:agent
npm run build
npm run preview -- --port 5173
npm run smoke
npm run stress:smoke
npm run visual:smoke
npm run deploy:check
npm run d1:migrate -- --dry-run
```

Open `http://127.0.0.1:5173/`.

For deployed previews, run `BASE_URL=https://your-preview.vercel.app npm run smoke`.

For a production-readiness smoke after durable env vars are set, run:

```bash
BASE_URL=https://your-preview.vercel.app npm run production:smoke
```

For the full release path once production secrets are present:

```bash
npm run production:launch
npm run production:launch -- --apply --scope=targixs-projects
```

`production:launch` is dry-run by default. With `--apply`, it runs tests/evals/build, creates or reuses Cloudflare D1, verifies D1, syncs Vercel env vars, and deploys a preview.

`npm run visual:smoke` opens the app with Playwright, runs the agent once, checks the readiness UI,
guards against horizontal overflow, and writes screenshots into `qa/`.

`npm run stress:smoke` fires concurrent JSON and streaming agent runs against the local API to catch dev-server crashes, JSON fallback races, and SSE failure regressions.

`npm run deploy:check` verifies local deploy prerequisites: Vercel CLI/link, git remote,
durable storage, live LLM provider fallback, and Linear/GitHub export readiness.

## API

Team workspace isolation:

- Requests may include `x-ai-task-agent-workspace: your-team-key`.
- Empty, `default`, or no header uses the default workspace.
- The React UI stores the workspace key locally and sends it with all API and SSE requests.
- This isolates runs, PRDs, tasks, approvals, exports, and run history per workspace. It is not a replacement for production user authentication.

- `GET /api/workspace` returns PRD, tasks, graph trace, logs, exports, and provider status.
- `GET /api/runs` returns persisted run summaries for resume/history.
- `POST /api/runs/select` accepts `{ "runId": "..." }` and resumes that run as the active workspace.
- `GET /api/health` returns a deployment-safe health/readiness summary.
- `GET /api/preflight` returns production readiness checks without exposing secrets.
- `GET /api/setup/verify` runs non-mutating runtime checks for API wiring, storage read/list, issue package generation, planner provider, and export provider readiness.
- `GET /api/integrations/verify` runs read-only GitHub repository and Linear team checks when credentials are configured, without creating issues.
- `GET /api/demo/report` runs an isolated in-memory demo of idea -> PRD -> tasks -> approval -> issue package -> trace without changing the active workspace.
- `GET /api/memory` returns the local planning knowledge base and sample retrieval.
- `POST /api/agent/run` accepts `{ "idea": "..." }` and creates PRD/tasks.
- `POST /api/agent/stream` accepts `{ "idea": "..." }` and streams graph/log/complete SSE events.
- `PATCH /api/tasks/:id` edits task fields and approval status.
- `PATCH /api/tasks/batch` updates approval status for multiple tasks.
- `POST /api/export` accepts `{ "target": "Linear" | "GitHub" }`.
- `DELETE /api/workspace` resets the JSON DB.

## Agent architecture

- `lib/agent-runtime.js` owns graph state, node execution, validation, and interrupt logs.
- `lib/llm.js` owns provider routing across OpenRouter, FreeLLMAPI, OpenAI, and local fallback.
- `lib/storage.js` owns JSON, Supabase, and Cloudflare D1 persistence.
- `lib/integrations.js` owns Linear and GitHub issue creation.
- `lib/domain.js` owns graph trace shape, provider status, fallback planning, and export payload shape.

Human-in-the-loop is real application state: export is blocked until at least one task has `approved` status, and each approval/rejection is persisted with a tool-call log.
Runs are kept in history so a previous PRD/task set can be resumed instead of overwritten by the next idea.

The agent also retrieves planning context from a local knowledge base before generating the PRD.
Retrieved snippets are written into `prd.context`, shown in the PRD tab, and logged as `memory.retrieve_context`.

## Python backend

The repo includes a separate `backend/` package for the interview-grade FastAPI + LangGraph layer.
It exposes the same PRD/task/log contract as the Node runtime:

```bash
cd backend
python3 -m venv .venv
. .venv/bin/activate
pip install -e ".[test]"
uvicorn app.main:app --reload --port 8000
```

Docker alternative:

```bash
docker build -t ai-task-agent-backend ./backend
docker run --rm -p 8000:8000 ai-task-agent-backend
```

Endpoints:

- `GET /health`
- `POST /agent/run` with `{ "thread_id": "demo", "message": "..." }`
- `GET /agent/runs/{thread_id}`

Set `LANGGRAPH_BACKEND_URL=http://127.0.0.1:8000` in `.env.local` to make the Node API use the
Python backend as the first planner provider. If it fails, the agent records the backend error and
continues through OpenRouter, FreeLLMAPI, OpenAI, and the deterministic local planner.

## Vercel + Supabase/D1 + OpenRouter

The app is deployable as a Vite static frontend plus Vercel Serverless Functions in `api/`.

Storage mode:

- `json` locally when durable storage env vars are absent.
- `json` on Vercel writes to `/tmp` and is only a volatile demo fallback.
- `cloudflare-d1` when `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_DATABASE_ID`, and `CLOUDFLARE_API_TOKEN` are set.
- `supabase` when `SUPABASE_URL` and one of `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_PUBLISHABLE_KEY`, or `SUPABASE_ANON_KEY` is set.

LLM priority:

1. Python FastAPI + LangGraph backend (`LANGGRAPH_BACKEND_URL`)
2. OpenRouter (`OPENROUTER_API_KEY`)
3. FreeLLMAPI-compatible proxy (`FREELLMAPI_BASE_URL`, `FREELLMAPI_API_KEY`)
4. OpenAI Responses API (`OPENAI_API_KEY`)
5. Local planner fallback

LLM model discovery is available at `GET /api/llm/free-models`. With OpenRouter it returns the best free text models first; with FreeLLMAPI it calls the proxy's OpenAI-compatible `/v1/models` catalog. `FREELLMAPI_BASE_URL` can be either `http://host:3001` or `http://host:3001/v1`.

## Supabase

Apply the migration in `supabase/migrations/0001_ai_task_agent.sql`.

The schema uses normalized tables:

- `agent_workspaces`
- `agent_runs`
- `agent_prds`
- `agent_tasks`
- `agent_tool_calls`
- `agent_exports`

RLS is enabled on all public tables. Prefer `SUPABASE_SERVICE_ROLE_KEY` server-side only. For a public demo, publishable/anon keys can work if the demo policies in the migration are enabled.

## Cloudflare D1

Cloudflare D1 is the lightweight durable-storage alternative for this project. The adapter uses the official D1 HTTP query endpoint from Vercel Serverless Functions, so no Cloudflare Worker is required for this MVP.

Schema:

- `cloudflare/d1/schema.sql`

Environment:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_D1_DATABASE_ID`
- `CLOUDFLARE_API_TOKEN`
- Optional setup hints: `CLOUDFLARE_D1_DATABASE_NAME=ai-task-agent`, `CLOUDFLARE_D1_PRIMARY_LOCATION_HINT=apac`

The app also auto-creates the D1 tables and indexes on first storage access. You can still apply `cloudflare/d1/schema.sql` manually through Wrangler or the Cloudflare dashboard before deploy.

CLI path:

```bash
npm run d1:setup -- --dry-run
npm run d1:setup -- --name=ai-task-agent --location=apac --write-env
npm run d1:migrate
npm run d1:smoke
```

`d1:setup` uses Cloudflare's REST API to list existing D1 databases by name, create the database when it is missing, apply the schema, and optionally write `.env.production.local`. It requires `CLOUDFLARE_ACCOUNT_ID` and a `CLOUDFLARE_API_TOKEN` with D1 read/write access. If `CLOUDFLARE_D1_DATABASE_ID` is already set, it reuses that database and only runs the schema/smoke steps.

Vercel env sync path:

```bash
cp .env.example .env.production.local
# Fill CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_D1_DATABASE_ID, CLOUDFLARE_API_TOKEN.
npm run vercel:env:sync
npm run vercel:env:sync -- --apply --scope=targixs-projects
```

`vercel:env:sync` is dry-run by default. With `--apply`, it writes present production variables to both Preview and Production environments through Vercel CLI.

Reference docs:

- [Cloudflare D1 overview](https://developers.cloudflare.com/d1/)
- [D1 query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

## Integrations

Without provider credentials, exports are `payload-only`.

`GET /api/preflight` reports provider readiness as `ready`, `fallback`, `missing`, or `misconfigured`, so malformed environment variables are visible before a demo or deploy.
It also returns a capability matrix that maps the original agentic-demo scope to the current implementation.

Set environment variables from `.env.example` to enable:

- OpenRouter generation with `OPENROUTER_API_KEY`
- FreeLLMAPI-compatible proxy with `FREELLMAPI_BASE_URL` and `FREELLMAPI_API_KEY`
- OpenAI Responses API generation with `OPENAI_API_KEY`
- Cloudflare D1 storage with `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_DATABASE_ID`, and `CLOUDFLARE_API_TOKEN`
- GitHub issue creation with `GITHUB_TOKEN` and `GITHUB_REPOSITORY`
- Linear issue creation with `LINEAR_API_KEY` and `LINEAR_TEAM_ID`

Integration request contracts are covered by `npm test` with mocked GitHub and Linear responses.

The JSON DB is stored at `data/task-agent-db.json`.

The local Node server auto-loads `.env` and `.env.local` if present. Never commit real secrets; use `.env.example` as the tracked template.

## Scope coverage

Implemented:

- Product idea to structured PRD.
- PRD to validated task breakdown.
- Graph-style runtime with streamed trace/log events.
- Python FastAPI + LangGraph backend package with matching run contract.
- Tool-call logs for validation, persistence, approval, and export.
- Local RAG-style planning memory with retrieved PRD context.
- Local JSON storage plus Supabase and Cloudflare D1 storage adapters and schemas.
- Run history and resume across JSON, Supabase, and Cloudflare D1 storage.
- Workspace-key isolation for team runs across JSON, Supabase, and Cloudflare D1 storage.
- Repeatable D1 migration, D1 smoke, Vercel env sync, and production smoke commands.
- Dry-run/apply production launch orchestration for tests, D1 setup, Vercel env sync, deploy, and final smoke handoff.
- Human approval gate before export.
- Editable task inspector and bulk approve/reject.
- Linear/GitHub issue payload export, with real API calls when env vars are configured.
- Agent eval cases plus health, preflight, smoke, visual smoke, and deploy-prereq checks.

Still roadmap:

- Long-term team memory and pgvector-backed semantic search.
- External tracing/LangSmith-style observability.
- Supplying real production secrets for D1, LLM provider, and issue export.
