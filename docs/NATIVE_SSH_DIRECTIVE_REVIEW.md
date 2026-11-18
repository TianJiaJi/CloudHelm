# 执行层重构修正指令：接收与评审记录（2026-11-18）

> 状态：**仅接收与评审，未开始实施**。本文记录用户下达的修正指令要点、与当前代码/契约文档的对照、以及评审发现的问题。实际进度仍以 [NATIVE_SSH_HANDOFF.md](NATIVE_SSH_HANDOFF.md) 为准；迁移契约见 [NATIVE_SSH_EXECUTION_MIGRATION.md](NATIVE_SSH_EXECUTION_MIGRATION.md)。

## 一、指令要点（接收原文摘要，不改原意）

**总纲**：远端 Python（process.py）彻底删除，原生 SSH 成为唯一基础设施；密码接收与注入职能由本地客户端接管，经原生 PTY 通道完成，服务器零放置。

**三通道（SafetyGate 裁决附带通道标注，执行器按标注路由）**：
| 通道 | 用途 | 要点 |
|---|---|---|
| native-exec | 默认 | 原生 exec；退出码用协议 exit-status/exit-signal；超时=关 channel；统一 `env -i` + PATH 白名单净化 |
| native-pty | 交互命令、sudo/su | requestPty；密码注入通道 |
| 后台作业模块 | 长任务 | setsid + `$!` + PGID kill + `/proc` 归属验证 + 重连恢复；独立工程最后做，完成前此类命令返回 capability_blocked，禁止 shell 临时方案 |

**删除**：process.py 及 SFTP 放置逻辑、`--serve` 常驻、连接前 python3 门禁检查；不留兼容开关。

**能力档案**：探测从"门禁"改为"档案"——连接后一次性探测（python3 有无、包管理器、可用工具），持久化，暴露给 agent 计划期。

**SafetyGate 新增**："不透明负载"分类（`python3 -c`、`perl -e`、`bash -c`、eval、base64 块）：无法证明只读按写类处理，静态分析失效走保守路由，审计打标记。复杂变换引导走客户端处理（SFTP 拉文件 → 本地变换 → 结构化写回），决策梯度写入工具描述：结构化 > 原生 > 客户端处理 > 远端脚本。

**特权与密码层**：
- 最小权限梯度：普通用户（默认）→ sudo 单命令提权（需密码时走审批卡）→ sudo 失败后 su root，顺序不可跳。
- 硬规则进 SafetyGate：① 无失败 sudo 记录，su 请求直接拒绝，禁止直接 su；② 每条 sudo/su 是显式特权事件，独立审批卡 + 事件流标注 + 审计 root 痕迹；③ 不做 root 直连主推，接入姿态分级语义改为"提权顺畅度"，免密 sudo 是推荐配置。
- 密码机制：审批卡上直接输密码，输入=授权（一步）；密码进客户端内存，任务作用域持有复用（用户只输一次，客户端每条命令注入一次）；客户端经原生 PTY 识别密码提示符后写入 PTY，sudo 从终端读走（回显关闭）；任务结束/熔断/超时内存销毁，UI 常驻"特权凭证已授予"状态。
- 红线：密码不落盘、不进模型上下文、不进命令行参数、不进审计日志、服务器零放置；sudo 认证失败呈现给用户重输，禁止 agent 盲试；提示符识别必须确定——agent 执行 `sudo -p '固定标记'`，客户端认标记不靠猜，su 同通道同机制。

**分期**：P0-A 删门禁 + native-exec + env -i 净化 + 能力档案 + 通道标注；P0-B native-pty + 密码注入机制 + Bootstrap 向导 + H03 验收；P1 文件事务 shell 化（重新验收）+ su 走 native-pty；P2 后台作业模块（此前 capability_blocked）；P3 删 process.py 全部残留。

