#!/usr/bin/env python3
"""CloudHelm 启动自检 (preflight).

在**当前机器允许的范围内**尽可能验证启动链路，并对无法验证的部分明确报告
SKIP（而不是假装通过）—— 例如本机没有 Docker daemon 时，容器链路就是未验证。

用法:
    python scripts/preflight.py             # 只读静态检查（任何机器可跑）
    python scripts/preflight.py --up        # 额外构建并启动 docker compose 并实测
    python scripts/preflight.py --deploy    # 额外把 K8s 清单应用到当前集群
    python scripts/preflight.py --up --deploy

退出码: 0 = 无 FAIL（允许 SKIP/WARN）；1 = 存在 FAIL。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

try:  # keep Chinese output readable on cp936 consoles
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parents[1]
RESULTS: list[tuple[str, str, str]] = []  # (level, title, detail)


def record(level: str, title: str, detail: str = "") -> None:
    RESULTS.append((level, title, detail))
    icon = {"PASS": "  ok  ", "FAIL": " FAIL ", "SKIP": " skip ", "WARN": " warn "}[level]
    print(f"[{icon}] {title}" + (f"\n         {detail}" if detail else ""))


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, **kwargs)


def load_yaml(path: Path):
    try:
        import yaml
    except ImportError:
        raise SystemExit("需要 pyyaml: pip install -r backend/requirements.txt")
    return [doc for doc in yaml.safe_load_all(path.read_text(encoding="utf-8")) if doc]


# ---------------------------------------------------------------- 静态检查


def check_layout() -> None:
    missing = [p for p in ("backend/Dockerfile", "frontend/Dockerfile", "docker-compose.yml", "frontend/nginx.conf") if not (ROOT / p).is_file()]
    if missing:
        record("FAIL", "必需文件存在", f"缺少: {', '.join(missing)}")
    else:
        record("PASS", "必需文件存在")


def check_port_alignment() -> None:
    """frontend/nginx.conf 的 listen 端口必须与 compose 的容器端口一致。"""
    compose = load_yaml(ROOT / "docker-compose.yml")[0]
    mapping = str(compose["services"]["frontend"]["ports"][0])
    host, container = mapping.split(":")
    nginx = (ROOT / "frontend" / "nginx.conf").read_text(encoding="utf-8")
    listen = re.search(r"listen\s+(\d+)", nginx).group(1)
    if container != listen:
        record("FAIL", "Compose 端口与 nginx listen 一致", f"compose 映射到容器 {container}，但 nginx 监听 {listen}")
    else:
        record("PASS", "Compose 端口与 nginx listen 一致", f"{host} -> {container}")


def check_nginx_proxy() -> None:
    nginx = (ROOT / "frontend" / "nginx.conf").read_text(encoding="utf-8")
    ok = "proxy_pass http://backend:8000" in nginx and "proxy_set_header Upgrade $http_upgrade" in nginx
    record("PASS" if ok else "FAIL", "nginx 通过服务名代理 API/WebSocket", "backend:8000 + Upgrade 头" if ok else "缺少 proxy_pass 或 WebSocket 升级头")


def check_settings_are_declared() -> None:
    config = (ROOT / "backend" / "app" / "config.py").read_text(encoding="utf-8")
    expected = sorted(n.upper() for n in re.findall(r"^\s{4}([a-z_0-9]+):\s*(?:str|bool|int)", config, re.M))
    compose_env = load_yaml(ROOT / "docker-compose.yml")[0]["services"]["backend"]["environment"]
    configmap = next(d for d in load_yaml(ROOT / "deploy" / "namespace.yaml") if d["kind"] == "ConfigMap")
    gaps = [n for n in expected if n not in compose_env] + [n for n in expected if n not in configmap["data"]]
    record("PASS" if not gaps else "FAIL", "全部设置项在两条部署路径中声明", f"{len(expected)} 项" if not gaps else f"缺失: {', '.join(sorted(set(gaps)))}")


def check_managed_services_exist() -> None:
    configmap = next(d for d in load_yaml(ROOT / "deploy" / "namespace.yaml") if d["kind"] == "ConfigMap")
    allowed = [n.strip() for n in configmap["data"]["ALLOWED_DEPLOYMENTS"].split(",") if n.strip()]
    docs = load_yaml(ROOT / "deploy" / "business-services.yaml")
    deployments = {d["metadata"]["name"]: d for d in docs if d["kind"] == "Deployment"}
    problems = []
    for name in allowed:
        dep = deployments.get(name)
        if not dep:
            problems.append(f"{name}: 无 Deployment")
            continue
        containers = dep["spec"]["template"]["spec"]["containers"]
        if [c["name"] for c in containers] != [name]:
            problems.append(f"{name}: 容器名与 Deployment 名不一致（镜像更新会打空）")
    record("PASS" if not problems else "FAIL", "白名单服务均有可操作工作负载", f"{len(allowed)} 个服务" if not problems else "; ".join(problems))


def check_k8s_namespace() -> None:
    bad = []
    for path in sorted((ROOT / "deploy").glob("*.yaml")):
        for doc in load_yaml(path):
            ns = doc.get("metadata", {}).get("namespace")
            if ns and ns != "cloudhelm":
                bad.append(f"{path.name}:{doc['kind']}={ns}")
    record("PASS" if not bad else "FAIL", "K8s 资源命名空间统一", "全部为 cloudhelm" if not bad else ", ".join(bad))


def run_static_checks() -> None:
    check_layout()
    check_port_alignment()
    check_nginx_proxy()
    check_settings_are_declared()
    check_managed_services_exist()
    check_k8s_namespace()
    check_unit_tests()


def check_unit_tests() -> None:
    if not shutil.which("python"):
        record("SKIP", "后端测试", "未找到 python")
        return
    # Copy the real environment: a trimmed env breaks subprocess on Windows
    # (missing SystemRoot etc.), which previously made this check fail spuriously.
    env = dict(os.environ)
    env["K8S_ENABLED"] = "false"
    proc = run([sys.executable, "-m", "pytest", "-q"], cwd=ROOT, env=env)
    tail = (proc.stdout or proc.stderr).strip().splitlines()
    summary = tail[-1] if tail else ""
    if proc.returncode == 0:
        record("PASS", "后端测试", summary)
    else:
        record("FAIL", "后端测试", summary[:200])


# ---------------------------------------------------------------- 容器链路


def http_get(url: str, timeout: float = 5.0) -> tuple[int, str]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")
    except Exception as exc:  # connection refused etc.
        return 0, str(exc)


def check_docker_chain() -> None:
    if not shutil.which("docker"):
        record("SKIP", "Docker/Compose 链路", "本机没有 docker，容器路径未验证")
        return

    version = run(["docker", "version", "--format", "{{.Server.Version}}"])
    if version.returncode != 0:
        record("SKIP", "Docker/Compose 链路", f"docker 守护进程不可用: {version.stderr.strip().splitlines()[-1] if version.stderr.strip() else ''}")
        return
    record("PASS", "Docker 守护进程可用", version.stdout.strip())

    cfg = run(["docker", "compose", "config"], cwd=ROOT)
    if cfg.returncode != 0:
        record("FAIL", "docker compose config", cfg.stderr.strip().splitlines()[-1] if cfg.stderr.strip() else "")
        return
    record("PASS", "docker compose config")

    print("         .. 正在构建并启动（首次可能较慢）")
    up = run(["docker", "compose", "up", "-d", "--build"], cwd=ROOT)
    if up.returncode != 0:
        record("FAIL", "docker compose up", (up.stderr or up.stdout).strip().splitlines()[-1] if (up.stderr or up.stdout).strip() else "")
        return
    record("PASS", "docker compose up -d")

    deadline = time.time() + 120
    health = ""
    while time.time() < deadline:
        status, body = http_get("http://localhost:8000/api/health")
        if status == 200 and '"status":"ok"' in body.replace(" ", ""):
            health = body
            break
        time.sleep(3)
    if health:
        record("PASS", "后端健康检查 /api/health", health.strip()[:120])
    else:
        record("FAIL", "后端健康检查 /api/health", "120 秒内未就绪")

    status, _ = http_get("http://localhost:5173/")
    record("PASS" if status == 200 else "FAIL", "前端首页可访问", f"HTTP {status}")

    status, body = http_get("http://localhost:5173/api/health")
    proxy_ok = status == 200 and body.lstrip().startswith("{")
    record("PASS" if proxy_ok else "FAIL", "nginx 代理 /api 到后端", f"HTTP {status}")

    check_websocket()


def check_websocket() -> None:
    try:
        import asyncio

        import websockets
    except ImportError:
        record("SKIP", "WebSocket 日志推送", "未安装 websockets（pip install -r backend/requirements.txt）")
        return

    async def probe() -> str:
        async with websockets.connect("ws://localhost:5173/api/logs/ws", open_timeout=10) as ws:
            # 触发一次会写日志的操作，然后等待推送
            urllib.request.urlopen(
                urllib.request.Request("http://localhost:5173/api/load-test", data=b"{}", headers={"Content-Type": "application/json"}, method="POST"),
                timeout=10,
            ).read()
            for _ in range(5):
                message = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
                if "message" in message:
                    return message["message"]
            return ""

    try:
        text = asyncio.run(probe())
        record("PASS" if text else "WARN", "WebSocket 日志推送", text[:100])
    except Exception as exc:
        record("FAIL", "WebSocket 日志推送", str(exc)[:160])


# ---------------------------------------------------------------- 集群链路


def check_kubernetes_chain(deploy: bool) -> None:
    if not shutil.which("kubectl"):
        record("SKIP", "Kubernetes 链路", "本机没有 kubectl，集群路径未验证")
        return

    info = run(["kubectl", "cluster-info"])
    if info.returncode != 0:
        record("SKIP", "Kubernetes 链路", "无法连接集群（未配置 kubeconfig 或集群不可达）")
        return
    record("PASS", "kubectl 已连接集群")

    files = ["namespace.yaml", "rbac.yaml", "business-services.yaml", "backend-deployment.yaml", "frontend-deployment.yaml"]
    if not deploy:
        record("SKIP", "应用 K8s 清单", "未指定 --deploy（加 --deploy 才会真正创建资源）")
    else:
        for name in files:
            proc = run(["kubectl", "apply", "-f", str(ROOT / "deploy" / name)])
            if proc.returncode != 0:
                record("FAIL", f"kubectl apply {name}", proc.stderr.strip().splitlines()[-1] if proc.stderr.strip() else "")
                return
        record("PASS", "kubectl apply 全部清单")

    rollout = run(["kubectl", "-n", "cloudhelm", "rollout", "status", "deployment/cloudhelm-backend", "--timeout=120s"])
    if rollout.returncode != 0:
        record("WARN", "控制面 rollout", rollout.stderr.strip().splitlines()[-1] if rollout.stderr.strip() else "未就绪（若未 --deploy 属正常）")
    else:
        record("PASS", "控制面 rollout", rollout.stdout.strip())

    # RBAC: 控制面账号必须能在 cloudhelm 内管理 Pod/Deployment
    sa = "system:serviceaccount:cloudhelm:cloudhelm-controller"
    for verb, resource in (("list", "pods"), ("delete", "pods"), ("patch", "deployments")):
        proc = run(["kubectl", "auth", "can-i", f"{verb}", resource, "-n", "cloudhelm", f"--as={sa}"])
        allowed = proc.stdout.strip() == "yes"
        record("PASS" if allowed else "FAIL", f"RBAC 允许 {verb} {resource}", f"as {sa}")

    pods = run(["kubectl", "-n", "cloudhelm", "get", "deploy", "-o", "name"])
    names = pods.stdout.strip().splitlines() if pods.returncode == 0 else []
    expected = ["guide-service", "ai-agent", "data-dashboard", "miniapp-api"]
    missing = [f"deployment.apps/{n}" for n in expected if f"deployment.apps/{n}" not in names]
    record("PASS" if not missing else "WARN", "被管业务服务已部署", "4 个服务齐全" if not missing else f"缺少: {', '.join(missing)}（需应用 business-services.yaml）")


# ---------------------------------------------------------------- main


def main() -> int:
    parser = argparse.ArgumentParser(description="CloudHelm 启动自检")
    parser.add_argument("--up", action="store_true", help="构建并启动 docker compose 并实测链路")
    parser.add_argument("--deploy", action="store_true", help="把 K8s 清单应用到当前集群")
    args = parser.parse_args()

    print("=" * 68)
    print("CloudHelm 启动自检")
    print("=" * 68)
    print("\n[静态检查]")
    run_static_checks()
    print("\n[容器链路]")
    check_docker_chain() if args.up else record("SKIP", "Docker/Compose 链路", "未指定 --up（加 --up 才会构建并启动）")
    print("\n[集群链路]")
    check_kubernetes_chain(args.deploy)

    counts = {level: sum(1 for item in RESULTS if item[0] == level) for level in ("PASS", "FAIL", "WARN", "SKIP")}
    print("\n" + "=" * 68)
    print(f"结果: {counts['PASS']} 通过 / {counts['FAIL']} 失败 / {counts['WARN']} 警告 / {counts['SKIP']} 跳过")
    if counts["SKIP"]:
        print("注意: SKIP 表示该链路在当前机器上【未经验证】，不等于通过。")
    print("=" * 68)
    return 1 if counts["FAIL"] else 0


if __name__ == "__main__":
    sys.exit(main())
