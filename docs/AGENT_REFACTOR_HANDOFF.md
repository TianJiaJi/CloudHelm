# Agent 重构 · 开发交接文档

> **读者**：接手本重构的开发人员。
> **前提**：你已读过 [实施计划](V5_3_REFACTOR_PLAN.md) 与两份配套规格，理解"做什么"。本文只回答"现在到哪了、接下来怎么干、什么不能碰"。
> **写法**：每一步先读文件、再跑测试、后动手。不凭记忆或旧报告改代码。

---

## 1. 当前仓库状态

| 项 | 值 |
|---|---|
| 分支 | `refactor/agent-v5_3` |
| HEAD | `2d8b0f2` 收敛长作业观察与精确停止（G2 末子批；本文档更新随 G2 收尾提交入库） |
| 基线 | `5b66d92`（Phase 1 编排层拆分） |
| 环境 | Node 24.22.1 / pnpm 11.9.0 / Electron 44.5.1 / Pi SDK 1.5.0 |
| 测试规模 | 349 文件 / 3141 项（3135 通过、6 既有环境跳过、0 失败） |
| 构建 | `pnpm build` 通过 |

### 本地提交序列

```
2d8b0f2 收敛长作业观察与精确停止           ← G2 T4d 长作业观察
dbab5ca 统一业务失联的记录与重建分支      ← G2 T4c 业务失联两分支
781b545 建立显式逻辑上下文契约           ← G2 T4b 显式逻辑上下文
f9fdd4a 统一恢复用例的三种具名处置        ← G2 T4a 统一恢复用例
7551fac 归档G1收尾的三模式契约进度        ← G1 收尾归档
7b0aab7 对齐模式二协议的三处集成测试预期
6264515 建立预授权范围的裁决契约          ← G1-L 模式三
ff1060b 落地模式二自审确认协议的端到端闭环 ← G1-K 模式二
45b5030 补充SFTP文件路线的分步准入核验    ← G1-J
864f337 扩展后台setsid路线的单次启动许可  ← G1-I
e525863 扩展PTY与会话路线的单次启动许可   ← G1-H
faf2688 统一工具结果的正交事实协议        ← G1-G
a85f2a0 移交Agent重构工作并编写开发交接文档
ddf6993 绑定原生SSH前台命令的单次启动许可 ← G1-F
5b66d92 Phase 1 编排层……                 ← 你从这里出发的旧基线
```

### 工作区中的"不归你管"

以下是你接手前就存在的用户文件/草稿，**不要修改、暂存、提交或删除**：

```
M docs/AGENT_REFACTOR_ROADMAP.md
M docs/README.md
?? apps/desktop/resources/skills/           ← 用户自写 Skills 草稿
?? docs/AGENT_CURRENT_STATE_DEEP_DIVE.md   ← 用户的源码剖析草稿
```

如果这些改动影响你运行测试（一般不会），单独报告，不自行解决。

---

## 2. 已经做了什么（到 `ddf6993` 为止）

按时间顺序，每个子批有一份独立报告在 `docs/`。这里只给你结论和关键入口，细节看报告。

### G0 — 基线与可行性

**目的**：固定现状，建立可执行契约。

- SDK 60 秒工具等待、取消、恢复不重放、关闭独立 IO —— 全部有本地证据。
- 复现了两类原始问题：用户拒绝后整轮中断；sudo/su 文本被误判为"未启动"。

报告：[AGENT_REFACTOR_G0_REPORT.md](AGENT_REFACTOR_G0_REPORT.md)

### G1-A — 认证结果分类收紧

**做了什么**：sudo/su 的拒绝/缺失文本不再被提升为可信的 `not-started/effects:none`。全部保守化为 `output-inference / businessCommand:unknown / effects:possible / recovery:verify`。

**关键文件**：
- `packages/adapters/src/ssh-command-terminal.ts` — 删除了 125/127/标记文本的零副作用捷径
- `packages/adapters/src/native-session-terminal.ts` — 同样保守化
- `packages/core/src/privilege.ts` — 提示文案区分 transport 与 output-inference

**安全底线**：混合 PTY 输出来源不可信。不要为"减少暂停"恢复 `effects:none` 捷径。

