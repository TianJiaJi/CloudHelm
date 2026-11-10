# 集中测试目录

所有自动测试、测试专用 fixture、UI／Electron 探针与离线评估工具统一位于根目录 `Tests/`。业务代码仍位于 `apps/` 和 `packages/`；`scripts/` 只保留版本、发布和工程检查工具。

## 分区

| 目录 | 内容 |
| --- | --- |
| `core/` | 纯策略、授权指纹与命令效果回归 |
| `application/` | SafetyGate、输入与终端协调、写锁和特权会话 |
| `adapters/` | Bash、Pi、SSH、SQLite 及协议 fixture |
| `contracts/` | IPC／报告协议与安全序列化 |
| `desktop/main/` | 主进程、持久化、IPC 与离线报告重整 |
| `desktop/renderer/` | React 展示、状态投影和交互策略 |
| `desktop/worker/` | Agent 执行、恢复、认证、验收及模型协议 fixture |
| `scripts/` | 版本同步、更新日志、提交钩子与测试目录检查的单元测试 |
| `smoke/` | UI、Markdown、AI 面板与真实 Electron 启动探针及页面 fixture |
| `evaluation/` | 离线任务对照记录校验；不执行模型或 SSH |

测试辅助模块可与对应测试同目录，但不能由业务代码导入。产品的 `host-connection-test.ts`／`.tsx` 是面向用户的 SSH 连接测试功能，不属于自动测试，仍留在业务目录。

## 安装与运行

从仓库根目录运行。`Tests/package.json` 是私有 workspace，只声明测试所需依赖，版本复用已固定的项目版本；不进入桌面发行包。

```sh
pnpm install --frozen-lockfile
pnpm test --maxWorkers=2
pnpm exec vitest run Tests/desktop/worker/verification-user-workflow.test.ts
pnpm check
pnpm build
```

`vitest.config.ts` 只发现本目录的 `*.test.*`／`*.spec.*`。TypeScript 检查包含这里的 TypeScript 测试及页面 fixture；ESLint、依赖与 800 行检查也覆盖本目录。`pnpm lint:tests` 阻止业务或工程脚本目录新增测试文件、快照和专用 fixture；依赖检查阻止生产代码反向导入测试。

浏览器与桌面测试的命令保持不变：

```sh
pnpm test:ui
pnpm test:markdown
pnpm test:ai-panel
pnpm test:desktop
pnpm test:credentials
pnpm test:desktop:packaged
```

浏览器需要已安装的 Playwright Chromium，或通过 `CLOUDHELM_SMOKE_BROWSER_CHANNEL` 指定本机 Chrome／Edge。桌面测试先完成 `pnpm build`；打包后测试还需目录包。详见[开发指南](../docs/DEVELOPMENT.md)。

## 执行工作区与 Pi 1.5.0 回归入口

- `adapters/pi-upgrade-recovery.test.ts`、`pi-tool-validation.test.ts`：真实 0.99.1 原始历史恢复、严格参数及 Azure 兼容；旧 fixture 不用新版 SDK 重造。
- `application/conversation-terminal-pool.test.ts`、`background-host-isolation.test.ts`、`desktop/worker/task-runner-background.test.ts`：空闲复用、A 占用时 B 诊断、可信启动、未决写锁与回答后后台生命周期。
- `adapters/ssh-process-signal.test.ts`、`desktop/worker/operation-commit-client.test.ts`、`background-operations.test.ts`、`main/operation-recovery.test.ts`：专用信号、持久化确认、真实退出与离线未知，不自动重发。
- `adapters/pi-session-input-queue.test.ts`、`desktop/worker/task-runner-input-queue.test.ts`、`main/conversation-input-store.test.ts`：原生选择／回执、重复文本 ID、授权与预算、取消／恢复／持久化竞态。
- `adapters/pi-query-native.test.ts`、`pi-query-abort.test.ts`、`pi-tool-search-native.test.ts`、`desktop/worker/task-runner-query.test.ts`：官方 QuickJS 查询沙箱、原始参数、时间／并发／输出限制、嵌套审计、授权撤销和缓存；不调用真实模型或外部 MCP。
- `adapters/pi-input-projection.test.ts`、`pi-lifecycle.test.ts`、`desktop/main/agent-activity-store.test.ts`：摘要授权、原始历史保留、父子身份、原生结束、未知用量／目录估算和元数据投影。
- `desktop/renderer/execution-workspace.test.ts` 与 `smoke/check-execution-workspace.mjs`：队列两种选择及后端取消确认，独立状态、失败／未知不折叠、按操作分页、日志非重叠与隐藏暂停、后台输出／错误不抢焦点、停止请求不冒充退出。后者由 `pnpm test:ai-panel` 执行，全部为 renderer fixture，不证明真实进程已被停止。

## SSH 配置回归入口

