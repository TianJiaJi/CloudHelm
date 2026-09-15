from collections import deque
from datetime import datetime, timezone
from time import monotonic
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
        self.traffic: deque[float] = deque(maxlen=12)
        self.pending_actions: dict[str, dict] = {}
        # Self-healing: a killed pod comes back after this many seconds. Kept as
        # an attribute so tests can drive it down to 0.
        self.pod_recovery_seconds = 5.0
        self._recovering: dict[str, float] = {}
        # Pods that are still starting up (ContainerCreating) -> yellow state.
        self.pod_start_seconds = 3.0
        self._starting: dict[str, float] = {}

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

    def push_traffic(self, value: float) -> list[float]:
        """Append one traffic sample and return the rolling window."""
        self.traffic.append(round(value, 1))
        return list(self.traffic)

    def mark_pod_deleted(self, pod_name: str) -> None:
        """Take a pod down and schedule its self-healing."""
        for pod in self.pods:
            if pod["name"] == pod_name:
                pod["status"], pod["ready"] = "Terminating", False
        self._recovering[pod_name] = monotonic() + self.pod_recovery_seconds

    def start_pods(self, names: list[str]) -> None:
        """Mark freshly created pods as ContainerCreating (the yellow state)."""
        for name in names:
            for pod in self.pods:
                if pod["name"] == name:
                    pod["status"], pod["ready"] = "ContainerCreating", False
            self._starting[name] = monotonic() + self.pod_start_seconds

    def promote_starting_pods(self) -> list[str]:
        now = monotonic()
        promoted: list[str] = []
        for name in [n for n, due in self._starting.items() if due <= now]:
            self._starting.pop(name, None)
            for pod in self.pods:
                if pod["name"] == name:
                    pod["status"], pod["ready"] = "Running", True
                    promoted.append(name)
                    self.log("SUCCESS", f"Pod {name} is Running", "scheduling")
        return promoted

    def tick(self) -> None:
        """Advance time-based pod transitions (start-up and self-healing)."""
        self.promote_starting_pods()
        self.recover_due_pods()

    def recover_due_pods(self) -> list[str]:
        """Self-heal pods whose restart delay elapsed. Returns recovered names."""
        now = monotonic()
        recovered: list[str] = []
        for name in [n for n, due in self._recovering.items() if due <= now]:
            self._recovering.pop(name, None)
            for pod in self.pods:
                if pod["name"] == name:
                    pod["status"], pod["ready"] = "Running", True
                    pod["restarts"] = pod.get("restarts", 0) + 1
                    recovered.append(name)
                    self.log("SUCCESS", f"Self-healing complete: {name} recovered (restarts={pod['restarts']})", "self-healing")
        return recovered

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