**验收场景**：① 无 python3 的 Alpine/busybox：连接、Tier 0 命令、文件写入全部成功；② 密码 sudo 主机：审批卡输密→PTY 注入成功，审计无密码痕迹，任务结束凭证状态熄灭；③ sudo 失败→su 按顺序解锁，直接请求 su 被拒；④ 禁 SFTP 主机命令执行与特权链路可用；⑤ `BASH_ENV` 被拦截、`sudo -p` 标记识别无误报、quoting 边界全绿；⑥ 服务器上无任何放置物（diff /tmp 验证）。

**定位说明**：这是把"工具依赖远端运行时 + 远端接收密码"翻转为"零放置 + 原生通道 + 客户端持密"。此前三选一问题（阻断/固定助手/暂留 Python）作废。

## 二、与当前代码的映射

**已具备（可复用，均未提交）**：
- native-exec 通道已落地：`native-ssh-exec.ts`（exit-status/exit-signal、missing-exit/timeout/aborted→unknown 不重放、1 MiB 输出上限）、`native-exec-command.ts`（env -i + /bin/sh + 受控 PATH/cwd）、preflight 已写入 `executionChannel: 'native-exec'` 标注。
- SQLite v15 `host_capabilities` 观察归档 + 计划期 `capability-blocked` 阻断已存在，方向与"档案化"一致。
- SafetyGate 统一入口、审批绑定（操作/主机/目录/身份/策略版本/终端代次）、`effects:none` 语义已存在。
- 后台作业派发前阻断（"需要旧 Python 驱动，不要绕过"提示）已存在，与 P2 前保持 capability_blocked 一致。
- `nativeCommandEligible`（core/native-command-route.ts）已有 wrappers 黑名单与 `hasCodeExecution` 判定，"不透明负载"分类是在其上加层，不冲突。

**尚未存在**：native-pty 通道、客户端密码注入、`sudo -p` 标记协议、特权梯度硬规则、能力档案的计划期投影与 UI、文件事务 shell 化、后台模块、Bootstrap 向导。

## 三、评审发现

### A. 硬性问题（实施前必须先解决）

1. **su 不支持 `-p` 自定义提示符**。`sudo -p '标记'` 可行；但 su 的密码提示来自 PAM（通常固定 `Password: `），无等价参数。"su 同通道同机制"只能做到同 PTY 通道，**"认标记不靠猜"在 su 上无法用 `-p` 实现**。需要替代设计：例如 su 前先执行一条产生唯一 nonce 输出的前导命令 + 对 PAM 提示的窄窗口匹配，或明确 su 提示识别采用更宽的确认条件并写进安全论证。
2. **H03 分期矛盾**。指令把"H03 验收"整体放 P0-B，但 H03 三链之一"后台启动→观察→精确停止"依赖 P2 后台模块（迁移契约第 3 阶段也如此约定）。建议改为：P0-B 验收 H03 前两链（前台诊断、配置→校验→服务健康），后台链在 P2 完成后补验，H03 整体收口在 P2。
3. **sudo 缺失主机死锁**。"无失败 sudo 记录，su 直接拒绝"在主机根本没有 sudo（busybox/最小镜像）时无解。需补充解锁条件：能力档案观察到 sudo 缺席（或探测确认不可用）同样解锁 su 路径。另建议明确：sudoers NOPASSWD 主机直接免密执行，不进密码流程。
4. **"固定标记"存在伪造窗口**。静态固定标记可能被 sudo 之下的目标命令输出复现，诱导客户端在错误时机注入密码。建议标记改为 per-invocation nonce（绑定操作指纹/终端代次），一次识别一次注入。"固定"应理解为"客户端确定已知"，而非"跨调用不变"。
5. **能力探测载体自身依赖 python3**。`host-environment-probe.ts` 的主探测命令是 `python3 -I -S -B -c ...`，档案化后探测载体必须改为原生只读 shell 命令序列（`command -v` 等），否则无 Python 主机无法建档。现有 shell fallback 的覆盖面需逐项核对（PATH 解析、工具存在性、包管理器识别）。

