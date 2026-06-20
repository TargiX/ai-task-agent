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
npm run supabase:smoke
```

Open `http://127.0.0.1:5173/`.

For deployed previews, run `BASE_URL=https://your-preview.vercel.app npm run smoke`.
Smoke scripts use an isolated workspace key by default. Set `SMOKE_WORKSPACE=your-key` when you want repeatable runs against the same test workspace.

For a production-readiness smoke after durable env vars are set, run:

```bash
BASE_URL=https://your-preview.vercel.app npm run production:smoke
```

For the full release path once production secrets are present:

```bash
npm run production:launch
npm run production:launch -- --apply --scope=targixs-projects
```

`production:launch` is dry-run by default. With `--apply`, it runs tests/evals/build, verifies the configured durable storage path, syncs Vercel env vars, and deploys a preview. If Cloudflare create credentials are present, it can create or reuse D1; if Supabase env vars are present, it runs `supabase:smoke` instead.

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
- This isolates runs, PRDs, tasks, approvals, exports, and run history per workspace.
- Set `WORKSPACE_ACCESS_TOKEN` to require `x-ai-task-agent-access-token` or `Authorization: Bearer <token>` for workspace data routes. `GET /api/health` and `GET /api/preflight` remain public readiness endpoints.
- For pilot teams on a public deployment, set `TEAM_WORKSPACES` to JSON such as `{"targix":{"label":"TargiX Product","token":"wat_team_secret"}}` or set `WORKSPACE_TEAM_TOKENS=targix:wat_team_secret:TargiX Product`. Requests for that workspace require the matching token, while guest workspaces stay open for the public demo. The same token also unlocks isolated sub-workspaces prefixed with the team key, such as `targix-smoke-20260620`, so private QA runs do not overwrite the main team workspace.
- Public demo workspaces are package-only for external systems. Real Linear/GitHub issue creation requires provider credentials plus guarded access mode, unless `ALLOW_PUBLIC_REAL_ISSUE_EXPORT=1` is intentionally set for a controlled test environment.

- `GET /api/workspace` returns PRD, tasks, graph trace, logs, exports, and provider status.
- `GET /api/runs` returns persisted run summaries for resume/history.
- `POST /api/runs/select` accepts `{ "runId": "..." }` and resumes that run as the active workspace.
- `GET /api/health` returns a deployment-safe health/readiness summary.
- `GET /api/preflight` returns production readiness checks without exposing secrets.
- `GET /api/team/workspaces` returns public metadata for configured private team workspaces without exposing tokens.
- `POST /api/team/session` accepts `{ "workspaceId": "...", "token": "..." }` and validates private team access.
- `GET /api/setup/verify` runs non-mutating runtime checks for API wiring, storage read/list, issue package generation, planner provider, and export provider readiness.
- `GET /api/integrations/verify` runs read-only GitHub repository and Linear team checks when credentials are configured, without creating issues.
- `GET /api/demo/report` runs an isolated in-memory demo of idea -> PRD -> tasks -> approval -> issue package -> trace without changing the active workspace.
- `GET /api/memory` returns the local planning knowledge base and sample retrieval.
- `POST /api/agent/run` accepts `{ "idea": "..." }` and creates PRD/tasks.
- `POST /api/agent/stream` accepts `{ "idea": "..." }` and streams graph/log/complete SSE events.
- `PATCH /api/tasks/:id` edits task fields and approval status.
- `PATCH /api/tasks/batch` updates approval status for multiple tasks.
- `GET /api/export-package?target=Linear|GitHub` prepares approved tasks as JSON and Markdown, including a `mode` contract: `package-only` or `real-issue-creation`.
- `POST /api/export` accepts `{ "target": "Linear" | "GitHub" }`.
- `DELETE /api/workspace` resets the JSON DB.

## Agent architecture

- `lib/agent-runtime.js` owns graph state, node execution, validation, and interrupt logs.
- `lib/llm.js` owns provider routing and tool-call planning across OpenRouter, FreeLLMAPI, OpenAI, and local fallback.
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
- `supabase` when `SUPABASE_URL` and server-only `SUPABASE_SERVICE_ROLE_KEY` are set.

LLM priority:

1. Python FastAPI + LangGraph backend (`LANGGRAPH_BACKEND_URL`)
2. OpenRouter (`OPENROUTER_API_KEY`)
3. FreeLLMAPI-compatible proxy (`FREELLMAPI_BASE_URL`, `FREELLMAPI_API_KEY`)
4. OpenAI-compatible chat tool calling (`OPENAI_API_KEY`)
5. Local planner fallback

