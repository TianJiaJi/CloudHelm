# SSH 连接编辑器实现与验收记录

用户确认的配置与界面范围已实现，并通过下面记录的自动回归及 Windows 原生开发构建验收；不代表真实生产主机、X Server 或全部桌面平台均已验收。

## 确认范围

- 参考用户提供的连接编辑器截图，采用左侧分区导航、右侧配置卡、固定底部测试／取消／保存操作。
- 完整配置能力；**不提供 SSH Agent，不实现多级跳板**。已有单级跳板保留。
- 基本信息：名称、分组、地址／端口、用户名、主机备注。
- 认证：密码、私钥、所配置认证方法的顺序；密码与私钥口令独立管理，不能混用。
- 连接：超时、SSH 协议心跳间隔与失联阈值。
- 代理：HTTP CONNECT／SOCKS，启用／禁用，独立代理认证；代理启用时明确说明与单级跳板的优先关系。
- 终端：显示编码与输入编码双向一致、TERM。
- 文件浏览：列表自动刷新开关、工作目录跟随开关。
- X11：真实转发、本地显示地址和 Cookie 模式，不做只有开关的占位功能。
- 算法：主机密钥、Cipher、KEX；默认使用 SSH 库安全默认值，显式配置错误不能静默降级。
- 初始化：默认目录、初始化命令、保活命令及周期、会话环境变量。

## 安全与兼容

1. 公共配置与私密凭据分离。密码、私钥口令、代理密码、X11 Cookie 不进入主机快照、模型提示词、操作日志或普通 Shell 输入。
2. 旧 Agent 配置不得静默转换后继续使用；编辑时要求选择支持的认证方法及相应凭据。已有密码／私钥凭据只在身份与凭据用途仍匹配时复用。
3. 连接配置改变应使新连接使用新参数，不能把现有连接误标成已采用新配置；身份、跳板、代理和算法变化属于连接变化。
4. 代理失败直接报错，不自动直连，不跳过 SSH 主机指纹验证。代理输入必须有长度、协议、地址和端口验证，不能把 URL 中的密码当公共字段保存。
5. X11 仅供人工终端显式启用，限制转发到指定本机 X 服务；认证 Cookie 留在传输层。Cookie 获取／校验失败不能自动改成无认证。
6. 初始化及自定义保活命令只能用于用户明确确认的人工会话；不能因 AI 打开终端或连接主机而执行。后台绑定命令、接收方及连接代次，并在执行前复核。
7. 自定义保活命令不得向未知前台程序的 stdin 定时写入；应使用独立、有限时、可取消的执行通道，并在会话关闭后停止。它和 SSH 协议心跳不是同一功能。
8. 环境变量不是凭据存储入口，不向 AI 专用执行环境注入用户初始化脚本、秘密或可绕过执行隔离的配置。
9. 禁用目录跟随只影响人工文件面板，不得关闭后端对真实 cwd 的跟踪或影响 SafetyGate 的批准绑定。
10. 改数据库结构或自动转换持久化数据时使用版本化迁移；可兼容的新增可选配置采用明确默认值，不能读取或改写个人数据库来测试迁移。
11. 新依赖必须固定版本并验证。编码必须实际双向生效，不能仅改变下拉框或只解码不编码。

## 已定位的数据流

- 表单：`apps/desktop/src/renderer/host-editor.tsx`、`host-editor-fields.tsx`、`host-editor.module.css`；`host-dialogs.tsx` 保留兼容导出。
- 公共协议／类型：`packages/contracts/src/index.ts` 的 HostDraftSchema、HostView；`runtime.ts` 的 RuntimeHost。
- IPC：`apps/desktop/src/main/index.ts` 的 add/edit/test/connect/open-terminal。
- 持久化／凭据：`apps/desktop/src/main/host-settings.ts` 管理白名单、接收方绑定和原子保存；`app-state.ts` 装配读取和公开 API。
- 连接测试绑定：`apps/desktop/src/main/host-connection-test.ts`；当前严格复制公共字段，新增配置需要明确纳入绑定。
- Worker：`apps/desktop/src/worker/server.ts` 的 connect、requestLoginInput、openTerminal、list-remote。
- 传输：`packages/adapters/src/ssh-transport.ts`；按需认证：`ssh-authentication.ts`。
- 人工会话授权：`manual-session-authorization.ts`；启动／保活：`manual-session.ts`；编码：`terminal-codec.ts`；X11：`x11-cookie.ts`、`x11-forwarding.ts`。
- 文件页：`workspace-pages.tsx`；cwd 由人工终端经 TerminalManager 和 IPC 投影，不改 Agent 批准绑定。
- 固定 `iconv-lite@0.7.0`，附仓库补丁修正分片解码丢失低代理项，见 [补丁说明](../patches/README.md)。配置版本 1 为可选 JSON 字段，不改变 SQL 表结构。

