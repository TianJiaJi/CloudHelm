# CloudHelm

> 云端 Helm —— 项目仓库初始化占位说明。

## ⚠️ 重要：本项目的代码分布在两个仓库

| 角色            | 仓库                          | 地址                                        | 用途                       |
| --------------- | ----------------------------- | ------------------------------------------- | -------------------------- |
| **总仓库**      | `404-Wont-Fix/CloudHelm`      | https://github.com/404-Wont-Fix/CloudHelm   | 稳定分支 `main`，对外主仓库 |
| **开发仓库**    | `TianJiaJi/CloudHelm`         | https://github.com/TianJiaJi/CloudHelm      | 日常开发，分支 `dev`        |

**你当前所在的克隆来自「开发仓库」。**

- 日常开发 → 提交到 `dev` → `git push`（推开发仓库）
- 进入总仓库 → 由开发仓库发起 **PR** → 合并到总仓库 `main`
- 开发账户对总仓库**只有读权限**，`git push upstream` 会 403，这是预期行为

对应到本地 remote：

```bash
git remote -v
# origin    → TianJiaJi/CloudHelm     (开发仓库，日常 push)
# upstream  → 404-Wont-Fix/CloudHelm  (总仓库，仅供 fetch)
```

## 项目简介

CloudHelm 是景区智慧导览系统的运维作战室 MVP，提供 Vue3 监控大屏、FastAPI 控制面、Kubernetes 适配、演示后备、实时日志和安全 AI 运维助手。

快速启动与演示流程见 [docs/OPERATIONS.md](./docs/OPERATIONS.md)。

## 仓库内容

```
CloudHelm/
├── README.md        # 项目说明（含双仓库结构）
├── AGENTS.md        # AI Agent 工作须知
├── WORKFLOW.md      # 双仓库协作工作流（开发前必读）
├── .gitattributes   # 统一换行符
└── .gitignore       # Git 忽略规则
```

## 开发环境准备

```bash
git clone https://github.com/TianJiaJi/CloudHelm.git CloudHelm
cd CloudHelm
```

克隆后请先阅读 [WORKFLOW.md](./WORKFLOW.md)。

## 分支约定

| 分支   | 所在仓库 | 用途                                |
| ------ | -------- | ----------------------------------- |
| `main` | 总仓库   | 稳定分支，跟踪 `upstream/main`       |
| `dev`  | 开发仓库 | 日常开发集成分支，跟踪 `origin/dev`  |

## 协作流程一句话版本

**开发仓库 `dev` 上开发 → PR → 总仓库 `main`。**

除 GitHub 自身的仓库权限外，本项目**没有设置任何额外限制**（无分支保护、无 Git hook）。

详细操作与命令见 [WORKFLOW.md](./WORKFLOW.md)。

## 许可证

待补充。