- `contracts/host-settings.test.ts`、`desktop/main/host-settings.test.ts`：静态类型、语义校验、凭据用途与事务回滚。
- `adapters/ssh-proxy.test.ts`：实际 loopback HTTP(S)／SOCKS5 与 SSH，拒绝代理降级、错误证书及指纹；TLS 材料在内存生成，不读取个人证书／密钥。
- `adapters/terminal-codec.test.ts`：每个分片切点及逐字节输入、控制字符和有损输入拒绝；固定依赖补丁见 `patches/README.md`。
- `adapters/manual-session.test.ts`、`ssh-manual-channel.test.ts`、`desktop/worker/manual-session-authorization.test.ts`：启动引用、授权代次、非前台保活、限时、取消与不重试。
- `adapters/x11-cookie.test.ts`、`x11-forwarding.test.ts`、`x11-preparation.test.ts`：合成 Xauthority／SSH／本地 X 服务，Cookie 替换、拒绝、超时和清理。不使用个人 Xauthority，也不等于真实 X Server 验收。
- `desktop/worker/server-connection.test.ts`、`desktop/main/runtime-timeout.test.ts`：正常连接取消、过期／重复私密回答、并发与 RPC 期限。
- `smoke/check-host-editor.mjs`：八分区、配置和独立凭据 patch；`check-turn-folding.mjs`：按轮折叠、最终回答及恢复状态保护。均为 fake SSH/models。

## P0＋P1 回归入口

- `desktop/worker/operation-privilege.test.ts` 与 `task-runner-root-operation.test.ts`：后台 UID/root/sudo 路由、私密认证、审核和不重放。
- `adapters/sudo-command-authorization.test.ts`、`su-session-protocol.test.ts`：非交互查询与派发分离、查询不确定不得作为后备证据、租约失效和认证协议；对应 POSIX 集成在 Windows 跳过，含 `listpw` 与实际命令 `NOPASSWD` 不同的回归。
- `adapters/ssh-native-import.test.ts`：独立 Node ESM 进程加载认证模块，防止 Vitest 的 CommonJS 转译掩盖 Electron 原生链接错误；桌面构建后还需运行 `pnpm test:desktop`。
- `adapters/ssh-on-demand-authentication.test.ts`：临时合成密钥与 loopback SSH 协议服务，覆盖免密、协商驱动的密码／OTP、本地加密私钥、限次纠正／取消／失效；不登录 OS 账户，不启动 Shell，不读取个人私钥。
- `adapters/fetch-listener.test.ts`：HTTP/SSE fixture 在公开地址前避开 Fetch 禁用端口（系统动态范围可能包含它们）；不改变生产请求重试，绑定错误立即失败。
- `adapters/remote-program-syntax.test.ts`：只通过本地 Python AST 检查固定程序语法，不执行提权程序。
- `core/operation-outcome.test.ts`：反馈版本、执行边界、影响及后续指引。
- `desktop/worker/task-runner-verification-*.test.ts`：自然结束、旧提交工具不可用、历史缺报告不自动恢复；`desktop/renderer/result-summary.test.ts` 与 UI 冒烟覆盖折叠证据和始终可见的真实失败。

## 修复专项回归入口

- `scripts/repair-coverage.test.ts`：42父项与12UI包的完整性和状态约束；清单通过不代表产品验收通过。
- `desktop/main/credential-isolation.test.ts`：合成OS凭据与真实SQLite，验证快照不解密、损坏凭据可替换、配置/密钥/审核设置事务回滚及单次通知。
- `pnpm test:credentials`：先 `pnpm build`，再使用全新临时数据库启动真实Electron；以故意损坏的合成密文验证启动和设置可用、以注入不可用状态验证纯投影、通过真实IPC和OS加密替换合成Key。不会读取用户凭据、请求外部模型或连接用户主机；不截图、不保存trace，结束清理临时目录。
- `core/redaction-stream.test.ts` 与 `application/operation-output-capture.test.ts`：任意分块、ANSI/OSC、引号/转义、长行、Unicode、私钥与快照不泄漏；无限引用捕获迁移仍另列E04，不与脱敏状态修复混算。

- `desktop/main/conversation-deletion.test.ts`、`conversation-cleanup.test.ts`：真实SQLite故障注入、事务回滚、共享资源保留、目录清理重试和迟到事件隔离；`conversation-ipc.test.ts`、`structured-message-ipc.test.ts`覆盖恢复/发送/删除竞争与准备阶段撤权。
- `pnpm test:deletion`：先 `pnpm build`；在独立临时目录启动真实Electron，验证正常删除、拒绝跟随替换的目录链接、清理失败回执、重启恢复与无关数据保留。没有模型/SSH调用，不读取用户数据。

## 证据边界

- 默认测试使用假模型、假认证与临时本地服务，不连接用户主机。真实 OS SSH／PTY 集成必须显式 opt-in，且仅使用独立 loopback 测试服务；默认集合中的原生 SSH 协议 fixture 不证明 OS 登录、PAM 或权限切换。
- Windows 上不适用的 POSIX／PTY 测试和未提供本地 SSH 测试环境的用例会跳过；跳过不计为已验证。
- UI fixture、模拟输出或进程退出 0 不证明真实业务目标正确；验收维度与证据要求见[验证 V3](../docs/VERIFICATION_V3.md)。
- 冒烟截图与诊断只写忽略的 `.cache/` 或独立临时用户目录，不提交用户数据库、私钥、真实凭据或终端日志。
- 本机、跨平台 CI、打包和真实服务器的结果分别记录，最新证据见[验收状态](../docs/STATUS.md)。