报告：[AGENT_REFACTOR_G1_AUTH_REPORT.md](AGENT_REFACTOR_G1_AUTH_REPORT.md)

### G1-B — 受限只读续查

**做了什么**：用户拒绝 / 变更可能部分生效 / 结果未知时，本轮可以继续已授权的只读前台 native-exec 查询，不立即 `abort()` 模型。新写入被拦在 `continuation-read-only`。

**关键文件**：
- `apps/desktop/src/worker/execution-scheduler.ts` — `diagnosisOnly` 标志 + `admitsOperation`
- `apps/desktop/src/worker/review-coordination.ts` — 新增 `diagnosis-only` 协调效果
- `packages/application/src/safety-gate.ts` — `admitsOperation` 钩子

**注意**：诊断模式 = 本轮无新写入，但不解除主机未决写锁。用户显式新消息重置。

报告：[AGENT_REFACTOR_G1_CONTINUITY_REPORT.md](AGENT_REFACTOR_G1_CONTINUITY_REPORT.md)

### G1-C — 审批等待权威迁至 Application

**做了什么**：WorkerServer 的 pending map / 计时器 / 续期 / 受理 全部移入 `ApprovalCoordinator`。

**关键文件**：
- `packages/application/src/approval-coordinator.ts` — 唯一等待权威
- `packages/core/src/approval-lifecycle.ts` — `ApprovalWaitBinding` 契约
- `apps/desktop/src/worker/server.ts` — 只剩 RPC/事件转换

**安全底线**：审批 ID 一次性、绑定快照隔离、发布异常失败关闭。

报告：[AGENT_REFACTOR_G1_APPROVAL_REPORT.md](AGENT_REFACTOR_G1_APPROVAL_REPORT.md)

### G1-D — 审批等待释放执行槽

**做了什么**：等待审批时释放 OperationScheduler 容量，批准后重新入队尾并在拿回槽位后重新校验。

**关键文件**：
- `apps/desktop/src/worker/operation-scheduler.ts` — `OperationSlot.whileWaiting`
- `packages/application/src/safety-gate.ts` — `GateExecutionObserver.withApprovalWait`

报告：[AGENT_REFACTOR_G1_SLOT_REPORT.md](AGENT_REFACTOR_G1_SLOT_REPORT.md)

### G1-E — 主机队列后的入口准入

**做了什么**：区分 `canEnterExecutor`（含审批硬截止，排队后检查）和 `isAuthorized`（持续上下文，运行中有效）。

**关键文件**：
- `packages/application/src/host-serial-executor.ts` — 取到队列后检查入口
- `packages/application/src/terminal-manager.ts` — 交给命令通道前检查

报告：[AGENT_REFACTOR_G1_ENTRY_REPORT.md](AGENT_REFACTOR_G1_ENTRY_REPORT.md)

### G1-F — 原生前台 exec 的单次启动许可

**做了什么**：`claimStart` 回调绑定实际 host/命令/cwd，在 `ssh2.client.exec` 前单次消费。

**关键文件**：
- `packages/application/src/safety-gate.ts` — 生成并终结许可
- `packages/adapters/src/native-ssh-exec.ts` — 在 `client.exec` 前检查并消费
- `packages/adapters/src/ssh-transport.ts` — 传入实际目标

**安全底线**：只覆盖 `native-exec` 前台。PTY / 后台 / 文件路线**未覆盖**，见第 3 节。

报告：[AGENT_REFACTOR_G1_NATIVE_START_REPORT.md](AGENT_REFACTOR_G1_NATIVE_START_REPORT.md)

### G1-G — 统一工具结果的正交事实协议

**做了什么**：OperationResult v2 携带 handoff / businessStart / liveness / effects 四类正交事实及 identity / output / nextActions。`done` 不等于业务成功；`kill` 返回不冒充退出。

**关键文件**：`packages/core/src/operation-outcome.ts`、`apps/desktop/src/worker/operation-feedback.ts`

### G1-H/I/J — PTY/会话、后台 setsid、SFTP 文件路线的单次启动许可

**做了什么**：三条路线各自在真实交接点（PTY 分配、setsid launch、SFTP writeFile/deleteFile）单次消费启动许可，绑定实际 host/命令/cwd/路径与内容哈希；预检与读回不消费。

