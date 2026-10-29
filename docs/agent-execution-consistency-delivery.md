# Agent 执行一致性修复：历史交付与验收

本文保留该阶段的实现依据、失败边界与当时验证数字，不作为当前工作树的最新验收。报告机制已演进为[验收 V3](VERIFICATION_V3.md)，测试入口统一迁入 [Tests/](../Tests/README.md)；当前结果见[验收状态](STATUS.md)。

## 历史状态

- 阶段A–F2已验收，计划正式完成13/13步，已标记第13步。
- 最终完整门禁：`bb7fd8190`退出0，133文件、1350测试通过，7文件19项条件跳过（16项POSIX/PTY、3项外部SSH opt-in）；typecheck、ESLint、依赖方向、800行、版本/CHANGELOG、构建、完整Edge UI、Markdown、隔离Windows Electron装配及`git diff --check`全部通过。对照脚本13项测试包含在总数中。
- Electron装配验证了preload隔离、SQLite/WASM、临时safeStorage、loopback握手、本地模型协议、崩溃恢复及无重复投影；不是打包产物验收。截图位于`.cache/ui-smoke/`、`.cache/markdown-smoke/`和`.cache/desktop-smoke/built/window.png`。
- 真实模型、真实用户主机SSH和自然行为对照**未运行**；本文不把本地fixture通过等同于模型不会幻觉。
- 该阶段自动验收未升级依赖、修改 SDK 或发版。Git 提交不等于发布或真实环境验收；当前提交范围以操作者本轮确认及实际 Git 历史为准，不由旧交付记录限制。

## 主要变更

1. **查询与失败语义**：Docker字面字段模板按AST/专用语法分类；Gate权威effect-free能力与批准分离。明确退出的查询失败不制造变更锁/报告；认证拒绝、停止、未知退出仍阻塞。新增有界ping和少量系统诊断的effect-only语法，不新增自动批准。
2. **恢复与意图**：首个持久化风险/证据解决结果保留；风险接受不等于成功或新授权。真正输入、澄清和原生消息来源分离，历史/UI投影不改目标。历史修复需要完整操作指纹并原子提交，不批量清锁。
3. **读取与工具**：选定文件支持有界UTF-8/字节页和版本；目录稳定游标、真实/未知大小。service阶段绑定确认的sessionId，不降级身份。反馈前置操作ID、状态、截断及有界日志检索入口。
4. **预算、进展、重试**：Main持久化轮次与每次尝试，明确追加100次，不因失败/取消/重启补额；输入摘要和独立审核分开计量。新观察而非提案数量推进；允许固定HTTP请求的有限安全重试，不重放工具或整轮。
5. **输入与上下文**：独立准备租约复用既有发送记录。空闲时最多一次原生压缩，再重算/摘要；活动期间不强行compact。控制/模型/凭据/政策变化撤销准备；预算确认后也复查。计算活动投影、输出预留、安全余量及有界下一输入索引增长，不截断JSONL。
6. **业务事实投影**：每请求系统投影携带有界意图索引、全部未决/活动ID、风险接受、最新变更与证据、来源版本和日志边界。紧凑表不省略安全字段；超限停止，无第二数据库真相源。
7. **报告与证据纪律**：v2逐项记录目标/预期/观察/证据及passed/failed/inconclusive，每个变更关联检查或未验证原因。后端校验归属/主机/时序/真实退出/只读；诚实的失败/无法确定报告可结束回答但保持unverified。旧报告标记历史格式，不自动获得新版检查结论。
8. **UI与诊断**：修复统计栏与输入框同级key冲突造成旧统计残留；统一显示后端可输入空间及容量来源。诊断区分预算回执、请求尝试、响应归属，保留round/logicalRequestId/attempt/purpose；不再记录生产聊天/命令或文件正文、远端输出和原始错误长文。

## 可复查入口

- `plans/agent-execution-consistency-fixes.md`：逐阶段决策、失败与验收记录（本地计划文件，默认忽略提交）。
- `docs/agent-evidence-boundaries.md`：Docker/架构/存储/网络/服务的观察、推断、未知与纠错样例。
- `Tests/desktop/main/structured-preparation-integration.test.ts`：Main/SQLite→IPC→Worker→TaskRunner→原生压缩，取消/变更/丢确认扣费与无重放。
- `Tests/desktop/worker/request-business-facts-native.test.ts`：压缩后事实与授权刷新、JSONL保留。
- `Tests/desktop/worker/task-runner-diagnostic-query.test.ts`：ping退出1与unknown的不同处理，人工审批保留。
- `Tests/desktop/worker/task-runner-verification-v2.test.ts`：三态报告、真实原生历史恢复、新消息与无重放。
- `Tests/smoke/check-budget-switching.mjs`、`Tests/smoke/check-verification-checks.mjs`：切换对话及新版/历史报告UI回归。
- `.cache/ui-smoke/`：本地截图，包括统计修复前后、输入预算与v2检查展示；不会上传。

