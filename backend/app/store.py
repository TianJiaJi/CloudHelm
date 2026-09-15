from collections import deque
from datetime import datetime, timezone
from uuid import uuid4


class RuntimeStore:
    def __init__(self) -> None:
        self.demo_fallback = True
        self.version = 3
        self.replicas = {"guide-service": 2, "ai-agent": 1, "data-dashboard": 1, "miniapp-api": 1}
        self.ai_available = True
        self.pods = self._make_pods()
        self.logs: deque[dict] = deque(maxlen=300)
        self.audit_trail: deque[dict] = deque(maxlen=200)
        self.pending_actions: dict[str, dict] = {}

    def _make_pods(self) -> list[dict]:
        pods = []
        for deployment, count in self.replicas.items():
            for index in range(count):
                pods.append({"name": f"{deployment}-{index + 1:03d}", "deployment": deployment, "status": "Running", "ready": True, "restarts": 0})
        return pods

    def log(self, level: str, message: str, source: str = "control-plane") -> dict:
        entry = {"id": str(uuid4()), "timestamp": datetime.now(timezone.utc).isoformat(), "level": level, "message": message, "source": source}
        self.logs.appendleft(entry)
        return entry

    def audit(self, *, action_type: str, target: str, risk: str, decision: str, action_id: str | None = None, operator: str = "control-panel", detail: str = "") -> dict:
        """Record who decided what, on which target, and when.

        There is intentionally no authentication layer in this MVP, so the
        operator is self-declared and defaults to the control panel.
        """
        entry = {
            "id": str(uuid4()),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "action_id": action_id,
            "action_type": action_type,
            "target": target,
            "risk": risk,
            "decision": decision,
            "operator": operator,
            "detail": detail,
        }
        self.audit_trail.appendleft(entry)
        return entry


store = RuntimeStore()