### B. 需要明确的设计决策

6. **删除范围比 process.py 大**。远端 Python 依赖共四处：① process.py（ssh-transport.ts:269-277 放置）；② `remoteCommandProgram` 内联 `--serve`（remote-command-program.ts，ssh-command-terminal.ts:187 使用）；③ `suSessionProgram` 内联（su-session.ts:30）；④ `remoteFileProgram` 内联（file-transaction-runner.ts:88）。"删 process.py"应理解为删除全部四处及其 SFTP 放置；P3 收口清单需列全。
7. **档案 ≠ 授权的边界要保留**。迁移契约不变量："能力档案只是观察，不是授权"，持久化归档不能当执行权限。指令说"连接后一次性探测、持久化、暴露给计划期"——建议表述为：计划期可读持久化档案（可能过期，仅用于规划与提示），执行授权仍以当前连接新鲜观察为准（现有 preflight 语义），实施时不放宽。
8. **交接遗留项"审批绑定能力档案版本"指令未提**。建议保留：审批卡绑定观察到的工具路径/档案版本，防审批与实际执行环境漂移。
9. **"失败 sudo 记录"的作用域未定义**。任务级、主机级还是跨任务持久？现有 `operation-privilege.ts` 的 alternatives 是会话内存 Map。建议任务级 + 当前身份作用域，避免跨任务记忆；与现有 su fallback 逻辑（operation-input-bridge.ts:123 `canOfferSuFallback`）对齐硬化。
10. **认证失败与授权事件的关系**。密码输错时授权已发生（命令已派发）——同操作同代次内重输是否算新授权事件？建议：同操作内重输不需新审批卡，但客户端限次（如 3 次）后销毁凭证并终止，呼应"禁止盲试"（禁令同时约束 agent 与客户端侧）。
11. **AGENTS.md 表述需同步修订**。现文"密码与验证码不能进入……普通 Shell 输入"在 PTY 注入落地后语义冲突。P0-B 时应把该条更新为"受控 PTY 凭证注入通道"语义（红线不变：不落盘、不进模型上下文/审计/日志、服务器零放置）。
12. **密码的跨进程路径**。架构为主进程管凭据、utility process 跑 SSH。密码流：renderer 审批卡输入 → 主进程 → utility process PTY。审批卡与 agent 对话同在 renderer，必须复用现有私密输入隔离机制，确保密码不进模型上下文、任务事件流与渲染层持久状态；utility process 崩溃时凭证随进程销毁需验证。
13. **PTY 流量录制的红线处理**。注入窗口内 input 侧永不录制；output 侧自标记出现至换行间不录制（sudo 回显关闭，正常不含密码，作为纵深防御）。审计中命令含 `-p '标记'` 可接受（标记非秘密），密码不得出现在任何流。
14. **native-pty 与人工终端的隔离**。现有人工接管走 `integratedShell` + grant（server.ts:483）。native-pty 是 agent 驱动的特权通道，须保持授权/代次语义分离，防止其变相成为绕过 SafetyGate 的人工通道。
15. **Bootstrap 向导需求缺失**。P0-B 仅一行提及（装 Python？装哪些工具？经 SafetyGate 的什么操作形态？），实施前需补设计。
16. **错误分类**。sudo 认证失败需区分：密码错误 / 不在 sudoers / 超时 / PAM 故障，避免把"用户不在 sudoers"误报为密码错误导致反复输密。

### C. 验收口径澄清

