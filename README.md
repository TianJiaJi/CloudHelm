# CloudHelm

> 云端 Helm —— 项目仓库初始化占位说明。

## 项目简介

CloudHelm 是一个正在开发中的项目。本仓库已完成 Git 协作基础设施初始化，尚未包含业务代码。

## 仓库结构

```
CloudHelm/
├── README.md        # 项目说明
├── WORKFLOW.md      # 双账户协作工作流（开发前必读）
├── .gitattributes   # 统一换行符
└── .gitignore       # Git 忽略规则
```

## 开发环境准备

```bash
git clone https://github.com/TianJiaJi/CloudHelm.git CloudHelm
cd CloudHelm
```

克隆后请先阅读 [WORKFLOW.md](./WORKFLOW.md)，了解本仓库的双账户远端与分支约定。

## 分支约定

| 分支   | 位置                     | 用途                             |
| ------ | ------------------------ | -------------------------------- |
| `main` | 上游主仓库（新账户）     | 稳定分支，跟踪 `upstream/main`    |
| `dev`  | 开发仓库（老账户）       | 日常开发集成分支，跟踪 `origin/dev` |

## 协作流程一句话版本

**开发 → 推送老账户 `dev` → 需要同步主仓库时走 PR。**

老账户的仓库可以理解为新账户主仓库的一个克隆副本，日常操作与普通仓库无异。

详细操作与命令见 [WORKFLOW.md](./WORKFLOW.md)。

## 许可证

待补充。
