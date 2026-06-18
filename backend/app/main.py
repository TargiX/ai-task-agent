from __future__ import annotations

from fastapi import FastAPI, HTTPException

from app.agents.graph import LANGGRAPH_AVAILABLE, run_agent_graph
from app.schemas import AgentRunRequest, AgentRunResponse
from app.storage import store

app = FastAPI(
    title="AI Task Agent Backend",
    version="0.1.0",
    description="FastAPI + LangGraph backend for PRD and task planning workflows.",
)


@app.get("/health")
async def health() -> dict:
    return {
        "ok": True,
        "service": "ai-task-agent-backend",
        "langgraph": "available" if LANGGRAPH_AVAILABLE else "fallback",
        "storage": "memory",
    }


@app.post("/agent/run", response_model=AgentRunResponse)
async def run_agent(payload: AgentRunRequest) -> dict:
    return await run_agent_graph(payload.message, payload.thread_id, payload.product_context)


@app.get("/agent/runs/{thread_id}", response_model=AgentRunResponse)
async def get_run(thread_id: str) -> dict:
    workspace = store.get(thread_id)
    if not workspace:
        raise HTTPException(status_code=404, detail="Run not found")
    return workspace
