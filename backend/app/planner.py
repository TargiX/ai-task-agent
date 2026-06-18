from __future__ import annotations

from datetime import datetime, timezone
from hashlib import sha1
from typing import Any, Dict, List, Tuple

MIN_TASKS = 4
MAX_TASKS = 8


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def graph_trace(stage: str = "draft") -> List[Dict[str, Any]]:
    order: List[Tuple[str, str]] = [
        ("idea", "Idea captured"),
        ("planner", "Planner selected"),
        ("prd", "PRD generated"),
        ("tasks", "Tasks planned"),
        ("validation", "Output validated"),
        ("db", "Tasks inserted in DB"),
        ("approval", "Human approval gate"),
        ("export", "Issue export"),
    ]
    complete_until = {
        "draft": 0,
        "idea": 1,
        "planner": 2,
        "prd": 3,
        "tasks": 4,
        "validation": 5,
        "db": 6,
        "planned": 6,
        "approved": 7,
        "exported": 8,
    }.get(stage, 0)
    now = utc_now()
    return [
        {
            "id": node_id,
            "label": label,
            "status": "done" if index < complete_until else "active" if index == complete_until else "waiting",
            "updatedAt": now if index < complete_until else None,
        }
        for index, (node_id, label) in enumerate(order)
    ]


def log_entry(kind: str, label: str, detail: str) -> Dict[str, Any]:
    digest = sha1(f"{kind}:{label}:{detail}:{utc_now()}".encode("utf-8")).hexdigest()[:10]
    return {
        "id": f"log-{digest}",
        "type": kind,
        "label": label,
        "detail": detail,
        "createdAt": utc_now(),
    }


def local_plan(idea: str, product_context: str | None = None) -> Dict[str, Any]:
    domain = infer_domain(idea)
    title = title_from_idea(idea)
    product_noun = title.removesuffix(" MVP")
    seed = int(sha1(idea.encode("utf-8")).hexdigest()[:4], 16) % 9000 + 1000
    now = utc_now()
    context = context_snippets(product_context)
    prd = {
        "title": title,
        "problem": f'Teams need a structured way to turn "{idea[:180]}{"..." if len(idea) > 180 else ""}" into clear product scope and engineering-ready work.',
        "audience": "Product managers, founders, engineering leads, designers, and operators working on SaaS product delivery.",
        "goals": [
            f"Define the core {domain} workflow and success criteria.",
            "Produce an implementation-ready task list with owners, priority, and acceptance criteria.",
            "Keep a human approval step before any issue export.",
            "Preserve a traceable tool-call log from idea to exported issue payload.",
        ],
        "scope": [
            "Idea capture and PRD generation",
            "Task planning and DB persistence",
            "Approval and rejection workflow",
            "Export payloads for Linear and GitHub Issues",
            "Audit log for agent and tool calls",
        ],
        "context": context,
        "sourceIdea": idea,
        "generatedBy": "python-langgraph",
        "model": "local-planner",
    }
    templates = [
        {
            "title": f"Map the {domain} workflow",
            "owner": "Product UI",
            "priority": "High",
            "effort": "3 pts",
            "acceptance": f"The primary {domain} workflow is documented with entry point, happy path, empty state, and approval checkpoint.",
        },
        {
            "title": f"Create data model for {product_noun}",
            "owner": "Backend",
            "priority": "High",
            "effort": "5 pts",
            "acceptance": "The backend stores idea, PRD, generated tasks, approval status, export target, and audit timestamps.",
        },
        {
            "title": "Build agent planning endpoint",
            "owner": "AI",
            "priority": "High",
            "effort": "5 pts",
            "acceptance": "POST /agent/run accepts a product idea, returns PRD plus tasks, and records graph/tool-call logs.",
        },
        {
            "title": "Implement human approval queue",
            "owner": "Frontend",
            "priority": "High",
            "effort": "3 pts",
            "acceptance": "Users can approve or reject individual tasks, and the task DB reflects the persisted status immediately.",
        },
        {
            "title": "Generate Linear and GitHub issue payloads",
            "owner": "Integrations",
            "priority": "Medium",
            "effort": "5 pts",
            "acceptance": "Approved tasks export with title, labels, priority, source PRD, and acceptance criteria in provider-specific shape.",
        },
    ]
    return {
        "prd": prd,
        "tasks": [
            {
                "id": f"TASK-{seed + index + 1}",
                "status": "pending",
                "createdAt": now,
                "source": "python-langgraph",
                **task,
            }
            for index, task in enumerate(templates)
        ],
    }


