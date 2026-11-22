# Agent 重构 · 开发交接文档

> **读者**：接手本重构的开发人员。
> **前提**：你已读过 [实施计划](V5_3_REFACTOR_PLAN.md) 与两份配套规格，理解"做什么"。本文只回答"现在到哪了、接下来怎么干、什么不能碰"。
> **写法**：每一步先读文件、再跑测试、后动手。不凭记忆或旧报告改代码。

---

## 1. 当前仓库状态

| 项 | 值 |
|---|---|
| 分支 | `refactor/agent-v5_3` |
| HEAD | `ddf6993` 绑定原生SSH前台命令的单次启动许可 |
| 基线 | `5b66d92`（Phase 1 编排层拆分） |
| 环境 | Node 24.22.1 / pnpm 11.9.0 / Electron 44.5.1 / Pi SDK 1.5.0 |
| 测试规模 | 339 文件 / 3025 项（3019 通过、6 既有环境跳过、0 失败） |
| 构建 | `pnpm build` 通过 |

### 三个本地提交

```
ddf6993 绑定原生SSH前台命令的单次启动许可      ← G1-F
aaca187 修复主机排队后的审批准入时效          ← G1-E
fffb7d7 重构Agent连续性与审批等待并建立验收基线  ← G0 + G1-A/B/C/D
5b66d92 Phase 1 编排层……                      ← 你从这里出发的旧基线
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

---

## 3. 接下来干什么

按优先级排序。每完成一个子批：跑测试 → 更新进度 → 本地 commit（中文提交信息，不 push）。

### 3.1 G1 剩余：统一结果协议（最优先）

**目标**：工具返回的四类结果（`done / running / adjudication-required / rejected`）必须附带正交事实：

```
handoff: not-sent | handed-off | unknown
businessStart: not-started | started | unknown
liveness: running | exited | unknown
effects: none | possible | observed-change | unknown
identity: requested / observed / evidenceSource
output: tail / truncated / captureComplete / logRef
nextActions: 允许模型当前做什么
```

**改哪里**：
- `packages/core/src/ports.ts` — OperationResult / ExecutionOptions 字段
- `packages/core/src/operation-outcome.ts` — 归约纯规则
- `apps/desktop/src/worker/operation-feedback.ts` — 结构化工具返回
- `packages/application/src/safety-gate.ts` — 结果组装

**契约**：`done` 不等于业务成功；`kill` 返回不冒充退出；`reset` 不清未决锁。缺字段一律标 unknown。

**测试入口**：`Tests/core/operation-outcome.test.ts`、`Tests/desktop/worker/operation-feedback.test.ts`

### 3.2 G1 剩余：其余执行路线的启动许可

目前只有 `native-exec` 前台有 `claimStart`。以下路线需要各自的等价约束（设计不一定复用同一个回调）：

| 路线 | 文件 | 要注意什么 |
|---|---|---|
| native-pty（sudo/su） | `native-ssh-pty.ts`、`native-session-terminal.ts` | PTY 分配后可能还有认证步骤；业务启动边界比 exec 复杂 |
| native-background | `native-background.ts` | setsid 启动后才产生 pid；启动/控制/退出是三次不同交接 |
| SFTP 文件 | `file-operation-executor.ts`、`sftp-file-transaction.ts` | 多步 IO，每步都要独立的准入/时效检查 |

**原则**：每条路线只能在自己的真实交接点消费许可，不能把 `canEnterExecutor` 或 `isAuthorized` 当作实际已发送的证明。

### 3.3 G1 剩余：三模式裁决契约

- 模式一：审批等待 + 拒绝后诊断（已部分完成）
- 模式二：显式自审（`adjudication-required`）— 需要明确"可核对的自审条件"，不能只留"拿得准"
- 模式三：预授权范围命中 + 越界拒绝

改 `packages/application/src/review-execution.ts`、`review-coordination.ts`。分级表变更走 Core 策略版本。

### 3.4 G2 — 核验、写锁与一次确认恢复

- 统一恢复用例（拒绝 / 仅解除 / 接受并继续）
- 显式逻辑上下文（默认 cwd / 环境配置）
- 业务失联两分支
- 长作业观察与精确停止

### 3.5 G3–G6

见 [AGENT_REFACTOR_PROGRESS.md](AGENT_REFACTOR_PROGRESS.md)。在 G1/G2 没结项前不要提前做。

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
| 认证/提权 | `packages/adapters/src/native-ssh-pty.ts`、`packages/core/src/privilege-routing.ts` |
| 启动许可 | `packages/adapters/src/native-ssh-exec.ts`（目前唯一覆盖） |
| 提示词 | `apps/desktop/src/worker/agent-prompt.ts`（`PROMPT_VERSION` 变更要 bump） |
| 测试 fixture | `Tests/desktop/worker/task-runner-fixture.ts`、`Tests/adapters/pi-session-fixture.ts` |

---

*交接文档随代码一起提交，后续接手人员根据实际进展更新本文和进度页。*
