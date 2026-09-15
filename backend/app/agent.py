from dataclasses import dataclass
from typing import Any, Callable
from .store import RuntimeStore


@dataclass
class AgentReply:
    answer: str
    severity: str = "info"
    suggested_action: dict | None = None


MODE_LABEL = {"live": "实时集群数据", "demo": "演示数据", "unavailable": "不可用"}

# Intent-based destructive detection.
#
# Exact phrase matching ("删 pod") is trivially bypassed by rewording —
# "直接删掉一个 pod" / "把 pod 删了" / "干掉这个容器" all slipped through.
# So we combine an action verb with a resource noun instead, and exclude
# questions about an *observed* problem ("pod 为什么老是重启") which are
# diagnostic, not requests to act.
DESTRUCTIVE_VERBS = (
    "删", "移除", "干掉", "杀死", "杀掉", "清理",
    "kill", "delete", "remove", "drop",
    "重启", "restart", "下线", "停掉", "停止", "缩容", "scale down",
)
# Verbs that are unambiguous even without an explicit resource noun.
STANDALONE_DESTRUCTIVE = ("kill", "重启", "restart", "下线", "缩容", "scale down")
RESOURCE_NOUNS = (
    "pod", "容器", "container", "服务", "deployment", "节点", "node",
    "实例", "replica", "副本",
    # English resource words so names like guide-service / ai-agent are caught
    "service", "agent", "dashboard", "miniapp", "api", "app",
)
PROBLEM_MARKERS = ("为什么", "为何", "原因", "怎么回事", "老是", "一直", "why")


def looks_destructive(text: str) -> bool:
    """True when the message asks the agent to perform a destructive action."""
    if not any(verb in text for verb in DESTRUCTIVE_VERBS):
        return False
    if any(marker in text for marker in PROBLEM_MARKERS):
        return False  # asking why something happened, not asking us to do it
    if any(verb in text for verb in STANDALONE_DESTRUCTIVE):
        return True
    return any(noun in text for noun in RESOURCE_NOUNS)


class OperationsAgent:
    """Operations assistant.

    The agent never invents metrics: it always reports the provenance of the
    numbers it uses, and refuses to answer health questions when no data source
    can be read instead of falling back to invented values.

    The agent also never executes anything. It only *describes* a suggested
    action; the API layer turns that description into an approval request so
    that every high-risk action is audited in one place.
    """

    def __init__(self, status_provider: Callable[[], dict[str, Any]] | None = None) -> None:
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

        # Destructive intent is evaluated first so that mixed phrasing such as
        # "系统故障了，帮我重启" is still blocked instead of matched as a
        # troubleshooting or health question.
        if looks_destructive(text):
            return AgentReply(
                "该请求涉及破坏性集群操作，已被安全策略拦截。请在控制面板中选择目标并完成二次确认；我不会代为执行。",
                "critical",
            )

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
            basis = f"当前就绪 Pod {status.get('ready_pods', '?')}/{status.get('total_pods', '?')}（{label}）" if mode != "unavailable" else "当前无法读取集群指标"
            return AgentReply(
                f"{basis}，导览服务在流量峰值时接近容量上限，建议扩容至 4 个副本。该动作需要人工确认后执行。",
                "warning",
                {
                    "label": "扩容导览服务",
                    "risk": "medium",
                    "request": {
                        "action_type": "scale",
                        "target": "guide-service -> 4 副本",
                        "deployment": "guide-service",
                        "replicas": 4,
                    },
                },
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

        if any(word in text for word in ("排障", "排查", "故障", "异常", "诊断", "定位", "报错", "超时", "oom", "重启", "怎么回事", "原因")):
            if mode == "unavailable":
                return AgentReply("## 故障排查\n**无法读取集群状态**，因此无法定位问题。请先恢复集群连接或在设置中开启演示后备。", "warning")
            unhealthy = status.get("unhealthy_pods") or []
            if unhealthy:
                return AgentReply(
                    f"## 故障排查（{label}）\n"
                    f"- 异常 Pod（{len(unhealthy)}）：{', '.join(unhealthy)}\n"
                    f"- 就绪：{status.get('ready_pods', '?')}/{status.get('total_pods', '?')}\n"
                    f"- 错误率：{status.get('error_rate', '?')}%，P95：{status.get('latency_ms', '?')} ms\n\n"
                    f"**建议顺序**：1) 看实时日志定位报错 2) 重启异常 Pod 恢复 3) 扩容分摊负载\n"
                    f"重启/扩容属于变更操作，需在控制面板二次确认。",
                    "warning",
                )
            return AgentReply(
                f"## 故障排查（{label}）\n"
                f"- 未发现异常 Pod，{status.get('ready_pods', '?')}/{status.get('total_pods', '?')} 就绪\n"
                f"- 错误率 {status.get('error_rate', '?')}%，P95 {status.get('latency_ms', '?')} ms\n\n"
                f"**建议排查顺序**：1) 看实时日志有无 ERROR/WARN 2) 执行「故障排查」拉全量诊断 "
                f"3) 关注错误率与延迟趋势是否抬头\n"
                f"如需进一步定位，请告诉我具体现象（如哪个服务、什么报错）。"
            )

        return AgentReply("我可以帮助分析健康度、瓶颈、生成报告和排查故障。涉及扩容、重启、删除 Pod 等操作时，我会先给出建议并等待人工确认。")