17. **场景 6 "零放置"口径**：应限定为"我方放置物"（process.py、内联程序、临时目录）；sudo 自身会写 `/var/db/sudo/ts`，sshd 会写 lastlog/wtmp 等系统记录，diff /tmp 验证时需排除系统自身写入，否则误判。
18. **场景 4 与 P1 的交集**：SFTP 被禁时 P1 文件事务与客户端变换工作流（SFTP 拉文件→本地变换→写回）均不可用。场景 4 只要求命令执行与特权链路可用，与迁移契约"不可承诺任意主机均能安全写文件"一致；工具描述/能力档案需明确降级告知，fail-closed。
19. **场景 1 "文件写入全部成功"**：P1 完成前，无 Python 主机的严格文件事务不可用（现走 `python3 -c remoteFileProgram`）。场景 1 的文件写入验收须排在 P1 之后，或在 P0 阶段仅验收受限写入形态并明确边界。

## 四、对既有文档的影响（待实施时同步）

- HANDOFF 第"尚未完成"第 1 条的三选一问题（阻断/固定助手/暂留 Python）由本指令作废，接收方确定为客户端 PTY 注入。
- 迁移契约四条不变量全部保持，本指令不放宽任何一条；"不透明负载"分类与"档案化"是对其的实现细化。
- AGENTS.md 密码条目在 P0-B 落地时同步修订（见第 11 条）。

## 五、最终裁决（2026-11-18）

用户对第三节全部 19 项裁决完毕：**A 类 5 项、B 类 11 项、C 类 3 项全部采纳评审建议**。红线零放宽：密码不落盘、不进模型上下文/命令行/审计/日志、服务器零放置、档案≠授权。

裁决细化与用户另定项：

- **A1（su 无 `-p`）**：采用"窗口 + 单次注入 + 状态机一次进出"替代设计。安全论证：等待态期间用户代码输出面为零，风险等级等价于 nonce 方案。
- **A2（H03 分期）**：H03 拆链——前台诊断、配置→校验→服务健康两链在 P0-B 验收；后台启动→观察→精确停止链在 P2 后台模块完成后补验；H03 整体收口在 P2。
- **A4（标记防伪）**：nonce 方案采纳并细化三项：① 客户端生成、派发时改写；② 单次注入双保险（状态机一次进出）；③ 验收增加 nonce 复现负向测试（伪造标记不得触发注入）。
- **B15（Bootstrap 向导）**：降级为纯指导形态，不往服务器安装任何东西。
- **C19（场景 1 拆分）**：拆两段——P0 受限写入 = exec 重定向、无事务保证；严格文件事务排 P1。
- **另定四项**：
  1. nonce 生成权在客户端；
  2. sudo 统一 `-k` 前缀，强制每命令独立认证；
  3. native-pty 环境净化与 native-exec 一致；locale 确定性是 PAM 特征匹配的前提，列为验证点；
  4. su 提示特征表跨实现（sudo/PAM 发行版差异）核对后写入文档。
- **分期**：按修订后的分期表执行。

## 六、开工前置：串行全量回归结果（2026-11-18）

按裁决补跑当前工作树的串行全量回归（命令 `pnpm exec vitest run --no-file-parallelism`）：

- **第一次**：644.6s，322 文件通过 / 1 文件失败 / 7 跳过；2833 项通过 / 2 失败 / 27 跳过。失败为 `Tests/desktop/worker/local-file-access.test.ts` 两个符号链接用例 30s 超时；该测试文件及其被测模块均不在本次未提交修改集内。
- **隔离复跑该文件**：5/5 通过（349ms）。
- **第二次全量**：476.2s，**323 文件通过 / 7 跳过；2835 项通过 / 27 跳过（共 2862），零失败**。第一次的两处失败未复现，判定为首次运行高负载（collect 303s vs 244s）下的瞬时超时，非代码回归。
- 与交接基线（323 文件 / 2834 项通过 / 27 跳过）相比净增 1 项通过，对应交接后新增的 env 工具观察与计划期阻断测试。

**结论**：交接记录遗留的"更新后串行全量回归尚未完成"缺口已闭合，未发现实际回归，P0-A 开工前置条件满足。

## 七、P0-A 实施记录（2026-11-18）

### A. 落地改动

