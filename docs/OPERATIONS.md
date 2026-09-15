# CloudHelm 运维作战室

## 本地启动

推荐使用 Docker Compose（会构建 backend/frontend 镜像，前端 Nginx 通过服务名 `backend` 代理 HTTP 和 WebSocket）：

```bash
docker compose up
```

前端地址：`http://localhost:5173`，后端 Swagger：`http://localhost:8000/docs`。

本地已有 Python 和 Node 时，也可以运行 `start.sh` 自动安装后端依赖并启动前后端：

```bash
sh start.sh
```

也可以分别运行：

```bash
cd backend && pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
cd frontend && npm install && npm run dev
```

## 运行模式

- `K8S_ENABLED=true`：尝试读取 kubeconfig 或集群内 ServiceAccount。
- `DEMO_FALLBACK=true`：真实 K8s API 不可用或请求失败时使用连贯的演示状态。
- `DEMO_FALLBACK=false`：K8s 不可用时返回错误，不伪造真实集群结果。
- `ALLOWED_DEPLOYMENTS`：限制 AI 和控制台可操作的 Deployment 名称。
- `PROMETHEUS_URL`：真实模式的 Prometheus 地址；真实模式关闭后备时必须配置，避免把固定演示指标当成真实数据。

页面右上角可切换演示后备。模式和动作结果都会通过 API 响应及日志标记；CI/CD 测试状态当前明确标为 DEMO，不能作为真实流水线证据。真实模式下 Pod 计数和指标计数均来自实时集群/Prometheus。

## K8s 部署

先构建并推送两个镜像：

```bash
docker build -t cloudhelm/backend:demo backend
docker build -t cloudhelm/frontend:demo frontend
```

然后执行：

```bash
kubectl apply -f deploy/namespace.yaml
kubectl apply -f deploy/rbac.yaml
kubectl apply -f deploy/backend-deployment.yaml
kubectl apply -f deploy/frontend-deployment.yaml
```

示例 RBAC 仅授权 `cloudhelm` 命名空间内的 Pod 查询/删除和 Deployment 扩缩容/更新，不授予任意命令执行权限。生产环境应进一步按实际服务标签和命名空间收紧。

## 已验证项

![运维作战室](screenshot-dashboard.png)

以下结果来自本机实际运行（Windows + Git Bash），非仅构建产物：

| 验证项 | 命令/方式 | 结果 |
| --- | --- | --- |
| 后端单元/接口测试 | `python -m pytest -q` | 16 passed |
| 部署配置一致性 | `backend/tests/test_deploy_config.py` | compose 端口/命名空间/nginx 代理交叉校验通过 |
| 前端生产构建 | `npm run build` | 成功 |
| 后端真实启动 | `uvicorn app.main:app` | `/api/health` 返回 ok |
| 前端真实渲染 | 浏览器打开 `:5173` | 页面正常，控制台无报错 |
| `/api` 代理 | `curl :5173/api/health` | 正确转发至后端 |
| WebSocket 日志 | 经 Vite 代理连接 `/api/logs/ws` | 收到日志事件 |
| 控制台交互 | 浏览器点击部署/排查/AI 问答 | 状态与日志按预期更新 |

未验证（受环境限制）：`docker compose up` 与真实 K8s 集群联调 —— 本机没有 Docker 与 kubeconfig。

## 演示流程

1. 打开监控大屏，确认服务状态、指标和日志流。
2. 执行一键部署，观察版本号和成功日志。
3. 执行弹性扩容，再运行压测演练，观察副本和指标变化。
4. 选择故障注入，完成两次确认，观察高风险拦截、自愈日志和状态变化。
5. 在 AI 助手中询问健康度、瓶颈或报告；涉及扩容时必须人工批准。
6. 切换关闭演示后备，可验证无 K8s 时系统明确返回失败，而不是伪造成功。

## 已知边界

真实模式下，Pod、扩缩容、发布 annotation、删 Pod和镜像更新经过 Kubernetes Python 客户端执行；指标通过 Prometheus 查询。压测、流量趋势、诊断和熔断流程提供演示适配，页面操作结果会明确显示 DEMO；它们不代表真实压测或生产变更。完整 OpenTelemetry、CI/CD 外部系统和真实大模型供应商接入不在本 MVP 内。
