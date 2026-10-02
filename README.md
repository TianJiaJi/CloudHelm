# CloudHelm

CloudHelm 是面向个人开发者与运维人员的桌面 SSH 客户端。点击主机即打开普通 SSH 终端，右侧 AI 助手随时可用：直接用自然语言描述目标，后台自动建立执行记录，界面不需要创建“任务”。当前新对话只授权发起时的一台主机，切换终端不会改变原对话的操作范围。未选择主机时可进行纯聊天。

Agent 通过 Pi SDK 在独立真实 SSH PTY 中调查、执行、修复和验证；用户能查看命令与真实输出，并随时输入接管。普通终端和 AI 终端互不抢占；普通终端内容只有主动引用后才会进入模型。完成后展示验证证据、访问方式、变更和恢复说明，交由用户验收。

项目使用 **AGPL-3.0-only** 许可证。当前处于首版开发阶段；[已实现范围与待完成项](docs/STATUS.md)随代码更新。

## 开发

要求 Node.js 24、pnpm 11.9.0。

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm dev
pnpm --filter @cloudhelm/desktop package
```

主进程负责窗口、SQLite 和操作系统凭据保护；独立 utility process 运行 SSH 与 Agent。模型设置提供双列 Pi 供应商目录，API Key 与 Base URL 分别配置，地址已有可修改的预置值。全局默认只影响新对话；现有对话在输入框切换模型，下一次请求生效。模型订阅页目前标为未开放。

第二档审核优先使用已配置的 Jev/Vercel Gateway Key；未配置时由当前普通模型发起独立审核。Jev 已配置但服务出错时等待人工，不静默切换计费来源。

AI 回复在聊天和历史页按 Markdown 排版，支持表格、引用和代码块复制；复制不会执行代码。图片需要主动打开，链接交给系统浏览器。缺少模型 Key、连接失败等问题以友好弹窗说明原因和下一步，技术详情默认收起并移除未识别的原始返回内容。

## 验证与截图

```sh
# 类型、单元/集成测试、依赖方向、代码规范与文件行数
pnpm check

# 安装测试浏览器并运行可复现的 renderer 交互测试
pnpm exec playwright install chromium
pnpm test:ui
pnpm test:markdown

