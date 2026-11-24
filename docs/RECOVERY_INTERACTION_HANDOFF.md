# 移交：恢复决策交互问题与 Agent 重构进度（2026-11-23）

> **读者**：接手 Agent 重构后续工作的开发人员。
> **背景**：G0–G2 已全部结项（第 2 节）。用户在真机使用（`npm run dev` + deepseek-flash + 真实 SSH 主机）中报告了恢复/风险确认组件的交互问题；本文记录代码级核实结论、遗留疑点与建议修复范围，作为 G3 前插入专项批（或另行排期）的依据。
> **权威文档**：进度与逐子批证据见 [AGENT_REFACTOR_PROGRESS.md](AGENT_REFACTOR_PROGRESS.md)；G0–G2 完整交接见 [AGENT_REFACTOR_HANDOFF.md](AGENT_REFACTOR_HANDOFF.md)；架构约束见 [ARCHITECTURE.md](ARCHITECTURE.md) 与仓库根 AGENTS.md。
> **更新（2026-11-24）**：G3 真机验收已完成并通过——三关注项结论、证据与复现方式见 [G3_REAL_MACHINE_REPORT.md](G3_REAL_MACHINE_REPORT.md)（已提交）。真机 harness 为 `Tests/smoke/g3-real-machine.mjs`（凭据仅经 `G3_*` 环境变量注入），回放系统已支持 `model.response error` 字段记录模型失败原因。第二轮补充验收（受限提权/断线恢复/版本对照三组证据，及 su 回退通道缺陷记录 P-1/P-2/P-3）见 [G3_REAL_MACHINE_SUPPLEMENT_REPORT.md](G3_REAL_MACHINE_SUPPLEMENT_REPORT.md)。

## 1. 仓库状态

| 项 | 值 |
|---|---|
| 分支 | `refactor/agent-v5_3` |
| HEAD | `b2a0de1` 收尾G2核验写锁与一次确认恢复 |
| 测试基线 | 349 文件 / 3141 项（3135 通过、6 既有环境跳过、0 失败）；`pnpm build` 通过 |
| 未结项 | G3 真机验收（待用户授权：真实 SSH 主机、付费模型、固定任务口径）、G4 引擎切换、G5 工具面与人工底座收敛、G6 Skills/MCP/多主机/子代理 |

**工作区"不归你管"**（用户自己的未提交文件，不要修改、暂存、提交或删除）：`docs/AGENT_REFACTOR_ROADMAP.md`、`docs/README.md`、`apps/desktop/resources/skills/`、`docs/AGENT_CURRENT_STATE_DEEP_DIVE.md`。

**提交规约**：简体中文提交信息；`git add` 显式文件列表（禁 `-A`）；不 push。每子批先契约测试后实现，完成即本地提交；文件 ≤800 行；测试只放 `Tests/`。

## 2. 已完成内容（G0–G2 全部结项，共 21 子批）

四条主题（详细证据见 PROGRESS 文档）：

1. **结果可信**：统一工具结果正交事实协议（faf2688）；长作业观察与精确停止（2d8b0f2）；失败/未知/失联结果的保守处理链。
2. **审批与准入权威**：后端为任务/审核/认证的唯一权威；三档审核；预授权范围裁决（6264515）；PTY/后台/SFTP/原生 SSH/会话各路线单次启动许可（e525863、864f337、45b5030、ddf6993）。
3. **三模式裁决契约**：模式二自审确认协议端到端闭环（ff1060b）、模式三预授权（6264515）、三模式集成预期对齐（7b0aab7）。
4. **断线/长跑/恢复契约**：统一恢复用例三种具名处置（f9fdd4a：拒绝/仅解除/接受并继续）；显式逻辑上下文（781b545）；业务失联两分支（dbab5ca）；一次确认恢复与恢复决策持久化。

G2 收尾（b2a0de1）：全量绿 + build + 文档归档 + `Tests/desktop/worker/server-preparation.test.ts` fake runner 补 `recordConnectionLoss` 桩。

**已知环境干扰（不是代码回归）**：本机装有 360 安全卫士（ZhuDongFangYu 主动防御服务常驻、接管并禁用 Defender）。全量测试偶发仅 junction/符号链接用例失败，签名是**单用例 ~31.3 秒同步阻塞后 EPERM**（历史案例：`Tests/desktop/main/conversation-cleanup.test.ts` 两用例）。重跑即可通过；详见 HANDOFF 4.4。

## 3. 真机使用暴露的问题（本次移交核心）

### 3.1 背景：两轮真机任务日志（2026-11-23 用户提供）

环境：`npm run dev`、模型 deepseek-flash、真实 SSH 主机 `a7f1eda4…`。

**任务 `1cc9abd6`（6 次请求）**：写入命令 human-approved 后失败（exit 1，effects possible）→ 工具结果 `tool-refused` → 模型转只读核验（`cat` 等）→ `record_reconciled_result`（kind=evidence，附 evidenceOperationIds）→ 继续作答。**这是"恢复卡消失"的实例**：对账成功后 `reconciledAt` 置位，卡片渲染条件失配而消失。

