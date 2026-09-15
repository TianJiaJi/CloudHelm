from collections import deque
from datetime import datetime, timezone
from threading import RLock
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
        # FastAPI runs sync endpoints in a thread pool, so state mutations must be
        # serialised. The version counter is a read-modify-write and pod list
        # rebuilds are multi-step: neither is atomic on its own.
        # (Not reproduced in 300 concurrent deploys, but the window is real.)
        self._lock = RLock()

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

    def next_release(self) -> str:
        """Atomically bump and return the release version."""
        with self._lock:
            self.version += 1
            return f"v3.{self.version}"

    def current_release(self) -> str:
        with self._lock:
            return f"v3.{self.version}"

    def rollback_release(self) -> tuple[str, str]:
        """Return (previous, current) assuming a floor of v3.1."""
        with self._lock:
            previous = f"v3.{self.version}"
            if self.version > 1:
                self.version -= 1
            return previous, f"v3.{self.version}"

    def apply_scale(self, deployment: str, replicas: int) -> list[str]:
        """Reconcile the pod set for a scale event; return newly created pod names.

        This must NOT rebuild the whole list from scratch. Doing so used to
        resurrect pods that were mid-failure and wipe their restart counters,
        while leaving stale self-healing entries behind (a later tick would then
        "heal" an already-running pod, inflating restarts).
        Existing pods are therefore preserved by identity, and scheduling state
        for pods that no longer exist is dropped.
        """
        with self._lock:
            self.replicas[deployment] = replicas
            by_name = {pod["name"]: pod for pod in self.pods}
            rebuilt: list[dict] = []
            created: list[str] = []
            for dep, count in self.replicas.items():
                for index in range(1, count + 1):
                    name = f"{dep}-{index:03d}"
                    pod = by_name.get(name)
                    if pod is None:
                        pod = {"name": name, "deployment": dep, "status": "Running", "ready": True, "restarts": 0}
                        created.append(name)
                    rebuilt.append(pod)

            surviving = {pod["name"] for pod in rebuilt}
            for name in [n for n in self._recovering if n not in surviving]:
                self._recovering.pop(name, None)
            for name in [n for n in self._starting if n not in surviving]:
                self._starting.pop(name, None)

            self.pods = rebuilt
            return created

    def snapshot_pods(self) -> list[dict]:
        with self._lock:
            return [dict(pod) for pod in self.pods]

    def mark_pod_deleted(self, pod_name: str) -> None:
        """Take a pod down and schedule its self-healing."""
        with self._lock:
            for pod in self.pods:
                if pod["name"] == pod_name:
                    pod["status"], pod["ready"] = "Terminating", False
            self._recovering[pod_name] = monotonic() + self.pod_recovery_seconds

    def start_pods(self, names: list[str]) -> None:
        """Mark freshly created pods as ContainerCreating (the yellow state)."""
        with self._lock:
            for name in names:
                for pod in self.pods:
                    if pod["name"] == name:
                        pod["status"], pod["ready"] = "ContainerCreating", False
                self._starting[name] = monotonic() + self.pod_start_seconds

    def promote_starting_pods(self) -> list[str]:
        now = monotonic()
        promoted: list[str] = []
        with self._lock:
            for name in [n for n, due in self._starting.items() if due <= now]:
                # dict.pop is atomic: whoever pops it owns the transition, so a
                # pod cannot be promoted twice even if the lock is bypassed.
                if self._starting.pop(name, None) is None:
                    continue
                for pod in self.pods:
                    if pod["name"] == name:
                        pod["status"], pod["ready"] = "Running", True
                        promoted.append(name)
                        self.log("SUCCESS", f"Pod {name} is Running", "scheduling")
        return promoted

    def tick(self) -> None:
        """Advance time-based pod transitions (start-up and self-healing)."""
        with self._lock:
            self.promote_starting_pods()
            self.recover_due_pods()

    def recover_due_pods(self) -> list[str]:
        """Self-heal pods whose restart delay elapsed. Returns recovered names."""
        now = monotonic()
        recovered: list[str] = []
        with self._lock:
            for name in [n for n, due in self._recovering.items() if due <= now]:
                # Atomic claim: only the thread that pops the entry may heal it,
                # so restarts can never be double-counted.
                if self._recovering.pop(name, None) is None:
                    continue
                for pod in self.pods:
                    if pod["name"] == name:
                        # Never invent a restart for a pod that is already healthy:
                        # a stale entry must not manufacture a healing event.
                        if pod["ready"]:
                            continue
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