**关键文件**：`packages/adapters/src/native-ssh-pty.ts`、`native-background.ts`、`packages/adapters/src/sftp-file-transaction.ts`

### G1-K — 模式二自审确认协议

**做了什么**：`adjudication-required` 回执绑定操作/身份/策略指纹与终端代次；同模型显式二次确认后放行，未确认不派发；`adjudicationId` 仅作关联引用不作重放凭证；无 dedicated reviewer 时自审为默认路径。

**关键文件**：`packages/application/src/review-execution.ts`、`apps/desktop/src/worker/review-coordination.ts`

### G1-L — 模式三预授权范围

**做了什么**：core 纯匹配器 `matchPreauthorization`（单调用形状/参数前缀/文件 kind+路径根），越界 deny 且未执行；scope 经 `update-host-safety` 增量下发并随 policyRevision 失效；解释器与提权入口双层拦截。

**关键文件**：`packages/core/src/preauthorization.ts`（匹配器）、`apps/desktop/src/worker/server.ts`

### G2 T4a — 统一恢复用例的三种具名处置（`f9fdd4a`）

**做了什么**：恢复用例收敛为拒绝 / 仅解除 / 接受并继续三种具名处置；恢复决策持久化（`recovery-decision-store.ts`），contracts 恢复 DTO 与 main/renderer 恢复卡片对齐。

**关键文件**：`apps/desktop/src/main/recovery-decision-store.ts`、`apps/desktop/src/main/recovery-ipc.ts`、`packages/contracts/src/index.ts`

### G2 T4b — 显式逻辑上下文契约（`781b545`）

**做了什么**：新增 worker 逻辑上下文模块，任务下发时显式携带默认 cwd 与环境配置，不再依赖隐式环境推断；TaskRunner、operation-feedback、task-prompt 接线。

**关键文件**：`apps/desktop/src/worker/logical-context.ts`、`apps/desktop/src/worker/task-runner.ts`

### G2 T4c — 业务失联的记录与重建分支（`dbab5ca`）

**做了什么**：`TaskRunner.recordConnectionLoss` 统一记录断线（撤销该代次许可/挑战/失效等待，按证据分类）；server disconnect 路径接入；重建传输后有界恢复，已交接未知不自动重放；新连接不恢复旧 Shell/批准/密码。

**关键文件**：`apps/desktop/src/worker/connection-loss.ts`、`apps/desktop/src/worker/task-runner.ts`、`apps/desktop/src/worker/server.ts`

**安全底线**：单纯只读失联不加业务写锁；“连接成功”不等于旧写入已完成。

### G2 T4d — 长作业观察与精确停止（`2d8b0f2`）

**做了什么**：观察窗口/输出上限/通道分配等常量收敛为 `OBSERVATION_LIMITS` 具名配置；`RawTerminal.onObservationTimeout` 钩子 + `TerminalManager.expireObservation`：前台 native-exec 长跑观察窗口到期 → 发 data 提示并以 unknown 结算工具调用（不伪造退出、不 abort、不 close），保留 pending 供迟到真实退出记账；stop 请求与退出语义保持分离。

**关键文件**：`packages/core/src/observation-limits.ts`、`packages/application/src/terminal-manager.ts`、`packages/adapters/src/ssh-command-terminal.ts`

### G2 收尾

补齐批次外 `server-preparation` 假 runner 的 `recordConnectionLoss` 桩；全量串行 345 文件 / 3135 项通过、0 失败；生产构建通过。

---

## 3. 接下来干什么

G1 与 G2 已按本地验证口径全部结项（真实环境验收除外）。下一阶段：

### G3 — 隔离真机对照（待用户授权）

开始前需用户明确授权以下事项，未授权不开展：

- 真实主机 SSH 环境（含 PAM/提权路径）用于对照验收；
- 付费模型账号与固定模型版本；
- 固定的环境/任务/模型组合与请求/成功率统计口径（对照 G0 基线）。

G4（受控切换）及以后在 G3 结项前不要提前做。

---

## 4. 怎么验证

### 4.1 每次改代码必跑

