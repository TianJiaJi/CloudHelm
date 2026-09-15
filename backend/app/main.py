import asyncio
import json
import random
from contextlib import asynccontextmanager
from urllib.parse import quote
from urllib.request import urlopen
from uuid import uuid4
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from .agent import OperationsAgent
from .config import get_settings
from .k8s import ClusterAdapter, K8sUnavailable
from .models import AgentApprovalRequest, ChatRequest, ImageUpdateRequest, PodKillRequest, ScaleRequest, SettingsRequest
from .store import store

settings = get_settings()
store.demo_fallback = settings.demo_fallback
adapter = ClusterAdapter(settings, store)


def action_result(message: str, mode: str = "demo", action_id: str | None = None, **data):
    return {"success": True, "message": message, "mode": mode, "action_id": action_id, "data": data}


def ensure_allowed(deployment: str) -> None:
    if deployment not in settings.deployment_names:
        raise HTTPException(400, f"Deployment is outside the allowed scope: {deployment}")


RISK_BY_ACTION = {"scale": "medium", "kill": "high", "ai_update": "high", "deploy": "medium", "rollback": "medium"}


def run_live_or_demo(live_call, demo_call):
    if adapter.live:
        try:
            live_call()
            return "live"
        except Exception as exc:
            store.log("WARN", f"Live Kubernetes request failed: {exc}")
            if not store.demo_fallback:
                raise HTTPException(503, "Kubernetes request failed and demo fallback is disabled")
    elif not store.demo_fallback:
        raise HTTPException(503, "Kubernetes API is unavailable and demo fallback is disabled")
    demo_call()
    return "demo"


def request_approval(*, action_type: str, target: str, operator: str = "control-panel", **params) -> str:
    """Park a high-risk action and write the pending audit record."""
    action_id = str(uuid4())
    risk = RISK_BY_ACTION.get(action_type, "unknown")
    store.pending_actions[action_id] = {"type": action_type, "target": target, "risk": risk, **params}
    store.audit(action_id=action_id, action_type=action_type, target=target, risk=risk, decision="pending", operator=operator)
    store.log("WARN", f"High-risk action blocked pending approval by {operator}: {action_type} -> {target}", "security")
    return action_id


def audit_executed(action_type: str, target: str, operator: str = "control-panel", detail: str = "") -> None:
    """Record a state-changing action that does not require approval."""
    risk = RISK_BY_ACTION.get(action_type, "low")
    store.audit(action_type=action_type, target=target, risk=risk, decision="executed", operator=operator, detail=detail)


def build_metrics() -> dict:
    store.tick()
    pod_items = store.pods
    if adapter.live:
        try:
            pod_items = adapter.pods()
        except Exception as exc:
            store.log("WARN", f"Metrics pod count fallback: {exc}", "metrics")
            if not store.demo_fallback:
                raise HTTPException(503, "Cannot read Kubernetes pods for metrics")
    ready = sum(1 for pod in pod_items if pod["ready"])
    if adapter.live and not settings.prometheus_url and not store.demo_fallback:
        raise HTTPException(503, "PROMETHEUS_URL is required in live mode when demo fallback is disabled")
    if adapter.live and settings.prometheus_url:
        try:
            def query(expr: str) -> float:
                url = f"{settings.prometheus_url.rstrip('/')}/api/v1/query?query={quote(expr)}"
                with urlopen(url, timeout=2) as response:
                    result = json.load(response)["data"]["result"]
                return float(result[0]["value"][1]) if result else 0.0
            qps = round(query('sum(rate(http_requests_total[1m]))'), 2)
            latency = round(query('1000 * histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[1m])) by (le))'), 2)
            errors = round(query('100 * sum(rate(http_requests_total{status=~"5.."}[1m])) / sum(rate(http_requests_total[1m]))'), 3)
            return {"mode": "live", "qps": qps, "latency_ms": latency, "error_rate": errors, "ready_pods": ready, "total_pods": len(pod_items), "unhealthy_pods": [pod["name"] for pod in pod_items if not pod["ready"]], "traffic": store.push_traffic(qps)}
        except Exception as exc:
            store.log("WARN", f"Prometheus metrics unavailable: {exc}", "metrics")
            if not store.demo_fallback:
                raise HTTPException(503, "Prometheus metrics unavailable")

    # Synthetic but *responsive* demo metrics: scaling out raises served
    # throughput and lowers latency/error rate, so the dashboard visibly reacts.
    # The per-replica delta is deliberately larger than the jitter so the
    # direction is deterministic. Always reported as mode="demo".
    qps = round(1050 + 48 * ready + random.uniform(-12, 12), 1)
    latency = round(max(32.0, 160 - 7 * ready + random.uniform(-2, 2)), 1)
    errors = round(max(0.04, 0.6 - 0.06 * ready + random.uniform(-0.015, 0.015)), 3)
    return {"mode": "demo", "qps": qps, "latency_ms": latency, "error_rate": errors, "ready_pods": ready, "total_pods": len(pod_items), "unhealthy_pods": [pod["name"] for pod in pod_items if not pod["ready"]], "traffic": store.push_traffic(qps)}


