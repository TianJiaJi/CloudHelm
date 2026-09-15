"""Security invariants for the ops control plane.

These encode two requirements that must not silently regress:
  * 禁止任意 shell 命令  -> no process spawning / dynamic evaluation anywhere
  * 未授权 K8s 命令      -> every Kubernetes write is namespace-scoped
"""

from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "app"

SHELL_PRIMITIVES = (
    "subprocess",
    "os.system",
    "os.popen",
    "shell=True",
    "pty.spawn",
    "commands.getoutput",
)

DYNAMIC_EVAL = ("eval(", "exec(", "__import__(")

K8S_WRITE_CALLS = (
    "patch_namespaced_deployment(",
    "patch_namespaced_deployment_scale(",
    "delete_namespaced_pod(",
    "create_namespaced_",
    "replace_namespaced_",
)


def _sources() -> list[Path]:
    return sorted(APP.glob("*.py"))


def test_no_shell_execution_primitives():
    """The control plane must never spawn processes (禁止任意 shell 命令)."""
    for path in _sources():
        source = path.read_text(encoding="utf-8")
        for needle in SHELL_PRIMITIVES:
            assert needle not in source, f"{path.name} contains shell primitive: {needle}"


def test_no_dynamic_code_evaluation():
    """No eval/exec, so agent or user text can never become executable code."""
    for path in _sources():
        source = path.read_text(encoding="utf-8")
        for needle in DYNAMIC_EVAL:
            assert needle not in source, f"{path.name} contains dynamic evaluation: {needle}"


def test_every_kubernetes_write_is_namespace_scoped():
    """All K8s writes must pin the namespace: no cluster-wide mutations."""
    source = (APP / "k8s.py").read_text(encoding="utf-8")
    writes = [line for line in source.splitlines() if any(call in line for call in K8S_WRITE_CALLS)]
    assert writes, "expected the adapter to declare its Kubernetes write operations"
    for line in writes:
        assert "self.settings.namespace" in line, f"K8s write is not namespace-scoped: {line.strip()}"


def test_agent_has_no_store_or_cluster_write_access():
    """The agent may only *describe* actions; execution authority stays in the API layer."""
    source = (APP / "agent.py").read_text(encoding="utf-8")
    assert "pending_actions" not in source, "agent must not register approvals itself"
    for call in K8S_WRITE_CALLS:
        assert call not in source, f"agent must not perform Kubernetes writes: {call}"


def test_config_exposes_an_operation_allowlist():
    """操作白名单: only explicitly allowed deployments may be targeted."""
    source = (APP / "config.py").read_text(encoding="utf-8")
    assert "allowed_deployments" in source
    assert "deployment_names" in source
