from __future__ import annotations

from typing import Any, Dict, Optional


class RunStore:
    """Small in-memory store for backend demos and tests.

    Production state is owned by the Node/Supabase runtime today. This store makes
    the Python backend runnable on its own and keeps the contract easy to test.
    """

    def __init__(self) -> None:
        self._runs: Dict[str, Dict[str, Any]] = {}

    def save(self, thread_id: str, workspace: Dict[str, Any]) -> Dict[str, Any]:
        self._runs[thread_id] = workspace
        return workspace

    def get(self, thread_id: str) -> Optional[Dict[str, Any]]:
        return self._runs.get(thread_id)

    def reset(self) -> None:
        self._runs.clear()


store = RunStore()
