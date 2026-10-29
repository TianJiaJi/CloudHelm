# 文档索引

当前产品行为以实现、[使用指南](USER_GUIDE.md)、[安全边界](SECURITY.md)和[验收状态](STATUS.md)共同核对。研究、旧测量和历史通过数字不能代替当前版本验证，也不构成执行或连接真实主机的授权。

## 使用与开发

| 文档 | 用途 |
| --- | --- |
| [项目总览](../README.md) | 产品能力、运行与发布入口 |
| [使用指南](USER_GUIDE.md) | 主机、对话、终端、认证、核验与故障处理 |
| [开发指南](DEVELOPMENT.md) | 环境、命令、CI、构建与贡献 |
| [集中测试](../Tests/README.md) | `Tests/` 分区、fixture、smoke、离线评估和运行边界 |
| [架构说明](ARCHITECTURE.md) | 依赖、进程、持久化、执行与恢复 |
| [逐文件功能地图](CURRENT_ARCHITECTURE_MAP.md) | 生产模块职责、实际工具入口与功能限制 |
| [安全与数据边界](SECURITY.md) | 审批、凭据、日志、主机锁与已知限制 |
| [验收状态](STATUS.md) | 当前本机结果与历史 CI／真实环境证据，分别记录 |
| [仓库开发约束](../AGENTS.md) | 分层、单一职责、安全与工程要求 |
| [更新日志](../CHANGELOG.md) | 未发布变更及已发布版本记录 |

## 当前实现专题

| 文档 | 用途 |
| --- | --- |
| [验收 V3](VERIFICATION_V3.md) | 自动事实、输出预期、内容读回、显式轮次、历史与离线重整 |
| [Agent 证据边界](agent-evidence-boundaries.md) | 观察／推断／未知、纠错和业务结论的判读规则 |
| [受控提权](privilege-contexts.md) | prepared sudo、私密认证、root SSH／su 备选及验证限制 |
| [Agent 提示词规范](AGENT_PROMPT.md) | 指令归属、后端授权、工具反馈和历史测量 |
| [Pi 需求澄清](PI_ASK_USER.md) | 内置插件、问答生命周期、凭据底线与许可 |
| [AI 助手面板](AI_PANEL_UI.md) | 当前 UI 交互、原创实现及参考／验证边界 |
| [命令审核开发参考](COMMAND_REVIEW_DEVELOPMENT_GUIDE.md) | 已落地语义修复、后续设计、回归矩阵及修复前探针 |

## 保留的研究与历史记录

这些文件仍有固定源码、许可证或设计取舍价值，因此不作为“无用文档”删除。结论仅适用于文中所注明的版本与研究范围；缓存证据和本地计划可能未随 Git 提交，不能假定新机器已有。

| 文档 | 范围 |
| --- | --- |
| [权限设计研究](PERMISSION_RESEARCH.md) | 开源实现依据与采纳边界 |
| [开源命令安全源码审查](OPEN_SOURCE_COMMAND_SAFETY_SOURCE_REVIEW.md) | 固定提交源码与许可；优先于初筛结论 |
| [开源候选初筛](OPEN_SOURCE_COMMAND_SAFETY_OPTIONS.md) | 历史网页初筛，不作为最终 API 或许可核验 |
| [Trae CN Agent 架构](TRAE_CN_AGENT_ARCHITECTURE.md) | 指定制品版本的静态入口、事件与原生边界 |
| [Trae CN 命令审核](TRAE_CN_COMMAND_REVIEW.md) | 指定版本的权限与审核证据，不是 CloudHelm 执行机制 |
| [Trae CN 推荐与 SSH](TRAE_CN_FOLLOWUPS_SSH_ANALYSIS.md) | 指定版本的推荐、SSH 与未验证范围 |
| [Agent 执行一致性历史交付](agent-execution-consistency-delivery.md) | 该阶段的修改与验证证据，不代表当前全量结果 |

已清理过期临时会话交接；其有效设计、固定版本研究与正式回归入口由上述专题文档保留。后续仅在信息确已失效或重复时删除资料，并同步引用；不把历史失败改成通过，也不删除未知或风险记录来“清理状态”。
