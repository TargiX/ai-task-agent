from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


class AgentRunRequest(BaseModel):
    thread_id: str = Field(default="default", min_length=1)
    message: str = Field(min_length=12)
    product_context: Optional[str] = None


class Prd(BaseModel):
    title: str
    problem: str
    audience: str
    goals: List[str]
    scope: List[str]
    context: List[str] = []
    sourceIdea: str
    generatedBy: str
    model: Optional[str] = None
    validation: List[str] = []
    checks: List[str] = []


class AgentTask(BaseModel):
    id: str
    title: str
    owner: str
    priority: Literal["High", "Medium", "Low"]
    effort: str
    acceptance: str
    status: Literal["pending", "approved", "rejected"] = "pending"
    source: str
    createdAt: str
    reviewNote: str = ""


class AgentRunResponse(BaseModel):
    threadId: str
    idea: str
    prd: Prd
    tasks: List[AgentTask]
    graph: List[Dict[str, Any]]
    logs: List[Dict[str, Any]]
    exports: List[Dict[str, Any]]
    provider: Dict[str, str]
    approval: Dict[str, Any]