1. **删连接时 Python 门禁**：`ssh-transport.ts` 删除 `commandPreflights`/`checkCommandEnvironment`（pty/fcntl 探测缓存）及 `prepareCommandProgram` 内调用；连接不再要求 python3 可用。`prepareCommandProgram` 的 `command -v python3 && mktemp` 放置机制按 P3 计划保留。
2. **探测载体原生化**：`host-environment-probe.ts` 重写——删除 Python 程序、`HOST_ENVIRONMENT_PROBE`、`parseHostEnvironment`、`readHostEnvironment`；`probeHostEnvironmentViaShell` 更名 `probeHostEnvironment`，成为唯一载体；shell 程序补 `/usr/lib/os-release` 回退；退出码 127 归类 `unsupported`（永久限制），删除 `python-missing` 失败原因。
3. **source 语义收口**：core `HostEnvironmentData.source` 收窄为 `'shell'`；contracts `HostCapabilityProfile.data.source` 保留 `'python' | 'shell'` 联合（持久化历史记录合法，无需 DB 迁移）；`readinessOf` 的 metadata 由 python/shell 降级区分改为 `data ? 'ready' : 'unknown'`。
4. **能力档案计划期投影**：`RuntimeHost` 新增 `archivedCapability`（loginAs/observedAt/data），由 `attachArchivedCapability`（host-capability-record.ts）按身份匹配从 SQLite 持久档案附着；`environmentProjection` 无 live 观察时投影 `archivedProfile`（observedAt 安全整数且 ≤now 才投影），仅作计划期提示，`inspect_host_environment` 工具保持 live 观察语义不回退。
5. **不透明负载收口**：核查确认 `bash -c`/`python3 -c` 等不在 QUERY_COMMANDS → 恒为 mutation 'possible'（写类）、codeExecution 'detected' → 保守路由，且 `audit.classified` 已将含 codeExecution 标记的 impactAnalysis 持久化进 operation view；`run_remote` 工具描述补充决策梯度（结构化工具 > 原生命令 > 客户端变换 > 远端脚本）。
6. **通道标注核查**：`executionChannel: 'native-exec'` 已全链路落地（preflight → SafetyGate → fingerprint → task-runner 视图 → terminal-manager → ssh-command-terminal 路由），无剩余工作。

### B. 测试同步

- 重写 `Tests/adapters/host-environment-probe.test.ts`（shell 载体 13 例，含 POSIX 实测、127→unsupported、越界与取消）。
- `remote-program-syntax.test.ts` 删除 `HOST_ENVIRONMENT_PROBE` 编译条目。
- `ssh-transport.test.ts` 以放置程序输出校验测试替换原 Python 门禁缓存测试。
- registry/server-environment/workspace-context 系列测试 fixture `source` 改 `'shell'`；registry readiness 断言去 `degraded`；失败原因用例改 `unsupported`。
- 新增 workspace-context `archivedProfile` 投影测试（live 优先、身份隔离、时间戳校验）。
- `sqlite-store.ts` 持久记录 data 类型放宽为 legacy 联合（`Omit<HostEnvironmentData,'source'> & { source: 'python' | 'shell' }`），存储层兼容历史行。
- `app-state.ts` 档案附着逻辑抽至 `attachArchivedCapability`（原文件 805 行超 800 上限）。

### C. 验证结果

- `pnpm typecheck`、`pnpm lint`、`pnpm lint:lines`、`pnpm lint:tests`、`pnpm lint:deps`（806 模块 3301 依赖零违规）全部通过。
- 串行全量回归（`pnpm exec vitest run --no-file-parallelism`）：**504.3s，323 文件通过 / 7 跳过；2833 项通过 / 27 跳过（共 2860），零失败**。与第六节基线相比净减 2 项，对应删除的 Python 门禁缓存用例与 `host-environment` 编译条目，无回归。
- Electron 构建（`pnpm build`）通过：main 290 模块 / renderer 1249 模块。