LLM model discovery is available at `GET /api/llm/free-models`. With OpenRouter it returns the best free text models first; with FreeLLMAPI it calls the proxy's OpenAI-compatible `/v1/models` catalog. Live chat providers use a `create_prd_and_tasks` function tool so the model returns structured PRD/task arguments instead of free-form prose. `FREELLMAPI_BASE_URL` can be either `http://host:3001` or `http://host:3001/v1`.

## Supabase

Apply the migration in `supabase/migrations/0001_ai_task_agent.sql`.

The schema uses normalized tables:

- `agent_workspaces`
- `agent_runs`
- `agent_prds`
- `agent_tasks`
- `agent_tool_calls`
- `agent_exports`

RLS is enabled on all public tables. The migration revokes `anon` and `authenticated` table access and grants the app tables only to `service_role`, so keep `SUPABASE_SERVICE_ROLE_KEY` server-side only. Do not expose it through `NEXT_PUBLIC_`, `VITE_`, or client-rendered config.

Supabase verification path:

```bash
cp .env.example .env.production.local
# Fill SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
npm run supabase:smoke
npm run vercel:env:sync -- --apply --scope=targixs-projects
```

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
# Fill Cloudflare D1 or Supabase durable storage variables.
npm run vercel:env:sync
npm run vercel:env:sync -- --apply --scope=targixs-projects
```

`vercel:env:sync` is dry-run by default. With `--apply`, it writes present production variables to both Preview and Production environments through Vercel CLI.

For a scoped preparatory sync, use `--allow-partial --only=<comma-separated env names>`. For example, this enables the workspace access guard before durable storage and provider credentials are ready:

```bash
npm run vercel:env:sync -- --allow-partial --only=WORKSPACE_ACCESS_TOKEN --apply --scope=targixs-projects
```

Preview environment variables on Git-connected Vercel projects can be scoped with `--git-branch=main`. This local-deploy project is not connected to a Git repository yet, so Vercel only accepts `production` env writes until Git is connected; keep Preview in demo mode or connect Git before syncing Preview-only variables.

Production env init:

```bash
npm run production:env:init
```

This creates `.env.production.local` from `.env.example` when needed, generates a private `WORKSPACE_ACCESS_TOKEN`, preserves existing secrets, and reports only the remaining external credential groups. Use `-- --rotate-workspace-token` only when you intentionally want to invalidate the old workspace access token.

`deploy:check` reads `.env.production.local` by default, so the readiness doctor and `production:launch` report against the same production env source. Pass `-- --from=/path/to/env` to check a different env file.

Hosted smoke:

```bash
BASE_URL=https://your-preview.vercel.app npm run hosted:smoke
```

`hosted:smoke` validates health, preflight, setup verification, read-only integration verification, model discovery, and the dry-run demo report. For protected Vercel previews it automatically uses `vercel curl`, so Vercel Authentication can stay enabled. `production:launch -- --apply` runs this hosted smoke after deployment with durable storage, live LLM, issue export, and workspace access guard required.

Reference docs:

- [Cloudflare D1 overview](https://developers.cloudflare.com/d1/)
- [D1 query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

## Integrations

Without provider credentials, exports are `payload-only`.

`GET /api/preflight` reports provider readiness as `ready`, `fallback`, `missing`, or `misconfigured`, so malformed environment variables are visible before a demo or deploy.
It also returns a capability matrix that maps the original agentic-demo scope to the current implementation.

Set environment variables from `.env.example` to enable:

- Workspace access guard with `WORKSPACE_ACCESS_TOKEN`
- OpenRouter generation with `OPENROUTER_API_KEY`
- FreeLLMAPI-compatible proxy with `FREELLMAPI_BASE_URL` and `FREELLMAPI_API_KEY`
- OpenAI chat tool-call generation with `OPENAI_API_KEY`
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
- Optional workspace access token guard for production previews and pilots.
- Repeatable D1 migration, D1 smoke, Supabase smoke, Vercel env sync, and production smoke commands.
- Dry-run/apply production launch orchestration for tests, D1 setup, Vercel env sync, deploy, and final smoke handoff.
- Human approval gate before export.
- Editable task inspector and bulk approve/reject.
- Linear/GitHub issue payload export, with real API calls when env vars are configured.
- Agent eval cases plus health, preflight, smoke, visual smoke, and deploy-prereq checks.

Still roadmap:

- Long-term team memory and pgvector-backed semantic search.
- External tracing/LangSmith-style observability.
- Supplying real production secrets for D1, LLM provider, and issue export.
