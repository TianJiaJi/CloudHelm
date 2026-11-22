# G1-I 子批报告：后台 setsid 路线的单次启动许可

> 对应交接文档 §3.2“其余执行路线启动许可”的后台部分。原则不变：启动许可只在真实派发交接点单次消费，launch 包装文本的退出不冒充业务启动证明，`/proc` 核验与观察通道不参与许可消费。

## 交付内容

- `packages/adapters/src/ssh-command-terminal.ts`：`executeNativeBackground` 接收 gate 的 `claimStart`，仅在下述 setsid launch 派发点构建消费闭包；`runBackgroundCommand` 新增可选 `claimStart` 参数并注入 `runNativeExec` hooks，只有 launch 调用传入——stat 核验、观察 watcher、interrupt 校验与 stop 均不传、不消费。
- `packages/application/src/safety-gate.ts`：铸造与 post-fill 条件从（native-exec 或 native-pty 或会话）扩展至 native-background；claim 消费即 `handed-off`，未消费为 `not-sent`/`not-started`，executor 链返回后许可一次性失效。

## 关键设计决定

- **唯一交接点是 setsid launch**：后台业务命令被后端渲染进 `setsid /bin/sh -c '<业务+EXIT_MARKER>'` 的 launch 体，launch 退出 0 只证明包装器跑完，不证明业务启动——业务启动证明仍来自 `/proc` stat 核验，终端在核验通过时自行见证 `{handed-off, started}`。因此许可只在 launch 这一次 `runNativeExec` 派发前消费。
- **派发文本不等于被审命令**：launch 文本包含 umask、setsid 包装、日志重定向与 PID 回显，与被审 command/cwd 不同。终端闭包先校验传输层绑定（hostId、launch 全文、被审目录），一致后重绑**被审** command 与 cwd 再咨询 gate；不匹配一律拒绝。
- **观察与核验通道不触碰许可**：statCheck、watcher、interrupt verify、stop 复用 `runBackgroundCommand` 但不传 claim。它们发生在 launch 之后，若参与消费会虚增“已派发”见证或让过期审批复活。
- **gate 填充语义**：对后台路线，claim 消费 ⇒ `handed-off`；executor 链完成后未消费 ⇒ `not-sent`/`not-started`。`succeeded && exitCode===0 ⇒ started` 的通用填充对后台仍保守安全（业务退出 0 ⇒ 业务运行过），launch 退出 0 本身不经此路径伪造启动见证。

## 验证

- 新契约文件 `Tests/adapters/native-background-start-claim.test.ts`（5 项）：launch 单点消费并重绑被审值、statCheck/watcher 无 claim、绑定不匹配拒绝、拒绝时零派发 fail-closed（仅一次 launch 尝试、无核验无 watcher）、gate 对 native-background 的铸造与填充（消费 ⇒ handed-off/started；未消费 ⇒ not-sent/not-started）。
- 局部回归 91 项通过、0 失败（后台 14+5、原生命令终端 15、exec claim 7、PTY/会话 claim 14、safety-gate 三套 36）；`pnpm typecheck` 与四项 lint 全部通过。

## 未完成与风险

- SFTP 写交接点的单次许可（§3.2 收尾）尚未接入。
- 三模式裁决契约（§3.3）未开始；本批只覆盖启动许可，不改裁决。
- 全量串行回归与 `pnpm build` 留待 G1 收尾统一执行；真实主机验收未开展。