```sh
pnpm typecheck
pnpm lint
pnpm lint:deps
pnpm lint:lines
pnpm lint:tests
```

### 4.2 改了执行/安全相关

```sh
pnpm exec vitest run --no-file-parallelism Tests/application Tests/adapters Tests/desktop/worker
```

### 4.3 提交前

```sh
pnpm exec vitest run --no-file-parallelism   # 全量串行
pnpm build
```

### 4.4 证据边界

- 全量通过 ≠ 真实 SSH/PAM 验收。
- 模拟模型 fixture ≠ 生产模型行为。
- `pnpm build` ≠ 安装包可用。
- 真实主机/付费模型操作须用户单独授权。
- 本机装有 360 主动防御（ZhuDongFangYu 服务）。全量串行曾两度出现仅 `conversation-cleanup` 两个 junction 用例失败（各约 31.3 秒同步阻塞后 EPERM），定位为该防护对长跑进程创建 reparse point 的间歇性拦截（单文件隔离运行、裸 Node 复现、后续全量均通过）。再遇到“仅 junction/符号链接用例、30 秒级阻塞后 EPERM”的失败模式，先按环境干扰排查，不要当作代码回归。

---

## 5. 不能做的事（红线）

1. **不要**把混合文本（sudo/su 拒绝/缺失/提示）当可信的 `not-started` 证据。
2. **不要**在 G1-A 已删除的 `effects:none` 捷径上恢复任何变体。
3. **不要**把 `canEnterExecutor` / `isAuthorized` / `claimStart` 中任一个当"远端已执行"或"远端未执行"的证明。
4. **不要**在未决写锁存在时开放新写入，也不要因"模型想继续"而解锁。
5. **不要**把审批 ID、许可回调或任何内部凭证放进模型上下文、UI、IPC 参数或数据库。
6. **不要**为了减少请求数而跳过业务验证或把不确定操作标成确定。
7. **不要**把 `agent.abort()` 当作终止远端进程。
8. **不要**修改上面第 1 节列的用户已有文件。

---

## 6. 开发规范提醒

- 遵守 `AGENTS.md` 的依赖方向和 800 行限制。
- 提交信息用简体中文。
- 每个子批完成后更新 [AGENT_REFACTOR_PROGRESS.md](AGENT_REFACTOR_PROGRESS.md)。
- 测试放 `Tests/`，业务代码不反向导入测试。
- 失败测试不要跳过；如果确实是环境限制，用现有 opt-in 模式并记录原因。
- 依赖固定版本，数据库迁移走版本化。

---

## 7. 文件速查

| 你想找… | 先看… |
|---|---|
| Agent 一次命令的完整链路 | `apps/desktop/src/worker/execution-scheduler.ts` → `packages/application/src/safety-gate.ts` |
| 什么算只读 | `packages/core/src/command-query-impact.ts`、`packages/core/src/safety.ts` |
| 结果怎么回流给模型 | `apps/desktop/src/worker/operation-feedback.ts` |
| 审批等待 | `packages/application/src/approval-coordinator.ts` |
| 槽位释放 | `apps/desktop/src/worker/operation-scheduler.ts` |
| 观察窗口/输出上限常量 | `packages/core/src/observation-limits.ts` |
| 长作业到期 unknown 结算 | `packages/application/src/terminal-manager.ts`（`expireObservation`） |
| 业务失联记录 | `apps/desktop/src/worker/connection-loss.ts`、`task-runner.recordConnectionLoss` |
| 逻辑上下文 | `apps/desktop/src/worker/logical-context.ts` |
| 恢复决策持久化 | `apps/desktop/src/main/recovery-decision-store.ts` |
| 认证/提权 | `packages/adapters/src/native-ssh-pty.ts`、`packages/core/src/privilege-routing.ts` |
| 启动许可 | `packages/adapters/src/native-ssh-exec.ts`（目前唯一覆盖） |
| 提示词 | `apps/desktop/src/worker/agent-prompt.ts`（`PROMPT_VERSION` 变更要 bump） |
| 测试 fixture | `Tests/desktop/worker/task-runner-fixture.ts`、`Tests/adapters/pi-session-fixture.ts` |

---

*交接文档随代码一起提交，后续接手人员根据实际进展更新本文和进度页。*