**任务 `5d2eaacc`**：写入失败（permission-denied，effects possible）→ 同一命令（sha `3a0da772`）仅改 cwd `/home/tian` → `/` 重试，被重分类为 effect-free 并**实际执行**（op `7f34ddb5`，exit 0）→ 工具结果此时才以 `unresolved-prior-operation` 拒绝（先执行后拒绝）→ `read_operation_log` → `record_reconciled_result` 引用 `7f34ddb5` → sudo（runAs root）被 `continuation-read-only` 拒绝 → 再次写入仍被 `continuation-read-only` 拒绝 → 只读命令收尾作答。**这是 3.3 门禁疑点的实例**。

错误码词汇：`tool-refused`（工具层拒绝回执）、`unresolved-prior-operation`（主机写锁：存在未决结果操作，preflight 拦截）、`continuation-read-only`（轮内只读锁：SafetyGate `admitsOperation` 拒绝）。

### 3.2 用户报告的五条现象与代码核实

| # | 用户原话 | 代码核实 | 分类 |
|---|---|---|---|
| 1 | "只要命令运行失败就会触发他会询问你是否知晓风险继续" | 精确条件：**非只读**命令失败且 `effects !== 'none'`（写失败默认 possible）→ `operationOutcomeResolvable` 为真 → 恢复卡渲染条件 (b) 命中（`apps/desktop/src/renderer/recovery-card.tsx:70-73`、`packages/contracts/src/index.ts:374-377`）。只读命令失败不触发。 | 符合现规格（USER_GUIDE 如此描述），但产品上过度触发，规格层面待定夺 |
| 2 | "之前是点了知晓之后你还需要点AI继续，否则agent是被停掉的状态" | 旧"仅解除"按钮语义即如此（卡片文案明示"风险确认不等于继续聊天"，`recovery-card.tsx:61`）。G2 T4a 已新增"接受并继续"：解锁 + 条件满足才自动续跑，各跳过条件返回 `note`（`apps/desktop/src/main/recovery-ipc.ts:31-61`）。 | 历史行为已部分解决；剩余问题：主按钮不突出、`resumed:false + note` 在 UI 不醒目 |
| 3 | "这个弹窗弹出来之后，AI还在往后思考" | `diagnosisOnly` 轮内只读诊断模式（G1-B 设计）：失败/未知写入置位（`apps/desktop/src/worker/execution-scheduler.ts:143-149`），对话不暂停，模型继续思考但写入全被拒（`packages/application/src/safety-gate.ts:117-123`）。 | 设计内；缺陷是无任何可见状态指示与解除路径说明 |
| 4 | "如果那个弹窗你一段时间不管，它就会消失掉" | **卡片与 IPC 无任何超时、无默认拒绝逻辑**（已核实 `recovery-card.tsx`、`recovery-ipc.ts` 全文）。真实机制：模型在诊断模式调 `record_reconciled_result` 提交证据 → `reconciledAt` 置位 → 渲染条件失配 → 卡片消失（实例见 3.1 任务 1cc9abd6）。 | 缺陷：决策点无声消失，无"已由证据解除"终态展示 |
| 5 | "我估计是默认认为我不同意，所以导致权限被锁为只读" | 因果是误判（无超时默认拒绝），但**结果真实**：`diagnosisOnly` 为轮内作用域，仅 `clearRemoteBlock`（续跑/新输入路径）重置（`apps/desktop/src/worker/task-runner.ts:133、156、435-438`）；证据对账与卡片处置都**不重置**（`execution-scheduler.ts:360-369` 的 `recordRiskAcceptance` 不碰它）→ 卡片消失后写入仍被 `continuation-read-only` 拒绝，直到下一轮。 | 缺陷组合：锁无解释、无解除路径展示，与 #4 叠加造成"被绕过"感受 |

### 3.3 门禁正确性疑点（需原始日志复查，优先级高于交互优化）

来自任务 `5d2eaacc`：

1. **cwd 敏感分类翻转**：同一 sha `3a0da772` 在 `/home/tian` 分类为写、在 `/` 重分类为 effect-free。需复查 analyzer / `analyzeOperationImpact` 对 cwd 上下文的使用是否合理（`safety-gate.ts:114-116`）。
2. **只读锁期间执行**：重试命令在 `diagnosisOnly` 置位后被放行执行。`admitsOperation` 存在 `hasOperationLease` 旁路（`execution-scheduler.ts:295`）——需查该操作是否携带 lease，或走了其他通道（恢复探针 lane 是只读白名单，不应承载写）。
3. **先执行后拒绝**：命令已执行成功（`7f34ddb5`，exit 0），工具结果才以 `unresolved-prior-operation` 拒绝。分类与拦截的先后顺序需收敛为"先裁决后执行"。