def agent_status() -> dict:
    try:
        return build_metrics()
    except HTTPException as exc:
        return {"mode": "unavailable", "detail": str(exc.detail)}


agent = OperationsAgent(agent_status)


@asynccontextmanager
async def lifespan(_: FastAPI):
    store.log("INFO", "CloudHelm control plane started")
    yield


app = FastAPI(title=settings.app_name, version="0.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])


@app.get("/api/health")
def health():
    return {"status": "ok", "k8s_connected": adapter.live, "demo_fallback": store.demo_fallback, "cluster_state": "live" if adapter.live else "demo"}


@app.get("/api/pipeline")
def pipeline():
    return {"commit": "a7c91f2", "branch": "dev", "tests": {"passed": 42, "failed": 0, "duration": "18s"}, "status": "passed", "mode": "demo", "source": "演示数据"}


@app.get("/api/settings")
def get_runtime_settings():
    return {"demo_fallback": store.demo_fallback, "k8s_connected": adapter.live, "namespace": settings.namespace}


@app.put("/api/settings")
def update_runtime_settings(payload: SettingsRequest):
    store.demo_fallback = payload.demo_fallback
    store.log("INFO", f"Demo fallback {'enabled' if payload.demo_fallback else 'disabled'}")
    return {"demo_fallback": store.demo_fallback}


@app.get("/api/pods")
def get_pods():
    store.tick()
    if adapter.live:
        try:
            return {"items": adapter.pods(), "mode": "live"}
        except Exception as exc:
            store.log("WARN", f"Pod status fallback: {exc}")
            if not store.demo_fallback:
                raise HTTPException(503, "Cannot read Kubernetes pods")
    return {"items": store.pods, "mode": "demo"}


@app.get("/api/metrics")
def get_metrics():
    return build_metrics()


@app.get("/api/logs")
def get_logs():
    return {"items": list(store.logs)}


@app.delete("/api/logs")
def clear_logs(operator: str = "control-panel"):
    """Clear the log buffer. Recorded in the audit trail (which is separate)."""
    cleared = len(store.logs)
    store.logs.clear()
    audit_executed("clear_logs", f"log buffer ({cleared} entries)", operator)
    return {"success": True, "cleared": cleared}


@app.get("/api/audit")
def get_audit():
    """Audit trail: who decided what, on which target, and when."""
    return {"items": list(store.audit_trail)}


@app.post("/api/deploy")
def deploy(operator: str = "control-panel"):
    ensure_allowed("guide-service")
    store.version += 1
    version = f"v3.{store.version}"
    mode = run_live_or_demo(lambda: adapter.deploy("guide-service", version), lambda: None)
    store.log("SUCCESS", f"Deployment completed: release {version}", "deployment")
    audit_executed("deploy", f"guide-service @ {version}", operator, f"mode={mode}")
    return action_result(f"已部署版本 {version}", mode, version=version)


def execute_scale(payload: ScaleRequest):
    ensure_allowed(payload.deployment)
    previous = {pod["name"] for pod in store.pods}
    mode = run_live_or_demo(lambda: adapter.scale(payload.deployment, payload.replicas), lambda: None)
    store.replicas[payload.deployment] = payload.replicas
    store.pods = store._make_pods()
    # Newly created replicas come up as ContainerCreating (yellow) before Running.
    store.start_pods([pod["name"] for pod in store.pods if pod["name"] not in previous])
    store.log("SUCCESS", f"Scaled {payload.deployment} to {payload.replicas} replicas", "scaling")
    return action_result(f"已将 {payload.deployment} 扩容至 {payload.replicas} 个副本", mode, replicas=payload.replicas)


@app.post("/api/scale")
def scale(payload: ScaleRequest, operator: str = "control-panel"):
    ensure_allowed(payload.deployment)
    action_id = request_approval(action_type="scale", target=f"{payload.deployment} -> {payload.replicas} 副本", operator=operator, deployment=payload.deployment, replicas=payload.replicas)
    return {"success": False, "requires_approval": True, "message": "扩容属于变更操作，需要二次确认", "mode": "live" if adapter.live else "demo", "action_id": action_id}


@app.post("/api/load-test")
def load_test():
    store.log("INFO", "Load test started: simulated 2,000 requests/s", "load-test")
    store.log("SUCCESS", "Load test completed: p95 112 ms, error rate 0.21%", "load-test")
    return action_result("压测完成：峰值 2,000 QPS，p95 112ms", "demo", qps=2000, p95=112)


@app.post("/api/rollback")
def rollback(operator: str = "control-panel"):
    previous = f"v3.{store.version}"
    if store.version > 1:
        store.version -= 1
    store.log("SUCCESS", f"Rollback completed: {previous} -> v3.{store.version}", "rollback")
    audit_executed("rollback", f"guide-service: {previous} -> v3.{store.version}", operator)
    return action_result(f"已回滚至版本 v3.{store.version}", "demo", version=f"v3.{store.version}")


@app.get("/api/diagnostics")
def diagnostics():
    pod_items = store.pods
    mode = "demo"
    if adapter.live:
        try:
            pod_items = adapter.pods()
            mode = "live"
        except Exception as exc:
            store.log("WARN", f"Diagnostics pod read fallback: {exc}", "diagnostics")
            if not store.demo_fallback:
                raise HTTPException(503, "Cannot read Kubernetes pods for diagnostics")
    failing = [pod["name"] for pod in pod_items if not pod["ready"]]
    total = len(pod_items)
    diagnosis = f"未发现异常，{total} 个 Pod 全部就绪" if not failing else f"发现 {len(failing)} 个异常 Pod：{', '.join(failing)}；建议重启并扩容分摊负载"
    store.log("INFO", f"Diagnostics completed ({mode}): {diagnosis}", "diagnostics")
    return {"success": True, "mode": mode, "diagnosis": diagnosis, "findings": failing, "total_pods": total}


@app.post("/api/circuit-breaker")
def circuit_breaker(operator: str = "control-panel"):
    store.ai_available = False
    store.log("WARN", "AI service circuit opened; guide service switched to local cache", "resilience")
    audit_executed("circuit_breaker", "ai-agent (open)", operator)
    return action_result("AI 服务已熔断，导览服务切换至本地缓存模式", "demo", fallback="local-cache")


@app.post("/api/circuit-breaker/recover")
def circuit_breaker_recover(operator: str = "control-panel"):
    store.ai_available = True
    store.log("SUCCESS", "AI service recovered; intelligent mode restored", "resilience")
    audit_executed("circuit_breaker", "ai-agent (recovered)", operator)
    return action_result("AI 服务已恢复，智能模式重新启用", "demo", fallback="ai")


@app.post("/api/chaos/kill")
def chaos_kill(payload: PodKillRequest, operator: str = "control-panel"):
    target = next((pod for pod in store.pods if pod["name"] == payload.pod_name), None)
    if target and target["deployment"] not in settings.deployment_names:
        raise HTTPException(403, "Pod is outside the allowed deployment scope")
    if adapter.live:
        try:
            adapter.validate_pod(payload.pod_name)
        except Exception as exc:
            store.log("WARN", f"Rejected pod target: {payload.pod_name} ({exc})", "security")
            raise HTTPException(404, "Pod does not exist in the allowed namespace and deployment scope")
    elif not target:
        raise HTTPException(404, "Pod does not exist in the allowed scope")
    action_id = request_approval(action_type="kill", target=payload.pod_name, operator=operator, pod_name=payload.pod_name)
    return {"success": False, "requires_approval": True, "message": "故障注入属于高风险操作，需要二次确认", "mode": "live" if adapter.live else "demo", "action_id": action_id}


@app.post("/api/ai/update")
def update_ai(payload: ImageUpdateRequest, operator: str = "control-panel"):
    ensure_allowed(payload.deployment)
    if not (payload.image.startswith("cloudhelm/") or payload.image.startswith("registry.local/")):
        raise HTTPException(400, "Image must come from an approved registry")
    action_id = request_approval(action_type="ai_update", target=f"{payload.deployment} <- {payload.image}", operator=operator, deployment=payload.deployment, image=payload.image)
    return {"success": False, "requires_approval": True, "message": "AI 镜像更新属于高风险操作，需要二次确认", "mode": "live" if adapter.live else "demo", "action_id": action_id}


@app.post("/api/ai/chat")
def chat(payload: ChatRequest, operator: str = "control-panel"):
    reply = agent.chat(payload.question)
    suggested = None
    if reply.suggested_action:
        suggested = dict(reply.suggested_action)
        request = suggested.pop("request", None)
        if request:
            suggested["action_id"] = request_approval(operator=operator, **request)
    return {"answer": reply.answer, "severity": reply.severity, "suggested_action": suggested}


@app.post("/api/agent/approve")
def approve(payload: AgentApprovalRequest):
    action = store.pending_actions.pop(payload.action_id, None)
    if not action:
        raise HTTPException(404, "Action approval has expired or does not exist")
    if not payload.approved:
        store.audit(action_id=payload.action_id, action_type=action["type"], target=action["target"], risk=action["risk"], decision="rejected", operator=payload.operator)
        store.log("INFO", f"High-risk action rejected by {payload.operator}: {action['type']} -> {action['target']}", "security")
        return action_result("已取消高风险操作", "demo")
    if action["type"] == "scale":
        result = execute_scale(ScaleRequest(deployment=action["deployment"], replicas=action["replicas"]))
    elif action["type"] == "ai_update":
        mode = run_live_or_demo(lambda: adapter.update_image(action["deployment"], action["image"]), lambda: None)
        store.log("SUCCESS", f"AI service updated to {action['image']}", "ai-update")
        result = action_result("AI 服务更新完成", mode, image=action["image"])
    else:
        pod_name = action["pod_name"]
        mode = run_live_or_demo(lambda: adapter.delete_pod(pod_name), lambda: None)
        store.mark_pod_deleted(pod_name)
        store.log("SUCCESS", f"Chaos injection approved: deleted {pod_name}; self-healing started", "chaos")
        result = action_result(f"已删除 {pod_name}，自愈流程已启动", mode)
    store.audit(action_id=payload.action_id, action_type=action["type"], target=action["target"], risk=action["risk"], decision="approved", operator=payload.operator, detail=f"mode={result.get('mode')}")
    return result


@app.websocket("/api/logs/ws")
async def logs_ws(websocket: WebSocket):
    await websocket.accept()
    try:
        last_id = None
        while True:
            if store.logs and store.logs[0]["id"] != last_id:
                last_id = store.logs[0]["id"]
                await websocket.send_json(store.logs[0])
            else:
                await asyncio.sleep(0.5)
    except (WebSocketDisconnect, RuntimeError):
        return