## 分模块落地与验证

1. 配置 schema／默认值／校验、凭据协议与保存／测试绑定。
2. 连接选项、认证顺序与 Agent 兼容处理。
3. 代理通道（自建 loopback HTTP/SOCKS fixture），禁止失败降级。
4. 人工终端编码／TERM／目录／环境及显式确认的初始化和保活。
5. X11 会话及 Cookie 校验（合成本地 X 服务，不访问个人 Xauthority）。
6. 文件面板设置、主机分组与新编辑器交互。
7. 完整回归、源码边界与构建、浏览器及真实 Electron 验收。无效配置不能保存，配置必须能影响对应的真实后端路径。

## 本轮证据

- `bd83323a4`：类型检查通过；专项 130 项通过、2 项失败。失败为 GB18030 分片解码及合成 X11 夹具，后续检查未运行，不能标作整链通过。
- `b62a72823`：固定依赖补丁安装成功，14 项编码测试通过；真实 SSH 的 X11 夹具在本地数据阶段失败。已定位为 ssh2 运行时 Cookie 为 ASCII Buffer、类型声明却是 string，夹具错误地当作原始 Cookie 字节发送；修正后加强协商值断言，复验结果另记。
- `baf68aa50`：类型检查、21 项连接／私密输入／启动生命周期测试、Edge UI smoke 通过。新编辑器八分区、独立凭据 patch、清除语义、配置回填及小窗口固定底部均覆盖。浏览器使用 fake SSH/models。
- `b148d5a52`：类型检查、16 文件／152 项专项测试全部通过，包括真实 SSH X11 转发、Cookie 读取撤销和清理；随后 ESLint 报代理回调的表达式语句错误，后续门禁未执行，该处已改为明确 if/else。
- `b7775707b`：类型检查、14 项 HTTP(S)／SOCKS5／SSH 代理测试通过。HTTPS 使用内存生成的合成证书，检查可信证书成功、未知证书与错误身份失败且不直连；未关闭 TLS 校验。
- `b1a890c3a`：默认并行度下完整发现集合 1852 项通过、3 项 Windows 进程清理测试超时、25 项既有环境跳过；构建和原生验收未执行。该失败保留，不能标作通过。后续按此前验收的双 worker 重跑完整集合，不增加超时、放宽断言或新增排除；并行资源压力是待比较因素，不将其直接当作已证明根因。
- `b5b9bd55c`：类型检查、23 项代理／主进程取消／Worker 私密输入测试，以及 ESLint、依赖边界（529 模块／2086 依赖）、行数和测试布局均通过。覆盖等待跳板期间的目标取消及新旧连接意图隔离。
- **`bc134c3f8` 完整链退出 0**：双 worker 完整发现集合 **187 文件／1860 项通过，7 文件／25 项环境跳过**（22 项 POSIX／PTY，3 项 opt-in SSH）。全部 TypeScript、ESLint、依赖边界（529 模块／2086 依赖）、800 行、测试布局、版本／更新日志门禁及三入口构建通过；Edge UI／Markdown／AI-panel smoke 与真实 Windows x64 Electron 44.5.1 开发构建冒烟通过；`git diff --check` 通过。
- 原生结果确认 preload 隔离、utility process、SQLite 3.53.4 往返、Bash WASM 和临时 safeStorage 凭据往返。测试使用隔离数据／合成 loopback 服务，不读取个人数据库、密钥或 Xauthority，不调用真实模型。截图位于 `.cache/ui-smoke/`、`.cache/ai-panel-smoke/`、`.cache/markdown-smoke/`、`.cache/desktop-smoke/`。
- 默认并行度的进程清理超时仍保留为负面记录；双 worker 通过不证明任意负载下都没有时序问题。没有增加测试超时、放宽断言或新增排除。未构建安装器，真实 sudo/PAM/su、生产 SSH／模型、实际 X Server 和其他平台人工操作仍不在本轮证据范围。

测试不得连接用户主机、读取个人密钥或使用真实模型。loopback 协议通过不等于跨发行版、实际 X Server、PAM 或跨平台人工验收完成。
