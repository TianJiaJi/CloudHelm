# 无 Python 执行层与 H03：暂停交接

> 用户要求停止继续实施并移交；本文件只记录当前事实和剩余工作，不代表发布、提交或 H03 完成。设计约束见 [NATIVE_SSH_EXECUTION_MIGRATION.md](NATIVE_SSH_EXECUTION_MIGRATION.md)，旧 H03 账见 [REPAIR_PROGRESS.md](REPAIR_PROGRESS.md)。**不要把任何聊天中的密码、密钥、VM 私密配置写进源码、命令或日志。**

> **状态更新（2026-11-19）**：本文件为暂停交接时的快照。此后修正指令已裁决并实施：P0-A 已提交（`cb6476a`），P0-B（native-pty 通道、sudo 密码客户端 PTY 注入、apt 提示分流）已实施并通过串行全量回归与构建；实施记录见 [NATIVE_SSH_DIRECTIVE_REVIEW.md](NATIVE_SSH_DIRECTIVE_REVIEW.md) 第七、八节，下文"尚未完成"条目以各期实施记录为准。

> **状态更新（2026-11-20）**：P1a／P1b（`84d4bd8`／`4410002`，su native-pty 派发与 SFTP／纯 shell 文件事务）、P2（`c0cdb84`，原生后台作业模块）与 P3（本提交）已完成。远端 Python 基础设施（process.py 放置、内联驱动、su-session、文件程序）全部删除，sessionId 提权会话派发原生化，sudo 会话凭据仅存 worker 内存并经专用 stdin 注入；前台路由收编旧驱动前台域，残余不合格形式派发前 fail-closed。实施记录见 DIRECTIVE_REVIEW 第九节。下文快照条目除 H03 真机验收外均已由各期记录覆盖；H03 三链真机验收仍待隔离 VM。

## 已落地（未提交）

- Agent 普通、非特权、单步、可解析的前台命令：`task-operation-preflight.ts` 选择 `native-exec`；SafetyGate 重分析验证；通道写入 `operationFingerprint` 与 `OperationView`；`TerminalManager` 经 `SshCommandTerminal` 使用 `SshTransport.runNativeExec`，固定 `/usr/bin/env -i`、`/bin/sh` 和受控 PATH/cwd。启动前以固定只读 SSH 命令检查工具，不再为这类命令放置 `process.py`。输出有上限；channel 关闭、信号、撤权或未观察到退出码维持 unknown，不自动重放。
- `packages/core/src/native-command-route.ts` 限制了可走原生通道的语法和身份；sudo/su、包装器、脚本解释器、不透明组合命令、后台及特权请求不在此范围。其他路径**仍使用旧 Python 驱动**，不要声称已全局移除依赖。
- SQLite 版本 15 增加 `host_capabilities`：连接后观察到的非秘密事实，经主机已信任指纹／登录身份校验写入，历史记录缺失视为 unknown；归档只供离线诊断，绝非授权。当前执行前仍做在线工具检查，没有把过期归档当成执行权限。
- 已观察到当前 SSH 连接的环境事实若明确缺少 PATH 上的 `python3`，显式 `python3`、旧后台、现有严格文件事务会在派发前返回 `capability-blocked / effects:none`；无新鲜证据不能据此推断缺失。SFTP **允许使用**，用户未要求禁用；它本身不足以证明现有事务的 ACL/xattr、备份和恢复等价性。
- 以前的 Shell 环境探测引号修复及两份旧进度文档的未提交修改仍在工作树，勿覆盖。原有未跟踪 `.playwright-mcp/` 不是本次新代码，勿纳入提交或清理。

## 尚未完成／不可宣称

