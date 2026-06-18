from __future__ import annotations

from typing import Any, Dict, List, Optional, TypedDict

from app.planner import graph_trace, local_plan, log_entry
from app.storage import store
from app.tools.task_tools import approval_interrupt, create_many_tasks, validate_prd_tasks

try:
    from langgraph.checkpoint.memory import MemorySaver
    from langgraph.graph import END, START, StateGraph

    LANGGRAPH_AVAILABLE = True
except ImportError:
    END = "__end__"
    START = "__start__"
    StateGraph = None
    MemorySaver = None
    LANGGRAPH_AVAILABLE = False


class AgentState(TypedDict, total=False):
    thread_id: str
    idea: str
    product_context: str
    prd: Dict[str, Any]
    tasks: List[Dict[str, Any]]
    graph: List[Dict[str, Any]]
    logs: List[Dict[str, Any]]
    approval: Dict[str, Any]


def accept_input_node(state: AgentState) -> AgentState:
    return {
        "graph": graph_trace("idea"),
        "logs": [*state.get("logs", []), log_entry("agent", "graph.input.accepted", "Captured user goal and initialized LangGraph state")],
    }


def planner_node(state: AgentState) -> AgentState:
    return {
        "graph": graph_trace("planner"),
        "logs": [*state.get("logs", []), log_entry("agent", "planner.select_model", "Selected python-langgraph planner adapter")],
    }


def generate_prd_node(state: AgentState) -> AgentState:
    plan = local_plan(state["idea"], state.get("product_context"))
    return {
        "prd": plan["prd"],
        "tasks": plan["tasks"],
        "graph": graph_trace("tasks"),
        "logs": [
            *state.get("logs", []),
            log_entry(
                "agent",
                "python-langgraph.generate_prd",
                f"Generated PRD and {len(plan['tasks'])} candidate tasks with local planner",
            ),
        ],
    }


def validation_node(state: AgentState) -> AgentState:
    validation = validate_prd_tasks(state["prd"], state["tasks"])
    prd = {**state["prd"], "validation": validation["checks"], "checks": validation["checks"]}
    detail = (
        f"Validated {len(validation['tasks'])} tasks, priorities, estimates, and acceptance criteria"
        if validation["ok"]
        else "; ".join(validation["checks"])
    )
    return {
        "prd": prd,
        "tasks": validation["tasks"],
        "graph": graph_trace("validation"),
        "logs": [*state.get("logs", []), log_entry("tool", "schema.validate_agent_output", detail)],
    }


def persistence_node(state: AgentState) -> AgentState:
    result = create_many_tasks(state["tasks"])
    return {
        "graph": graph_trace("planned"),
        "logs": [
            *state.get("logs", []),
            log_entry("tool", "tasks.create_many", f"Prepared {result['count']} draft tasks for persistence"),
        ],
    }


def approval_node(state: AgentState) -> AgentState:
    approval = approval_interrupt(state["tasks"])
    return {
        "approval": approval,
        "logs": [
            *state.get("logs", []),
            log_entry("agent", "interrupt.wait_for_human", "Agent paused before export until user approves tasks"),
        ],
    }


def build_graph() -> Optional[Any]:
    if not LANGGRAPH_AVAILABLE:
        return None
    builder = StateGraph(AgentState)
    builder.add_node("accept_input", accept_input_node)
    builder.add_node("planner", planner_node)
    builder.add_node("generate_prd", generate_prd_node)
    builder.add_node("validate", validation_node)
    builder.add_node("persist_tasks", persistence_node)
    builder.add_node("approval_gate", approval_node)
    builder.add_edge(START, "accept_input")
    builder.add_edge("accept_input", "planner")
    builder.add_edge("planner", "generate_prd")
    builder.add_edge("generate_prd", "validate")
    builder.add_edge("validate", "persist_tasks")
    builder.add_edge("persist_tasks", "approval_gate")
    builder.add_edge("approval_gate", END)
    return builder.compile(checkpointer=MemorySaver())


compiled_graph = build_graph()


async def run_agent_graph(idea: str, thread_id: str = "default", product_context: str | None = None) -> Dict[str, Any]:
    state: AgentState = {
        "thread_id": thread_id,
        "idea": idea,
        "product_context": product_context or "",
        "graph": graph_trace("draft"),
        "logs": [],
    }
    if compiled_graph is not None:
        state = await compiled_graph.ainvoke(
            state,
            config={"configurable": {"thread_id": thread_id}},
        )
    else:
        for node in [
            accept_input_node,
            planner_node,
            generate_prd_node,
            validation_node,
            persistence_node,
            approval_node,
        ]:
            state = {**state, **node(state)}

    workspace = {
        "threadId": thread_id,
        "idea": idea,
        "prd": state["prd"],
        "tasks": state["tasks"],
        "graph": state["graph"],
        "logs": state["logs"],
        "exports": [],
        "provider": {
            "ai": "python-langgraph" if LANGGRAPH_AVAILABLE else "python-fallback-graph",
            "storage": "backend-memory",
            "linear": "not-configured",
            "github": "not-configured",
        },
        "approval": state.get("approval") or {"required": True, "status": "waiting"},
    }
    return store.save(thread_id, workspace)
