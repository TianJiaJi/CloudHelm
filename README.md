# CloudHelm

> 云端 Helm —— 项目仓库初始化占位说明。

## 项目简介

CloudHelm 是一个正在开发中的项目。本仓库已完成 Git 协作基础设施初始化，尚未包含业务代码。

## 仓库结构

```
CloudHelm/
├── README.md              # 项目说明
├── WORKFLOW.md            # 双账户协作工作流（开发前必读）
├── .githooks/
│   └── pre-push           # 本地护栏：拦截误推主仓库 / main
├── scripts/
│   ├── install-hooks.sh   # 启用 hooks（Linux / macOS / Git Bash）
│   └── install-hooks.ps1  # 启用 hooks（Windows PowerShell）
├── .gitattributes         # 统一换行符
└── .gitignore             # Git 忽略规则
```

## 开发环境准备

```bash
git clone <your-fork-url> CloudHelm
cd CloudHelm

# 启用本地护栏（core.hooksPath 是本地配置，克隆后必须执行一次）
sh scripts/install-hooks.sh              # Linux / macOS / Git Bash
pwsh -File scripts/install-hooks.ps1     # Windows PowerShell
```

克隆后请先阅读 [WORKFLOW.md](./WORKFLOW.md)，了解本仓库的双账户远端与分支约定。

## 分支约定

| 分支     | 位置                 | 用途                              |
| -------- | -------------------- | --------------------------------- |
| `main`   | 上游主仓库（新账户） | 稳定分支，推荐通过 PR 合入        |
| `dev`    | 开发 fork（老账户）  | 长期开发集成分支，日常推送到这里  |

## 协作流程一句话版本

**开发 → 推送老账户 `dev` → （可选）老账户发 PR → 新账户 `main`。**

> 个人使用场景采用**低摩擦**策略：主仓库 `main` 的**服务端分支保护已关闭**，
> 代码也可直接推送；PR 保留为可选路径。恢复保护的命令见 WORKFLOW.md §5.1。

当前生效的护栏只有客户端一层：

- **客户端**：`.githooks/pre-push` 拦截向主仓库或 `main` 的直接推送，报错为中文并给修复建议
- **绕过方式**：`ALLOW_PROTECTED_PUSH=1 git push ...`

详细操作与命令见 [WORKFLOW.md](./WORKFLOW.md)。

## 许可证

待补充。
