# Agent 架构重构路线图（唯一权威事实源）

> 本文件是 CloudHelm Agent 架构重构论证的**唯一权威事实源**：后续所有 Phase 的设计文档、验收基线与痛点论证必须引用本文件。用户维护的外部重构说明书自本文件建立起降为参考副本，每次交付同步修正后标注"以仓库为准"。两处事实源发生分歧时，以本文件为准。

## 红线七条（全 Phase 不变，code review 引用依据）

1. **三进程隔离**：Main（窗口/凭据/IPC/SQLite 权威 + 两阶段输入持久化）、worker（TaskRunner/工具/审核协调）、utility process（Agent 与 SSH）。Renderer 只投影状态。
2. **SafetyGate 分析能力与 fail-closed**：每条操作独立过 `decideSafety` 分析；分析器失败、策略过期、终端代次不符一律拒绝派发，不自动放行。
3. **审批绑定与执行前复核**：批准绑定操作内容（指纹）、主机、目录、身份、策略版本与终端代次；执行前 `isAuthorized()`/`stillCurrent()` 复核，任一变化自动失效。
4. **凭据隔离**：密码与验证码不进模型上下文、命令行参数、审计正文或本地日志，服务器零放置；特权凭证只经客户端持有的受控 PTY 注入通道投递。
5. **SSH exec/PTY 分离**：普通命令走 exec 通道；sudo/su 认证走专用 PTY，凭据注入不混入普通 Shell 输入。
6. **unknown ≠ failed**：结果未知的操作不自动重放、不当作失败处理；先核验，未知写锁拦截后续变更并要求显式解除。
7. **Pi SDK 引擎 + `noTools:'builtin'` + `BusinessTool.replay:'never'`**：模型引擎层永不重放业务工具；重试只发生在 SafetyGate 之后的执行通道内（见 Phase 0 P0-1）。

## 现状核查修正记录（2026-11-21）

对原重构说明书的 15 项事实陈述逐项核查代码：13 项属实，2 项修正如下，后续 Phase 论证一律采用修正后口径。

### 修正 1：审批过期触发整轮暂停（比原文档更严重）

审批过期不是"按拒绝处理"那么简单：内部 `verdict:'error'`（`approval-expired`），操作投影 `denied`，并触发 `pause-round` **整轮暂停**（`apps/desktop/src/worker/review-coordination.ts`）。用户错过一个窗口回来会发现整轮停摆——**该事实强化 P0-5（软到期提醒+续期）的优先级**。

### 修正 2：restart 审批卡数（比原文档轻）

原文档"manage_service restart 产生 1–3 张独立审批卡"不成立。实测（代码 + 测试双闭环）：`ReviewMode = 'ask' | 'ai-review' | 'permissive'`，**不存在 strict 模式**。卡数矩阵：

| 操作 | ask | ai-review | permissive |
|---|---|---|---|
| preflight/check（只读 `systemctl show`） | 0 卡（'allow'） | 0 卡（'allow'） | 0 卡（'allow'） |
| restart（`systemctl restart`，高影响） | **1 人工卡** | 'evaluate' AI 预审，AI 不确定/超时/错误才升级 1 人工卡 | **1 人工卡** |

依据：只读 query 走 `isLowRiskCommand` → 'allow'（`packages/core/src/safety.ts`，与模式无关）；非查询 systemctl 判高影响 → `highImpactDecision`（ask/permissive 均 'ask'，"even the permissive tier keeps asking"）；ai-review 走 `executeReview` AI 预审（`packages/application/src/safety-gate.ts`）。基线由 `Tests/core/safety-risk-matrix.test.ts`（restart 三模式 + 服务探测三模式）锁定进 CI。**任何模式下 restart 最多 1 张人工卡**（+ root 路径可能的认证输入卡，属另一交互类型）。

**Phase 2 意图级审批的收益论证相应重聚焦**到三个未被削弱的场景：文件编辑事务、计划外变更拦截、跨步骤授权聚合。

## Findings（防后续 Phase 考古）

- **F1 permissive 豁免边界**：permissive 在 restart（已识别高影响）场景与 ask 行为相同（都 1 卡）。代码事实：permissive 只豁免"不确定命令"（uncertain-command → allow）、"项目代码入口"（project-code-entry → allow）、"外传/代码执行"（external-transfer/code-execution → allow），**不豁免已识别高影响**。此边界是 Phase 2"意图级审批 × 三模式"语义矩阵的直接输入。
- **F2 AI 预审角色已存在**：ai-review 模式已有独立 AI 审核角色（`executeReview` + evaluator，`packages/application/src/safety-gate.ts`）——与 Phase 1 编排层、Phase 2 IntentManager 的审批决策有架构合并潜力。不记录的风险是将来做成两套平行 AI 审查逻辑。

## 验收基线（Phase 0 前）

| 维度 | 基线值 | 锚点 |
|---|---|---|
| restart 三模式卡数 | ask/permissive 各 1 卡；ai-review AI 预审；preflight/check 三模式 0 卡 | `Tests/core/safety-risk-matrix.test.ts`（进 CI） |
| 只读并发墙钟 | **4 条并发只读 ≈ 245.6ms（单条 60.3ms，≈×4.1）**——当前 `serialCall` 全串行 | `scripts/measure-readonly-concurrency.mjs` 实跑 2026-11-21（不进 CI）；断言版测试随 P0-3b 进 CI |
| 提示词否定式占比 | executionGuidelines 严格否定句式按 bullet 计 **50%** | `apps/desktop/src/worker/agent-prompt.ts`（P0-7 前人工口径） |
| 系统提示字符数 | 门禁 ≤ 12000 字符 | `Tests/desktop/worker/task-runner-authorization.test.ts`（进 CI） |

