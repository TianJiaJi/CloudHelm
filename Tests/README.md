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
pnpm test:desktop:packaged
```

浏览器需要已安装的 Playwright Chromium，或通过 `CLOUDHELM_SMOKE_BROWSER_CHANNEL` 指定本机 Chrome／Edge。桌面测试先完成 `pnpm build`；打包后测试还需目录包。详见[开发指南](../docs/DEVELOPMENT.md)。

## 证据边界

- 默认测试使用假模型、假认证与临时本地服务，不连接用户主机。真实 SSH 集成必须显式 opt-in，且仅使用独立 loopback 测试服务。
- Windows 上不适用的 POSIX／PTY 测试和未提供本地 SSH 测试环境的用例会跳过；跳过不计为已验证。
- UI fixture、模拟输出或进程退出 0 不证明真实业务目标正确；验收维度与证据要求见[验证 V3](../docs/VERIFICATION_V3.md)。
- 冒烟截图与诊断只写忽略的 `.cache/` 或独立临时用户目录，不提交用户数据库、私钥、真实凭据或终端日志。
- 本机、跨平台 CI、打包和真实服务器的结果分别记录，最新证据见[验收状态](../docs/STATUS.md)。