1. 无 Python 主机上的密码 sudo/su 私密认证尚无等价替代；现有私密窗口密码**不会进入模型上下文**，但远端接收方目前是 Python 驱动。不得把密码写进普通 Shell stdin、命令行、审计正文或日志，也不得通过人工终端绕过 SafetyGate。用户未授权改变认证安全边界；继续设计时先阐明具体接收方与威胁模型。
2. `packages/adapters/src/file-transaction-runner.ts`、`remote-file-program.ts` 依赖远端 Python。需维持文件正文/身份/元数据比较、ACL/xattr 失败关闭、备份收据、原子提交、读回、断线与未知写锁；不能用 SFTP 单纯覆盖或 heredoc/rename 冒充事务。SFTP 可以继续用。
3. 后台作业的启动收据、重连观察和精确停止未迁移；仅凭 SSH channel 关闭或 PID/PGID/cmdline 校验不构成无竞态退出证明。`su-session.ts` 及其程序、`ssh-transport.ts` 的 Python 前置检查与 SFTP 放置仍在。最终切换时须统一移除并测试，不保留安全性不明的自动回退。
4. 执行通道目前绑定到操作指纹，但尚未把观察到的工具路径/能力档案版本一并绑定审批；能力归档也尚无 UI 投影。原生命令只固定探测 `/usr/bin/env` 与 `/bin/sh`，其他 POSIX 布局可保守阻断。Bootstrap 已按裁决 B15 降级为纯指导形态（不向服务器安装任何东西）；能力过期的跨重连演练、各平台兼容仍待做。
5. **H03 仍进行中**：此前隔离 VM 上的真实 Agent `id -u` 走旧 Python 通道，因缺 Python 退出 127；新原生路径尚未在该 VM 真机复验。诊断、配置→校验→服务健康、后台启动→观察→精确停止三条真实链均无最终通过证据；不得按本地替身结果结项。未发起新的付费模型调用或远端变更。

## 验证与停止状态

- 原生派发接线阶段：串行全量 **323 测试文件通过、7 跳过；2834 项通过、27 跳过**，类型、lint/依赖/行数/布局及 Electron 构建通过。此后又新增 `env` 工具观察和无 Python 时的计划期阻断；对应局部测试、类型及行数检查通过，但**更新后的串行全量回归尚未完成**。
- 最新一次完整回归 `b84419315` 已依用户要求主动停止；它的部分输出不可当作全量通过证据。更早迁移回归 `b98aa9b96` 退出 0，发生于上述后续小改动之前。
- 未执行 VM 真机和付费模型验收；没有提交、推送或重置工作树。继续前先运行 `git status --short`，区分既有未提交修改与本次新增文件。

## H03 真机验收中断交接（2026-11-20，UI 重构期间冻结，完毕后接续）

用户已提供隔离 VM 并授权真机验收；链 1 通过后转入 UI 重构，验收在链 2 中断点冻结。接续人从本节起步，不需要回溯聊天记录。

### 环境

- 隔离 VM：无 python3 的最小 Linux，SSH 用户 `tian`（**不在 sudo 组、无 sudo 权限——VM 既定设计**，2026-11-20 用户确认），主机已录入应用、指纹经用户独立核对（应用内 hostId `a7f1eda4-3855-4152-bd08-06148d74575f`）。凭据只在应用私密输入内，不在任何文档/源码/聊天。提权不改 VM sudoers，走应用内建 su 回退路由（root 密码经逐操作受控密码窗口注入，不建会话不留持久凭据）。
- 模型：deepseek-flash（已配置可用）；任务走 `run_remote` 等远端工具。
- 桌面开发态启动：仓库根 `pnpm dev`（后台启动可用 `pnpm dev *> <临时日志>`）。
- 诊断日志：`%APPDATA%\@cloudhelm\desktop\logs\dev\runtime.jsonl`（JSON 每行一条，`operation.proposed`/`operation`/`review.result`/`authentication.open|close`；命令正文不进日志——防泄露设计）。会话转录：`%APPDATA%\@cloudhelm\desktop\pi-sessions\<taskId>\<时间戳>.jsonl`（含工具调用的 `command` 字段，可用于核对实际派发命令）。

### 已完成与证据