## 基线测量协议

| 层 | 内容 | 进 CI |
|---|---|---|
| 代码级基线 | fixture 测试锁定三模式卡数矩阵、12000 字符门禁 | 是（已有） |
| 并发墙钟测量脚本 | `scripts/measure-readonly-concurrency.mjs` 实跑记录数字入上表 | 否 |
| 断言版并发测试 | 4 条慢 query 墙钟 ≈ 单条断言 | 随 P0-3b 提交（scheduler 已建、parallel 已切，全绿 = 并发生效 + 断言通过，天然自洽） |
| VM 门控运行时基线 | 协议如下，环境可用即执行；VM 验收当前冻结（H03），不阻塞代码级工作 | 否 |

**VM 门控运行时基线协议**（推导变实证，消除"代码与测试同错"的同义反复风险）：
1. 三模式各跑一次 `manage_service restart`，记录实际弹卡数，与上方矩阵核对（三个 case）。
2. 重启 nginx 端到端：轮数 / 卡数 / 耗时。
3. 5 条只读诊断（`ss -ltnp`、`df -h`、`free -m`、`systemctl status`、`journalctl -n 50`）串行墙钟耗时，Phase 0 完成后同口径复测出对照表。

## Phase 0（止血七项，10 个提交单元）

| # | 单元 | 核心动作 | 状态 |
|---|---|---|---|
| P0-0 | 基线与文档回写 | 本文件 + 测量脚本 + 基线锚点 | 进行中 |
| P0-4 | 删僵尸工具 | 物理删除 `edit_remote_file`（`available:()=>false` 永不激活）及全部引用 | 待做 |
| P0-1 | 重试矩阵 | `operation-retry.ts` 瞬态二分（执行前连接失败才自动重试；执行中超时/在途失败不自动重试且携带"禁止盲目重发"警示）；写零重试；参数错误字段级报错 | 待做 |
| P0-3a | 调度器等价重构 | `operation-scheduler.ts` 接管 `serialCall`，行为仍全串行；调度键 `{taskId, terminalId}` 二元组（Phase 3 多终端钩子零成本预留） | 待做 |
| P0-3b | 切 parallel | pi-session 单行 `'sequential'`→`'parallel'`；切换前三查（SafetyGate 并发安全 / 审计事件顺序 / Pi SDK 事件流单飞行假设），任一不过即暂停回报；含断言版并发测试（4×→≈1× 对照） | 待做 |
| P0-2 | service 单审批 | 审批卡呈现三段事务意图；三模式回归测试矩阵；root 路径 sudo 缓存复用核查 | 待做 |
| P0-5 | 审批续期 | 软到期提醒（10min）+ 续期（累计 ≤5 次 × 10min，硬截止首发 +60min）+ 硬上限取消；计时权收敛 worker server 单点；`decide-approval` 过期校验改用 hardExpiresAt（软过期后仍可批准） | 待做 |
| P0-6 | 输入提醒 | TTL 过期/投递失败推送式主动提醒（静默窗口无用户交互事件必达 renderer）+ 未聚焦系统通知 | 待做 |
| P0-7 | 提示词重写 | 26 工具 description + executionGuidelines 能力说明书化；否定式 <10% 门禁；PROMPT_VERSION → 2026-12.1 | 待做 |
| SPIKE-C | Layer C 门控调查 | `edit_file` 收敛 Layer C（推翻覆盖禁令）可行性，时间盒 2-3 天，NO-GO 判据先行 | 待做 |

**edit_file 收敛三层风险**：A 门面重塑（中风险，Phase 2）——单一 `edit_file` 内部编排 read(hash)→prepare→apply，内部仍是独立 ProposedOperation 逐个过 SafetyGate；B 自愈语义（中低风险，Phase 2 与 A 同批）——hash 冲突自动读当前内容返回模型重生成 diff；C 推翻覆盖禁令（高风险、前置未知）——SPIKE-C 门控。

## Phase 1-4 路线图摘要

- **Phase 1 编排层**：task-runner.ts（797/800 行）拆分 IntentManager / ExecutionScheduler / RetryPolicy / RecoveryManager；unknown 自动探测恢复；`delegationId` SQLite 列（Phase 0 无迁移窗口，明确留此阶段）。
- **Phase 2 工具收敛**：26→14（edit_file 门面、run_diagnostics、create_file overwrite）；意图级审批（收益聚焦：文件编辑事务 / 计划外变更拦截 / 跨步骤授权聚合，见修正 2）。
- **Phase 3 多终端**：调度键 `{taskId, terminalId}` 二元组在 P0-3a 已预留。
- **Phase 4 计划即契约**：意图级审批全面化。

## 外部主文档同步清单

用户维护的外部重构说明书需同步以下两处修正（交付报告逐条列出，同步后外部文档标注"以仓库为准"）：
1. 痛点映射表："manage_service restart 1–3 张审批卡" → "ask/permissive 模式 1 张卡 + 审批过期触发 pause-round 整轮停摆"；验收基线表同步三模式卡数矩阵。
2. Phase 2 意图级审批收益论证：restart 审批疲劳权重下调，重新聚焦文件编辑事务 / 计划外变更拦截 / 跨步骤授权聚合。