复查方法：调取该次运行的 hilog / 工具日志原始记录（两次派发的完整参数与 `record_reconciled_result` 回执），对照 `runOperationPipeline` 的 preflight → gate → 执行顺序（`execution-scheduler.ts:113-164`）。

### 3.4 建议修复范围：专项批「恢复决策交互收敛」（建议插在 G3 前；G3 仍在等授权）

**不许动的红线**（架构与安全契约，见 ARCHITECTURE.md 写锁章节、AGENTS.md）：

- 失败/未知/可能部分生效 → 主机写锁：核心保守契约；
- 安全组件失败不自动放行；接管不宣称旧操作成功、不自动重放、不批准下一条命令；
- 运行中的进程不能借风险确认解锁。

**修复项**（只动交互/沟通/时序，不动裁决语义）：

1. **只读锁状态条**：`diagnosisOnly` 激活期间在会话内显示持久状态条（原因 + "发送新消息后恢复写入"），取代无声锁。
2. **卡片终态化**：操作被对账/接管后，卡片转入"已解除（证据/接管）"终态而不是消失；时间线中 `unresolved-prior-operation` 拒绝可回链到该终态。
3. **触发收敛（需产品定夺）**：失败但本轮尚未撞锁时降为被动提示，实际撞锁（`current` 存在）才弹卡——若采纳需同步修改 USER_GUIDE 的描述。
4. **一步恢复**："接受并继续"设为主按钮；`resumed:false + note`（`recovery-ipc.ts` 各跳过分支）显性展示在卡片上。
5. **拒绝回执附 nextActions**：`unresolved-prior-operation` / `continuation-read-only` / `tool-refused` 拒绝回执附带可执行指引（读日志 → 只读核验 → `record_reconciled_result`，或提示用户在恢复卡处置）——解决日志中小模型空转 ~6 次请求的问题。
6. **时序复查**：3.3 的三条疑点；若确认是缺陷，修复方向是"先裁决后执行"与对 cwd 稳定的分类。

## 4. 关键文件索引

| 层 | 文件 | 职责 |
|---|---|---|
| contracts | `packages/contracts/src/index.ts:363-377` | `operationNeedsVerification` / `operationOutcomeResolvable`（触发判定唯一权威） |
| worker | `apps/desktop/src/worker/execution-scheduler.ts` | `diagnosisOnly` 置位/旁路/重置（73、143-149、209、295、360-369）；preflight 写锁（198-203） |
| worker | `apps/desktop/src/worker/task-runner.ts` | `clearRemoteBlock → resetDiagnosisOnly`（435-438）；deps 接线（133、156） |
| worker | `apps/desktop/src/worker/reconciliation-tool.ts` | `record_reconciled_result` 工具定义 |
| worker | `apps/desktop/src/worker/recovery-probe.ts` | 只读恢复探针（白名单模板、独立 lane） |
| worker | `apps/desktop/src/worker/recovery-manager.ts` | 显式续跑（`resume`）、needsRecovery、§7.2 失联报告 |
| worker | `apps/desktop/src/worker/risk-acceptance.ts` | 已提交风险确认的校验与应用（observed 证据不被覆盖） |
| application | `packages/application/src/safety-gate.ts:114-123` | `continuation-read-only` 规则（`admitsOperation` 注入点） |
| main | `apps/desktop/src/main/recovery-ipc.ts` | 恢复卡 IPC：幂等重放（94-99）、prepare/commit 两段（112、122）、续跑诚实跳过（31-61） |
| main | `apps/desktop/src/main/recovery-decision-store.ts` | 恢复决策持久化（三处置） |
| renderer | `apps/desktop/src/renderer/recovery-card.tsx` | 恢复卡渲染条件与三按钮（70-77、56-61） |

**对应测试**（先读测试理解既有契约再动手）：

```
Tests/desktop/main/recovery-ipc.test.ts
Tests/desktop/main/operation-recovery.test.ts
Tests/desktop/renderer/recovery-card.test.ts
Tests/desktop/worker/risk-acceptance.test.ts
Tests/desktop/worker/reconciliation-tool.test.ts
Tests/desktop/worker/recovery-probe.test.ts
Tests/desktop/worker/task-runner-reconciliation.test.ts
Tests/desktop/worker/server-recovery.test.ts
```

## 5. 查验命令

```powershell
pnpm typecheck
pnpm lint; pnpm lint:deps; pnpm lint:lines; pnpm lint:tests
pnpm exec vitest run --no-file-parallelism Tests/desktop/main/recovery-ipc.test.ts Tests/desktop/renderer/recovery-card.test.ts   # 恢复链路单测
pnpm exec vitest run --no-file-parallelism <逐文件>   # 每子批局部验证
# 里程碑全量约 623s；输出超长时 Tee 落盘 $env:TEMP\*.log
```

**360 干扰签名**：仅 junction/符号链接用例、单用例 ~31.3s 阻塞后 EPERM → 环境干扰，重跑即可，不当代码回归。
