# G1-H 子批报告：PTY 与会话路线的单次启动许可

> 对应交接文档 §3.2“其余执行路线启动许可”的 PTY/会话部分。原则不变：每条执行路线只在自己的真实交接点消费启动许可，`canEnterExecutor`/`isAuthorized` 不充当“已发送/未发送”的证明。

## 交付内容

- `packages/adapters/src/native-ssh-pty.ts`：`openNativeSshPty` 新增 `claimStart` 钩子，`LiveNativePtySession` 在构造器内 `client.exec` 之前单次消费；claim 返回 false 或抛异常一律按 `not-dispatched` 关闭，不派发任何字节。调用方未提供钩子时行为不变（人工通道不受影响）。
- `packages/adapters/src/ssh-transport.ts`：`runNativePty` 镜像 `runNativeExec` 的绑定模式，向 PTY 原语传入 `{hostId, command: 派发文本, cwd}` 的预绑定 claim。
- `packages/adapters/src/ssh-command-terminal.ts`：`executeNativePty` 接收 gate 的 `claimStart`，先校验传输层绑定（重建的 `sudo -k -p`/`su` 派发文本、sudo 用被审目录而 su 用 `/`），一致后重绑**被审** command 与 cwd 再咨询 gate。
- `packages/adapters/src/native-session-terminal.ts`：`execute` 接受 `CommandExecutionOptions`；会话派发文本（`sudo -k -S` 重建）绑定校验通过后同样重绑被审值。
- `packages/application/src/safety-gate.ts`：铸造条件从 `native-exec` 扩展为 `command 且非 processControl 且（native-exec 或 native-pty 或会话）`；post-fill 同步覆盖这三条路线——claim 消费即 `handed-off`，exec 通道 exit 0 佐证 `started`，未消费为 `not-sent`/`not-started`。
- `apps/desktop/src/worker/privileged-runtime.ts`：`DeferredTerminal.execute` 的 options 类型放宽为 `CommandExecutionOptions`，claim 经 FileOperationExecutor→TerminalManager 原样透传到会话终端。

## 关键设计决定

- **派发文本不等于被审命令**：PTY 的 sudo 标记重建、会话的 `sudo -k -S` 重建、su 派发目录固定 `/`，都与审核时的 command/cwd 不同。传输层绑定只用于一致性校验；真正消费许可时必须重绑被审值，否则 gate 的目标校验会错误拒绝或将许可绑定到重建文本上。
- **单一消费点**：PTY 在 `client.exec` 前、会话在 `runNativeExec` 的 exec 前消费；凭证未确认、`CommandNotStartedError`、渲染失败等更早退出路径均不消费，gate post-fill 仍给出 `not-sent`/`not-started`。
- **单次性**：claim 闭包一次调用后即失效；执行器链完成后任何迟到调用（包括回拨时钟）都返回 false，与 G1-F 的 exec 路线一致。

## 验证

- 新契约文件 `Tests/adapters/native-pty-session-start-claim.test.ts`（14 项）：PTY 原语 fail-closed 与免钩子派发、终端重绑与绑定不匹配拒绝、生产传输绑定、会话重绑/不匹配/根登录逐字派发、gate 铸造与填充（PTY/会话/进程控制/未消费）、全链路审批过期与正常退出保持。
- 局部回归：adapters 批 116+2 环境跳过、application 批 95、worker 会话批 58，合计 269 通过、2 跳过、0 失败；`pnpm typecheck` 与四项 lint 全部通过。

## 未完成与风险

- 后台 `setsid` launch 交接点（下一子批）与 SFTP 写交接点的单次许可尚未接入。
- 三模式裁决契约（§3.3）未开始；本批只覆盖启动许可，不改裁决。
- 全量串行回归与 `pnpm build` 留待 G1 收尾统一执行；真实主机验收未开展。