1. **`f1bdeec`**：`QUERY_COMMANDS` 白名单纳入 `du`（packages/core/src/command-query-impact.ts:10），只读磁盘查询免人工批准、失败 effects=none 不触发 unresolved-prior-operation 写锁；正反例测试在同文件测试已补。core 28 文件/381 项通过，全套静态门禁+build 通过。
2. **链 1（前台诊断）真机通过**：无 Python 主机上任务「检查这台服务器的系统概况…」5 条命令 `uname -r`/`df -hT`/`free -h`/`ss -tuln`/`ss -tulnp` 全部零放置 native-exec、`low-risk-command` 直过、exit 0、任务 26.3 秒结算 answered。日志时间窗 2026-11-19T18:30:31Z–18:30:55Z（UTC）。
3. 同轮真机复核了此前分析：`du -shx /var /usr 2>/dev/null` 因模型自带重定向失去白名单资格→人工批准→permission denied 失败→effects possible→verify 暂停→用户 resume 后正常回答。机制按设计工作，但提示 `2>/dev/null` 类噪声会持续制造批准摩擦（可后续在模型提示词或分类器层面考虑，未立项）。

### 中断点：链 2（配置→校验→服务健康）卡在 VM sudo 认证

- 任务文本（已用）：「在这台服务器上部署一个最小演示服务：创建 /etc/systemd/system/demo-h03.service（运行 /bin/sleep 600），校验配置后启动它，并确认服务处于 active (running) 状态」。
- 实际进展：`prepare_remote_edit` 对不存在的目标文件正确 `not-dispatched`；staging 文件 `/home/tian/demo-h03.service.staging` 经 `structured-file` 规则写入成功、读回哈希一致；`sudo install -m 0644 -o root -g root <staging> /etc/systemd/system/demo-h03.service` 的 sudo 认证 3 次拒绝（`authenticationAttempts=3`、`authentication-rejected`，VM 输出 "sudo: 3 incorrect password attempts"）→ 任务正确 paused，Agent 未重试未绕过。目标文件未创建，无系统目录写入。
- **诊断更正（2026-11-20，用户确认）**：3 次拒绝的根因不是密码问题——`tian` 不在 sudo 组、本 VM 无 sudo 权限属既定设计，sudo 路线在本 VM 不可用；此前「疑账户密码未设置」假设及 `passwd tian`/`sudo -k && sudo -v` 控制台复验步骤作废。接续改走应用内建 su 回退路由：`OperationPrivilege`（apps/desktop/src/worker/operation-privilege.ts）在 sudo 失败且业务未启动（`canOfferSuFallback`：sudo-unavailable/authorization-denied）时弹「确认提权方式」，用户选「通过 su 切换 root」后逐条以 `su -l -s /bin/sh root -c '<已审命令>'` 派发（无会话、无持久凭据、每操作独立审核），`Password:` 提示与 `su: Authentication failure` 特征见 packages/adapters/src/native-ssh-pty.ts:32。
- 接续动作序列已明确（`systemd-analyze verify` → `daemon-reload` → `start demo-h03.service` → 确认 active）。su 路线下预期时序：Agent 以 `run_remote privilege=root` 提交字面命令（不带 sudo/su 前缀）→ 首次 sudo 尝试 `authorization-denied` 且业务未启动 → 「确认提权方式」对话框选「通过 su 切换 root」→ SG-1 审核卡逐条出现（install 写 /etc/systemd/system 与 systemctl 可用性动词均 high-impact）→ `Password:` 私密窗口输 **root 密码**（非 tian 密码）。注意 `/bin/sleep 600` 到期后服务转 inactive 是单元语义，不是部署失败。若 Agent 仍提交 sudo 前缀命令文本（旧链 2 行为），该命令会走不确定/高影响审核且 sudo 必然失败——拒绝审核卡并在对话中要求其改用 `privilege=root` 字面命令重提。

### 发现的安全缺口（SG-1，已修复）

**SG-1：ordinary-command 规则自动放行 root 写系统目录与服务管理命令。** 真机证据：上述 `sudo install … /etc/systemd/system/demo-h03.service` 被自动放行（`proposed`→`review.result allow` 仅 5ms，零人工审核，任意审查模式；日志 2026-11-19T18:35:49.396Z–.403Z，操作 ID `25cd681f-c737-4c84-8d9d-e72c430f8997`）。三层根因：