## 自然任务对照脚本（只生成模板、比较人工记录）

```text
node -e "require('node:fs').mkdirSync('.cache',{recursive:true})"
node Tests/evaluation/agent-task-comparison.mjs --template > .cache/agent-before.json
node Tests/evaluation/agent-task-comparison.mjs --template > .cache/agent-after.json
node Tests/evaluation/agent-task-comparison.mjs --compare .cache/agent-before.json .cache/agent-after.json
```

两个`--template`命令只生成未运行、未知计数的JSON模板。`--compare`命令在填写前会拒绝比较；不要把模板当已验证结果。脚本没有执行模式，不连接模型、主机或SSH，不启动Shell，只读取明确指定且≤64KiB的对照元数据文件，不读取应用数据/私有日志。

只有另行获得授权后，才由操作者手动在旧/新版本执行模板的G1–G5自然任务，并填写：

- 固定provider/model、有效thinking、审核档位、容量、13工具集合及相同主机快照匿名代号；各案例使用新的对话，保留相同提示和输入证据。填入两边源版本/工作树代号。
- `conversationAttempts/compactionAttempts/summaryAttempts/reviewAttempts`计持久化获确认的尝试预留，**不证明服务端收包或计费**。`logicalRequests`按逻辑ID去重，不把回执与请求遥测相加。
- `remoteCommands/remoteOperations`按实际执行归属去重，不按proposed/分类更新/结果通知的重复事件计数。未测到的值保留null。
- `pauses`按状态变迁计；“不必要暂停/核验提示”和证据准确性/纠错纪律必须人工判读。案例未运行时不能填通过或虚构0。
- 两边环境不一致、改提示、未知字段、重复案例、非法计数或凭据字段会被拒绝。不得填密码、API Key、验证码、地址凭据、日志正文或完整答案。
- 输出仅是差值和人工等级，不是受认证的执行证据；更少请求不自动代表更安全或更正确。必要补证可以合理增加请求数。

## 已知限制

- 尚无真实模型自然任务或真实用户SSH对照，不能声称幻觉已消除、性能/成本普遍下降或所有诊断形式都被识别。
- 查询分类刻意窄；复杂管道、展开、包装器、未知参数等仍保守处理，不能为便利绕过审核、认证或结果锁。
- 估算是保守UTF-8策略，不是精确tokenizer；自定义容量可含兼容默认值，推理能力不按名字猜。预留可能提前拒绝临界输入。
- 原生压缩可能保留一个巨大的边界消息，因此成功不保证腾出空间；不足时拒绝、不循环、不篡改SDK或历史。活动投影、完整JSONL与UI历史不是同一概念。
- 事实索引是有截断披露的检索索引，完整意图仍在后端ledger/SafetyGate；归属/时序/退出码不能证明业务语义相关性或完整应用健康。
- 远端日志/本地页有大小、版本与保留边界；不承诺旧输出永远可取。目录扫描上限10000，选定普通文件来源上限1MiB，页约50KiB，未新增本地Shell/MCP/任意文件访问。
- HTTP自动重试仅支持已验证的fetch路线，最多3次固定请求尝试；opaque/WebSocket等保守计量。不能保证失败尝试绝不重复计费，取消也不退款或重放。
- 停止Agent/Electron或丢连接不证明远端进程已退出。未知结果先核验，不能直接重放；SFTP不继承sudo/su身份。
- 生产诊断正文隔离后，不应依靠诊断流重建答案/文件/远端输出；仍可使用原生会话、现有审计和受授权的日志检索。原始私有AppData日志未读取，系统网络设置未改。
- 最终装配验收限当前Windows环境和未打包构建；未生成安装包，未验证macOS/Linux或打包后发行物。应用新构建前先确认模型与远端均空闲，不因界面刷新重放未确定操作。

## 当前可重跑命令

在Windows cmd中清空真实SSH opt-in，并使用现有Edge的独立临时浏览器配置：

```text
set "CLOUDHELM_TEST_SSH_KEY="
set "CLOUDHELM_SMOKE_BROWSER_CHANNEL=msedge"
set "CLOUDHELM_LOG_LEVEL=off"
set "CLOUDHELM_LOG_DIR="
pnpm typecheck
pnpm test --maxWorkers=1
pnpm lint
pnpm lint:deps
pnpm lint:lines
pnpm lint:tests
pnpm version:check
pnpm changelog:check
pnpm build
pnpm test:ui
pnpm test:markdown
pnpm test:desktop
git diff --check
```

Electron smoke使用独立临时用户目录、生成的假密钥、loopback SSH/SSE服务及模拟对话；它不是用户主机SSH或真实模型验证，不读取日常浏览器资料、现有凭据或私钥。条件集成测试的19项跳过不表示已验证其真实环境。