def validate_agent_output(prd: Dict[str, Any], tasks: List[Dict[str, Any]]) -> Dict[str, Any]:
    checks: List[str] = []
    normalized = [normalize_task(task, index) for index, task in enumerate(tasks[:MAX_TASKS])]
    normalized = [task for task in normalized if task]

    if not prd.get("title") or not prd.get("problem") or not prd.get("goals"):
        checks.append("PRD is missing title, problem, or goals")
    if len(normalized) < MIN_TASKS:
        checks.append(f"Task set has {len(normalized)} tasks; expected at least {MIN_TASKS}")
    if len(tasks) > MAX_TASKS:
        checks.append(f"Trimmed task set from {len(tasks)} to {MAX_TASKS} tasks")
    weak_acceptance = [task for task in normalized if len(task["acceptance"]) < 24]
    if weak_acceptance:
        checks.append(f"{len(weak_acceptance)} tasks need stronger acceptance criteria")
    if not checks:
        checks.append("All required agent output fields passed validation")

    return {
        "ok": not any("missing" in check or "expected" in check for check in checks),
        "checks": checks,
        "tasks": normalized,
    }


def build_agent_result(idea: str, thread_id: str = "default", product_context: str | None = None) -> Dict[str, Any]:
    logs = [
        log_entry("agent", "graph.input.accepted", "Captured user goal and initialized LangGraph state"),
        log_entry("agent", "planner.select_model", "Selected python-langgraph planner adapter"),
    ]
    plan = local_plan(idea, product_context)
    logs.append(
        log_entry(
            "agent",
            "python-langgraph.generate_prd",
            f"Generated PRD and {len(plan['tasks'])} candidate tasks with local planner",
        )
    )
    validation = validate_agent_output(plan["prd"], plan["tasks"])
    logs.append(
        log_entry(
            "tool",
            "schema.validate_agent_output",
            f"Validated {len(validation['tasks'])} tasks, priorities, estimates, and acceptance criteria"
            if validation["ok"]
            else "; ".join(validation["checks"]),
        )
    )
    logs.append(
        log_entry(
            "tool",
            "tasks.create_many",
            f"Prepared {len(validation['tasks'])} draft tasks for persistence",
        )
    )
    logs.append(
        log_entry(
            "agent",
            "interrupt.wait_for_human",
            "Agent paused before export until user approves tasks",
        )
    )
    prd = {**plan["prd"], "validation": validation["checks"], "checks": validation["checks"]}
    return {
        "threadId": thread_id,
        "idea": idea,
        "prd": prd,
        "tasks": validation["tasks"],
        "graph": graph_trace("planned"),
        "logs": logs,
        "exports": [],
        "provider": {
            "ai": "python-langgraph",
            "storage": "backend-memory",
            "linear": "not-configured",
            "github": "not-configured",
        },
        "approval": {
            "required": True,
            "status": "waiting",
            "message": "Review generated tasks before issue export.",
        },
    }


def normalize_task(task: Dict[str, Any], index: int) -> Dict[str, Any]:
    if not task.get("title") or not task.get("acceptance"):
        return {}
    priority = task.get("priority") if task.get("priority") in {"High", "Medium", "Low"} else "Medium"
    return {
        "id": task.get("id") or f"TASK-{index + 1}",
        "status": task.get("status") or "pending",
        "createdAt": task.get("createdAt") or utc_now(),
        "source": task.get("source") or "python-langgraph",
        "title": task["title"],
        "owner": task.get("owner") or "Product",
        "priority": priority,
        "effort": task.get("effort") or "3 pts",
        "acceptance": task["acceptance"],
        "reviewNote": task.get("reviewNote") or "",
    }


def context_snippets(product_context: str | None) -> List[str]:
    if not product_context:
        return []
    snippets: List[str] = []
    for line in product_context.splitlines():
        cleaned = line.strip().strip("-* ")
        if len(cleaned) >= 24:
            snippets.append(cleaned[:280])
        if len(snippets) >= 5:
            break
    return snippets


def infer_domain(idea: str) -> str:
    lower = idea.lower()
    if "feedback" in lower or "request" in lower:
        return "customer feedback"
    if "onboarding" in lower:
        return "user onboarding"
    if "analytics" in lower or "dashboard" in lower:
        return "analytics"
    if "billing" in lower or "subscription" in lower:
        return "billing"
    if "crm" in lower or "sales" in lower or "forecast" in lower:
        return "sales"
    return "SaaS"


def title_from_idea(idea: str) -> str:
    first_sentence = next((part.strip() for part in idea.replace("\n", ".").split(".") if part.strip()), "SaaS Workflow")
    words = first_sentence.split()
    if words and words[0].lower() in {"a", "an", "the"}:
        words = words[1:]
    stop_words = {"that", "where", "which"}
    cleaned: List[str] = []
    for word in words:
        if word.lower() in stop_words:
            break
        cleaned.append(word)
    base = " ".join(cleaned[:8]) or "SaaS Workflow"
    return f"{base.title()} MVP"
