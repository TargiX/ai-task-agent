import asyncio
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.agents.graph import run_agent_graph
from app.planner import build_agent_result, graph_trace, local_plan, validate_agent_output


IDEA = (
    "A lightweight customer feedback portal for B2B SaaS teams. Users submit "
    "feature requests, product managers cluster similar ideas, and approved "
    "requests sync into engineering planning."
)


class AgentContractTest(unittest.TestCase):
    def test_local_plan_returns_prd_and_engineering_tasks(self):
        plan = local_plan(IDEA)
        validation = validate_agent_output(plan["prd"], plan["tasks"])

        self.assertIn("MVP", plan["prd"]["title"])
        self.assertEqual(len(plan["tasks"]), 5)
        self.assertTrue(validation["ok"])
        self.assertIn("All required agent output fields passed validation", validation["checks"])
        self.assertEqual({task["status"] for task in validation["tasks"]}, {"pending"})

    def test_build_agent_result_matches_frontend_contract(self):
        result = build_agent_result(IDEA, "demo-thread")

        self.assertEqual(result["threadId"], "demo-thread")
        self.assertEqual(result["approval"]["status"], "waiting")
        self.assertEqual(result["graph"][-2]["id"], "approval")
        self.assertEqual(result["graph"][-2]["status"], "active")
        self.assertEqual([log["label"] for log in result["logs"]], [
            "graph.input.accepted",
            "planner.select_model",
            "python-langgraph.generate_prd",
            "schema.validate_agent_output",
            "tasks.create_many",
            "interrupt.wait_for_human",
        ])

    def test_async_graph_runner_persists_run_contract(self):
        result = asyncio.run(run_agent_graph(IDEA, "async-thread"))

        self.assertEqual(result["threadId"], "async-thread")
        self.assertEqual(len(result["tasks"]), 5)
        self.assertEqual(result["approval"]["required"], True)
        self.assertIn(result["provider"]["ai"], {"python-langgraph", "python-fallback-graph"})

    def test_async_graph_runner_injects_product_context(self):
        result = asyncio.run(
            run_agent_graph(
                IDEA,
                "context-thread",
                "Customer feedback portals should cluster duplicate requests before export.\n"
                "Human reviewers approve engineering task batches before issue creation.",
            )
        )

        self.assertIn("cluster duplicate requests", result["prd"]["context"][0])
        self.assertEqual(len(result["prd"]["context"]), 2)

    def test_graph_trace_marks_planned_state(self):
        trace = graph_trace("planned")

        self.assertEqual(trace[-2]["id"], "approval")
        self.assertEqual(trace[-2]["status"], "active")
        self.assertEqual(trace[-1]["status"], "waiting")


if __name__ == "__main__":
    unittest.main()