# 先构建目录包（包含 Electron native dependency 重建），再测启动
pnpm --filter @cloudhelm/desktop package
pnpm test:desktop
pnpm test:desktop:packaged
```

`test:ui` 启动仓库内 Vite 测试页，使用假 SSH、假模型、文档专用地址和假密码；覆盖点击连接、对话范围、后台 AI 终端不抢焦点、模型切换、草稿保留、审批、密码提交、接管、关闭终端及设置页未保存保护。它不连接服务器、不发送模型请求，也不能证明后端命令审核或真实远端操作正确。截图写入 `.cache/ui-smoke/`。本机如需使用已安装的 Chrome，可设置 `CLOUDHELM_SMOKE_BROWSER_CHANNEL=chrome`。

`test:markdown` 验证助手回复的 Markdown/GFM 排版、代码复制、链接协议限制和图片隐私。代码块只能复制，不会执行；原始 HTML 不渲染，图片不会自动请求，需点击图片链接打开。只有无内嵌用户名或密码的 HTTP(S) 链接可点击。深浅主题截图写入 `.cache/markdown-smoke/`。

`test:desktop` 使用真实 Electron 与独立临时 userData，验证窗口、preload IPC、renderer 隔离、数据库文件、safeStorage 加解密，以及 Electron utility process 内的 SQLite 和 Bash WASM 解析。`test:desktop:packaged` 针对目录包复验相同能力，从包自身解析原生依赖和资源；不读取用户现有配置或保存测试凭据。截图写入 `.cache/desktop-smoke/`。它不验证 SSH Agent、真实服务器认证、真实模型、多轮部署或 OAuth；这些需要独立端到端验收。操作系统凭据加密不可用时测试明确失败。

真实 SSH 集成测试需显式提供临时本地服务。设置 `CLOUDHELM_TEST_SSH_KEY` 为该测试服务的私钥路径，可选 `CLOUDHELM_TEST_SSH_PORT`（默认 22388）与 `CLOUDHELM_TEST_SSH_USER` 后运行 `pnpm test`。测试仅连接 `127.0.0.1`，并使用临时目录；包括本地模型协议 fixture 经真实 Pi SDK 的多轮执行与模型切换。不要把这些变量指向生产跳板连接。

## GitHub 自动多平台构建

推送提交或创建 Pull Request 会自动运行 **CI**。也可以进入仓库的 **Actions → CI → Run workflow**，选择分支后手动构建；首次使用手动入口时，工作流文件需已存在于仓库默认分支。同一分支或 PR 的新运行会取消尚未完成的旧运行，三个平台独立构建，一个失败不会取消另外两个。

| 平台 | GitHub runner | 下载产物 |
| --- | --- | --- |
| macOS Apple Silicon | `macos-15`（arm64） | `CloudHelm-macos-arm64`，内含 DMG |
| macOS Intel | `macos-15-intel`（x64） | `CloudHelm-macos-x64`，内含 DMG |
| Windows x64 | `windows-2022` | `CloudHelm-windows-x64`，内含 NSIS 安装 EXE |

打开完成的 CI 运行页面，在 **Artifacts** 中下载对应平台的压缩包并解压；产物保留 7 天。`smoke-平台名` 另存界面与启动检查截图，失败时也尽量上传，便于定位问题。每个平台先运行 `pnpm check` 和 renderer smoke，再重建 Electron 原生依赖、执行构建后/打包后 SQLite、WASM、凭据与 IPC 启动检查，全部成功后生成安装包。

构建固定使用 Node.js 24、pnpm 11.9.0 和 Python 3.12；pnpm 按锁文件安装，并使用仓库 `pnpm-workspace.yaml` 的原生构建许可。Windows runner 自带 Visual Studio 2022 C++/Windows SDK，工作流先核验工具可用性；macOS 使用 runner 自带 Xcode/Clang。架构还会在 Node 和 Electron 启动检查中再次核验。

工作流只需仓库只读权限，不使用模型 Key、SSH 凭据或发布 Token，也不会自动发布 GitHub Release。产物目前未签名、未公证；正式分发的签名与公证仍需发布环境配置。远程平台是否通过以实际 CI 运行记录为准，不能以本机构建代替。runner 标签依据 [GitHub 官方镜像清单](https://github.com/actions/runner-images#available-images)配置。

## 审核与认证

所有 Agent 命令按“硬禁令 → 完整低风险白名单 → 当前审核档位 → 执行前再次核验”处理。第一档人工批准非白名单操作；第二档由 Jev 或普通模型独立审核；第三档自动执行未命中硬禁令的操作。第三档对不透明脚本只提供尽力识别，不构成远端沙箱。人工接管后的手动输入不属于 Agent 命令审核。

SSH keyboard-interactive 回答直接进入 SSH 认证协议。受支持的 `sudo`、`apt`、`apt-get` 与有界 `su -c` 使用操作专属的短生命周期输入管道；密码不会进入共享 PTY、模型消息或审计记录。来源不明确的提示、持久交互 Shell 或未知认证流程需要用户接管。暂停 AI、停止远端命令、接管终端和断开 SSH 分开处理；断线或执行结果不明时先核验，不直接重放。

Agent 的文件写入、删除和本地上传也经过统一审核。覆盖或删除已有常规文件时保存恢复副本；本地读取限于用户通过系统选择器授权的文件或目录。结构化文件操作当前上限为 1 MiB，SFTP 浏览页只读。

## 仓库

依赖方向、进程边界和安全不变量见[架构说明](docs/ARCHITECTURE.md)。源码规则写在 [AGENTS.md](AGENTS.md)；保持单一职责、禁止循环和反向依赖，手写文件原则上不超过 800 行。
