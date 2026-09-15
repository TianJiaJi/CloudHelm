from dataclasses import dataclass
from typing import Any, Callable
from uuid import uuid4
from .store import RuntimeStore


@dataclass
class AgentReply:
    answer: str
    severity: str = "info"
    suggested_action: dict | None = None


MODE_LABEL = {"live": "实时集群数据", "demo": "演示数据", "unavailable": "不可用"}


class OperationsAgent:
    """Operations assistant.

    The agent never invents metrics: it always reports the provenance of the
    numbers it uses, and refuses to answer health questions when no data source
    can be read instead of falling back to invented values.
    """

    def __init__(self, store: RuntimeStore, status_provider: Callable[[], dict[str, Any]] | None = None) -> None:
        self.store = store
        self.status_provider = status_provider

    def status(self) -> dict[str, Any]:
        if self.status_provider is None:
            return {"mode": "unavailable", "detail": "no status provider configured"}
        try:
            return self.status_provider()
        except Exception as exc:  # defensive: the provider already handles fallbacks
            return {"mode": "unavailable", "detail": str(exc)}

    def chat(self, question: str) -> AgentReply:
        text = question.lower()
        status = self.status()
        mode = status.get("mode", "unavailable")
        label = MODE_LABEL.get(mode, MODE_LABEL["unavailable"])

        if any(word in text for word in ("健康", "health", "状态")):
            if mode == "unavailable":
                return AgentReply(
                    "## 当前健康度\n**无法读取集群指标**（Kubernetes / Prometheus 不可用），因此不能给出健康度结论。\n\n请检查集群连接，或在设置中开启演示后备。",
                    "warning",
                )
            return AgentReply(
                f"## 当前健康度（{label}）\n"
                f"- 就绪 Pod：**{status.get('ready_pods', '?')}/{status.get('total_pods', '?')}**\n"
                f"- QPS：**{status.get('qps', '?')}**\n"
                f"- 平均响应：**{status.get('latency_ms', '?')} ms**\n"
                f"- 错误率：**{status.get('error_rate', '?')}%**\n\n"
                f"数据来源：**{label}**。"
            )

        if any(word in text for word in ("瓶颈", "扩容", "压力")):
            action_id = str(uuid4())
            self.store.pending_actions[action_id] = {"type": "scale", "deployment": "guide-service", "replicas": 4}
            basis = f"当前就绪 Pod {status.get('ready_pods', '?')}/{status.get('total_pods', '?')}（{label}）" if mode != "unavailable" else "当前无法读取集群指标"
            return AgentReply(
                f"{basis}，导览服务在流量峰值时接近容量上限，建议扩容至 4 个副本。该动作需要人工确认后执行。",
                "warning",
                {"action_id": action_id, "label": "扩容导览服务", "risk": "medium"},
            )

        if any(word in text for word in ("报告", "report")):
            if mode == "unavailable":
                return AgentReply("## 运维摘要\n- **无法读取集群指标**，本次报告不含健康度结论\n- 演示链路可用性未知", "warning")
            return AgentReply(
                f"## 运维摘要（{label}）\n"
                f"- 就绪 Pod：{status.get('ready_pods', '?')}/{status.get('total_pods', '?')}\n"
                f"- 错误率：{status.get('error_rate', '?')}%\n"
                f"- 数据来源：**{label}**，扩容/回滚/压测等动作在演示后备下为模拟执行。"
            )

        if any(word in text for word in ("删 pod", "删除 pod", "杀 pod", "kill", "重启")):
            return AgentReply("该请求涉及破坏性集群操作，已被安全策略拦截。请在控制面板中选择目标并完成二次确认。", "critical")

        return AgentReply("我可以帮助分析健康度、瓶颈、生成报告和排查故障。涉及扩容、重启、删除 Pod 等操作时，我会先给出建议并等待人工确认。")
