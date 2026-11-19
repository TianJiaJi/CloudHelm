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

## 下一位建议顺序

1. 先复核工作树 diff、安全门/原生通道/能力归档边界；对当前代码跑局部测试、串行全量、类型、静态门禁与构建，修复任何实际回归。重点测试 `Tests/application/native-ssh-gate.test.ts`、`Tests/adapters/native-*.test.ts`、`Tests/desktop/worker/task-operation-preflight.test.ts`、`Tests/desktop/main/host-capability-record.test.ts`、SQLite 升级与回滚。
2. 在私密认证边界获明确设计决定前，不要删 Python sudo；保留 `capability-blocked`。优先实现可证明等价的文件事务能力探测与后台协议；受限主机不满足条件时失败关闭。
3. 有合规私密输入入口、用户允许的隔离 VM 和明确授权后，先验收无 Python 的真实只读原生命令，再按文件/服务及后台能力逐段验收 H03；未知结果先核验不重放。最后更新旧进度账并按用户要求做中文本地提交，不自动推送。
