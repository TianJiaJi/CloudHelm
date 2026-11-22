# Agent 重构 G1-G · 统一工具结果的正交事实协议

> 状态：本批实现与局部回归通过。基线本地提交 `a85f2a0`，分支 `refactor/agent-v5_3`。对应移交文档 §3.1：工具结果不再用单一文字模板表达成败，改为正交事实的显式归约。不宣称完成三模式裁决契约与全部执行路线的启动许可。

## 覆盖的实际边界

`OperationResult` 扩展出 `handoff`（命令是否离开客户端）、`businessStart`（业务是否开始执行）、`liveness`（进程活性）三个正交事实；`effects` 增加 `'observed-change'`。`OperationOutcome` 升级为版本化结构（`version: 2`），由 `receipt`（done/running/adjudication-required/rejected）、`handoff`、`businessStart`、`liveness`、`exit`、`effects`、`nextActions`、`replay` 归约而成，运行反馈与恢复路径不再从工具文字推断结论。

- 核心新增导出 `ExecutionFailureFact`（`Pick<OperationResult, 'failureKind' | 'effects' | 'privilege' | 'requiresUserAction' | 'handoff' | 'businessStart' | 'liveness'>`），`onExecutionFailure`、`PendingCommand.failure`、`DeferredTerminal.failure` 与适配器私有字段统一改用该类型；多次 `failure` 回调以赋值覆盖，故诊断负载内嵌交接事实防丢失。
- 归约规则：rejected ⟺ 旧 notStarted 或（handoff `not-sent` 且 failed）；running ⟺ 已交接或 liveness `running`；liveness 缺省按退出码归约；`nextActions` 主项为 verify-outcome/inspect-result 时追加 `read-log`，revise-operation 不追加。
- `operationToolResult` 的 structuredContent 增加身份事实 `{ requested: scope.runAs, observed: 'unknown', evidenceSource: 'not-observed' }`：请求身份来自后端 scope，观察身份不从输出文本推断。

### 见证语义（按证据强度）

`NativeExecOutcome`/`NativePtyOutcome` 的退出码来自 SSH 通道 `exit` 事件（传输层事实，非输出解析）：

- 未派发（工具缺失、传输驱动缺失、sudo 凭证未确认、launch not-dispatched）：`handoff: 'not-sent'`、`businessStart: 'not-started'`，receipt 归约 rejected。
- 可信 exit 0（exec 直发、PTY sudo/su 包装、会话 stdin 注入、后台 stat 核验通过、SFTP 核验通过）：`handoff: 'handed-off'`、`businessStart: 'started'`。sudo/su 包装的 exit 0 传播子进程退出码，可证业务已启动并成功完成。
- exited 非零或 signaled：仅 `handoff: 'handed-off'`。exit 125/127/126 等不能统一证明业务未启动，businessStart 保持 unknown。
- 结果 unknown：不作任何见证。SSH 分配失败时请求可能从未离开客户端，handoff 本身不可证。
- PTY 文本诊断（sudo missing/denied、su 认证/缺失、会话密码重复质询）保留为 inference：`effects: 'possible'`，字面量内嵌 `handoff: 'handed-off'`，绝不据此清零 effects 或证明业务未启动；每次结算只发一次 failure 回调。
- SFTP 文件操作：`RemoteFileError.effects 'none'` 由传输层见证变异步从未开始 → `not-sent`；`'possible'` → RemoteFileError 时 `handed-off`；核验通过 → `effects: 'observed-change'`；未核验 → `'possible'` + `failureKind: 'unknown'`。
- 后台 launch exit≠0、pid 无法解析、stat 核验失败、进程消失（PROC_GONE）、stat 解析失败均见证 `handed-off`；stat 核验成功在 `started()` 前见证 `handed-off + started`；launch 结果 unknown 不见证。
- 中断/终止类操作（kill/processControl）的 v2 结果为 receipt `done`、liveness `unknown`、exit `null`、nextActions `['continue']`：不把信号回执冒充退出证明。
- `runningFeedback` 嵌入 v2 outcome（receipt `running`/handed-off/started/liveness `running`/effects `unclassified`/nextActions `['inspect-result']`）；后台观察通道中断（transport-lost）的恢复路径嵌入全 unknown 的 v2 outcome + nextActions `['verify-outcome']`。业务代码改用 `.receipt === 'rejected'` 判定。

## 限定范围

PTY sudo/su、显式身份会话、后台启动/写交接点的单次启动许可（§3.2）尚未接入，归后续子批。`'adjudication-required'` 的生产路径与三模式裁决契约（§3.3）留待裁决子批，本批全部 notStarted 归约走 `'rejected'`。identity 的 `observed` 恒为 `unknown`，不从输出提升。真实 SSH/PAM、付费模型与真实部署验收不在本批范围。

## 测试与结果

- `Tests/core/operation-outcome.test.ts` 全量重写为 v2 契约（15 项）：默认成功、handed-over→running、not-dispatched→rejected/not-sent/not-started、日志追加、replay 恒 never。
- `Tests/adapters/native-command-terminal.test.ts`（15 项）、`native-session-terminal.test.ts`（9 项）、`native-background.test.ts`（14 项）更新为见证契约：正向 attestation（exit 0 → handed-off+started）、诊断字面量含 handoff、未派发含 not-sent/not-started、unknown 不见证。
- `Tests/desktop/worker/operation-feedback.test.ts` 扩展 v2 details 与 identity 断言；`file-operation-executor.test.ts`（14 项）、`file-edit-capability.test.ts` 更新 v2 断言。
- 局部回归四批全绿：core/application/contracts 10 文件 102 项；adapters 10 文件 99 项通过 +1 环境跳过；worker 直接影响面 6 文件 59 项；task-runner/operation 集成 15 文件 98 项。合计 358 项通过、1 项跳过、0 失败。
- `tsc --noEmit`、ESLint 全量、依赖巡检（855 模块 / 3559 依赖）、行数、测试布局检查全部通过。

验证后以“统一工具结果的正交事实协议”提交本地分支，不 push；本报告和代码同一提交，准确哈希以 `git log` 为准。局部回归不替代 G1 收尾的全量串行与构建检查。