1. `securityConfiguration`（packages/core/src/safety.ts:213）只覆盖 `/etc/ssh/`、`sudoers(.d)`、`/etc/sysctl.d/`、`/etc/iptables/`、`/root/.ssh/`、`authorized_keys`——不含 `/etc/systemd/system/`（systemd 单元是服务持久化载体）与 `/usr/lib/systemd/system/`。
2. `install`、`systemctl`、`docker` 等在 `ORDINARY_COMMANDS`（safety.ts:15）；sudo 包装后 `ordinaryCommand()`（safety.ts:247）无条件放行（safety.ts:405），不区分审查模式。推论：`sudo systemctl stop sshd`、`sudo systemctl disable --now <unit>` 等影响主机/连接可用性的操作同样免审（`systemctl` 不在 `HIGH_IMPACT_COMMANDS` safety.ts:19）。
3. 风险排序倒置：同轮只读 `du` 变体需人工批准，root 写系统目录免审。

**已修复（2026-11-20）**：`securityConfiguration` 纳入 `/etc/systemd/system/` 与 `/^(?:usr\/)?lib\/systemd\/system\//`；新增 `SERVICE_AVAILABILITY_ACTIONS` 动词集，`systemctl`/`service` 的可用性变更动作（start/stop/restart/enable/disable/mask 等）经 `!isQuery` 守卫（保护后端 `systemctl show` 探针语法）转入 high-impact；`sudo` 移出 `ordinaryCommand()` 包装白名单——sudo 包装的普通命令不再免审，落 uncertain-command 走 ask/evaluate。正反例测试补入 `Tests/core/safety-risk-matrix.test.ts`（真实 SG-1 命令、服务动词、sudo 包装边界、后端探针回归）与 `Tests/core/safety.test.ts`（systemd 单元文件写入 tier、探针守卫）；bash-analyzer 与 service-tool 测试期望按新审批路径同步（服务重启经 SafetyGate 需人工批准，`ruleId: high-impact-command`）。修复改变链 2 审批路径（`sudo install` 应转为人工审核），属预期。

### 接续清单（按序）

1. ~~修 SG-1（含测试与门禁），中文提交。~~ 已完成（2026-11-20）：systemd 单元目录写入与服务可用性动词转入 high-impact，sudo 移出 ordinary 包装白名单；正反例测试与门禁全绿。
2. VM 控制台确认/设置 root 密码（root 登录执行 `passwd root`；并以 `tian` 在控制台先做一次 `su - root` 验证 su 可用且 root 密码正确）后，重发链 2 任务文本，经 su 回退路由验收配置→校验→服务健康全链（预期：sudo 尝试被拒且业务未启动后弹「确认提权方式」→「通过 su 切换 root」；SG-1 审核卡逐条出现；`Password:` 窗口输 root 密码）。
3. 链 3（后台启动→观察→精确停止）任务文本参考：「在后台启动一个 sleep 300 的任务，观察它正在运行，然后精确停止它」（走 P2 原生后台模块 setsid 路径）。
4. su/sudo 提示特征表 VM 实测定稿（P0-B 遗留项）：链 2 su 路线即为 su 行实测（`Password:` 提示、`su: Authentication failure` 失败特征、发行版 su 实现归属 shadow-utils/PAM 还是 BusyBox），跑完即回填定稿。
5. 三链全过后：更新 REPAIR_PROGRESS.md（H03 行与最新记录）、STATUS.md、本文件状态头，H03 结项；中文提交，不自动推送。

### 边界提醒

- SG-1 已修复：ordinary-command 不再免审 root 写系统目录与服务可用性变更；本 VM 之外主机接入前仍建议先跑完链 2/链 3 验收。
- 密码/指纹/私密配置不写入任何文档、源码、命令或日志；本节 hostId 为应用内非秘密标识。
- 本节不改变迁移契约四不变量；H03 保持“进行中”，不因链 1 通过而提前结项。


