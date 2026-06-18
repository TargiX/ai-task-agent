from __future__ import annotations

from typing import Any, Dict, List

from app.planner import validate_agent_output

def validate_prd_tasks(prd: Dict[str, Any], tasks: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Validate generated PRD and tasks before persistence."""
    return validate_agent_output(prd, tasks)


def create_many_tasks(tasks: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Prepare generated tasks for durable persistence."""
    return {
        "count": len(tasks),
        "taskIds": [task["id"] for task in tasks],
        "status": "prepared",
    }


def approval_interrupt(tasks: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Return the human approval payload for generated tasks."""
    return {
        "required": True,
        "status": "waiting",
        "message": "Approve or reject generated tasks before issue export.",
        "taskIds": [task["id"] for task in tasks],
    }


try:
    from langchain_core.tools import tool
except ImportError:
    tool = None


LANGCHAIN_TOOLS: List[Any] = (
    [tool(validate_prd_tasks), tool(create_many_tasks), tool(approval_interrupt)] if tool else []
)
