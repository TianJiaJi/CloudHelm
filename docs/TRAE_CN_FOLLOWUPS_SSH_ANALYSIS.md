# Trae CN：智能跟进推荐与 SSH 静态分析

## 目标与证据范围

本次未修改 CloudHelm 功能。仅分析已安装产物，没有发起 SSH 连接、安装远端组件、访问真实私钥、口令或聊天数据库。

**重要版本区别**：机器同时存在 `Programs/Trae` 和 `Programs/Trae CN`。此前指定的国际版目录为 Trae 2.1.2 / VSCode 1.100.3；本次只读进程路径检查发现当前运行的是 `Trae CN/Trae CN.exe`，其 `product.json` 标识 **3.4.9 / VSCode 1.107.1**，构建日期 `2026-10-26T12:06:44.139Z`。截图功能应以 CN 版为参考，不能把此前国际版固定黑名单、旧 agent 启动形式等结论直接套用到当前 CN 版。

下文是静态代码事实和保守推断，不代表已经运行验证了推荐接口、全部远端平台或内部原生实现。

## 一、截图中的推荐是什么

功能名为「智能跟进推荐 / Smart Follow-ups」。与欢迎页的固定例句、输入框里的 Tab 补全、技能推荐不同。

### 1. 触发与展示

聊天模块 `dist/index.mjs` 的 factory **4310** 实现推荐列表，读取：

- 当前轮是否完成、是否最新一轮；
- 动态 `chatSuggest.enable`、实验功能开关和模式门控；
- 会话消息与 Agent plan item 数据；
- 当前是否属于不展示推荐的 IM 场景，或是否有优先展示的技能安装确认。

核心行为是**最新一轮回答完成后**取推荐。请求尚在加载、无有效结果或开关不满足时，不渲染推荐按钮。它不是 Markdown 正文中的固定文本，也不是对话未完成时持续展示任意候选。

### 2. 输入上下文

factory **48793 / 60798** 中有独立请求构造和默认预算：

| 项目 | 默认值/行为 |
|---|---|
| 用户历史 | 最近最多 6 条 |
| 助手历史 | 最近最多 1 条 |
| 用户历史长度预算 | 15,000 字符 |
| 助手历史长度预算 | 15,000 字符 |
| 超时 | 30,000 ms |

这些值可被动态配置覆盖，**字符数不是 token 数**。

factory 4310 对用户消息取 text query；对助手优先取最后 plan item 的工具参数 `summary`，否则拼接 `thought`。因此它不必回传整个原始工具日志或完整思考内容。

桌面适配器 `dist/8.4ad70c6d.mjs` 的 `getChatSuggest` 还会读取活动编辑器摘要（调用预算为 100,000），将活动文件正文和文件 URI/名称引用写入 `render_context.variables`。

主要字段：`user_input_history`、`last_assistant_response`、`active_file_content`、`symbol_infos`、`user_additional_actions`。不要将这种上下文收集误认为仅提交了最后一句聊天文本。

### 3. 调用链与解析

桌面端主路径：

```text
ChatSuggestList
  → 注册的 ChatSuggestPort.getChatSuggest
  → RustTransportAdapter.subscribe(chatSuggest, query)
  → 转换为 lite.super_completion_query
  → 原生 RPC 流
  → meta / output / done / error
  → 累加 choices[0].text
  → 解析并校验 JSON 推荐数组
  → 渲染按钮
```

同时存在通用 HTTP fallback 服务（factory **67595**）：

- `POST /api/ide/v1/super_completion_query`
- `function_type: "recommend"`
- `Accept: text/event-stream`
- AbortController、请求超时、pending 请求去重。

**桌面已注册适配器优先走 Rust RPC；不能把存在 HTTP fallback 等同于所有桌面请求都直接 fetch。**

返回解析支持字符串数组，或带 `query` 和可选 `mention` 的对象数组；去除不可见/空文本，最多保留 **5 条**。`mention` 可解析为文件引用信息。解析失败、超时或空结果不会硬造推荐。

客户端代码不包含这项云端服务的完整系统提示词，也无法据此确认具体服务端模型、采样参数、排序算法或计费规则。

### 4. 缓存与取消

- 内存按 session 保存 response、messagesLength、savedAt。
- 桌面端持久化 key：`ai-chat.chatQueryCompletion.v2.<sessionId>`，使用 WORKSPACE / MACHINE 存储范围。
- 缓存消息数量一致且结果有效时可复用。
- 桌面服务在新请求前取消旧请求；通用 fallback 还存在按 session + historyLen 的 pending 去重。

这解释了切换会话/重开后推荐可以复现，而不是每次都重新生成。但本次没有验证其全部跨窗口并发行为。

### 5. 用户操作

factory 4310 派发两个不同事件，`dist/914.4af436b0.mjs` 注册桌面处理器：

| 操作 | 行为 |
|---|---|
| 点击推荐行 / 发送箭头 | `solo.chat_suggest.send`，创建用户消息并调用 chatSessionService.sendMessage |
| 添加到对话 | `solo.chat_suggest.add_to_input`，填写输入框并聚焦，不发送 |

推荐项包含 text、id 和 references；有引用数量标签和 hover 预览。桌面当前上述事件处理器可确认用 text 创建 query，不能仅凭事件携带 references 就断言它们都会以结构化引用原样投递。

视觉是自适应文本宽度、单行省略、次级文字、轻背景按钮行；文字 13px / 行高 20px，左右操作区独立布局。不是每条都撑满侧栏。

## 二、SSH 是怎么工作的

### 1. 不是模型管理 SSH 登录

CN 扩展路径：`extensions/cloudide.icube-remote-ssh/`。

连接主链路：

```text
选择 SSH 主机 / 解析 ssh-remote+authority
  → Resolve pipeline
  → 本地 Node localServer
  → 系统 OpenSSH（ssh 可执行文件）
  → 远端环境/版本检查与 server 安装
  → 远端 loopback server + connection token
  → SOCKS/端口转发
  → 远端文件系统、IDE 服务与 AI RPC
```

这里的主连接不是通过 JS `ssh2` Client 建立的；`out/localServer.js` 用 `child_process.spawn` 执行选定的 SSH 程序。不要把“同样可以做 SSH”误解为必须替换 CloudHelm 当前 SSH 适配器。

### 2. SSH 参数与认证

factory **9200** 的 `buildSSHArgs` 默认构造 `-v -T -D <port>`，支持端口 `-p` 和配置文件 `-F`，非增强兼容模式还设置远端登录 bash。

- `-D` 用于动态 SOCKS 转发。
- `-T` 是这里**引导/管理连接**的参数；它不证明所有 AI 工具终端都不使用 PTY。
- AskPass（factory **6173**）通过 `SSH_ASKPASS_REQUIRE=force`、本地命名管道/Unix socket 和认证交互回调向 OpenSSH 返回凭据。
- 这些连接交互不是聊天 query，不需要让模型阅读密码。本次没有据此审计整个产品的凭据存储安全。

**不宜照搬的实现**：默认参数包含 `StrictHostKeyChecking=no` 和 `UserKnownHostsFile=/dev/null`。此外 AskPass 包装脚本存在临时结果文件传递路径。CloudHelm 应坚持主机指纹核对、凭据独立通道及自身安全约束，不能因追求操作一致而复制这些做法。

### 3. 远端安装与持久连接

factory **1708** 明确列出步骤：建立 SSH → 检查系统 → 解析包信息 → 检查 server 要求 → 远端安装 → 本地下载后安装 fallback → 配置隧道。

CN `product.json`：

- `serverApplicationName: trae-cn-server`
- `serverDataFolderName: .trae-cn-server`

环境构造 factory **337** 将远端 server 放在类似 `~/.trae-cn-server/bin/<quality>-<commit>/` 下，启动入口 `index_trae.js`。

安装脚本以远端附带 Node 启动 server，使用 loopback host、随机端口或 socket、connection-token-file、日志和 PID 文件；设 `ICUBE_RUN_IN_REMOTE=true`。本次只读脚本，没有执行。

factory **1848** 将本地端口通过现有 SSH SOCKS 转发到远端 server 的 listeningOn。CN 版本不是此前国际版“主隧道 + 固定第二条 Rust manager 隧道”的相同实现，不能混用版本结论。

### 4. 连接脚本怎么拿命令结果

factory 9200 为引导管理命令提供：

- 单连接命令队列，串行化 exec/execPartial；
- 随机完成标记和退出码解析；
- 长脚本心跳；
- 无输出超时、总超时、SOCKS 探测与恢复；
- tunnel/socket 生命周期管理。

这些是已确认的安装/管理通道机制，**不能据此断言所有 AI tool call 都直接走这个 exec 方法**。

### 5. AI 与远端怎么接起来

当前 workbench 的 `getRemoteSshClient(authority)`：

1. 连接指定 RemoteSshMount；
2. 取得该 authority 的 Aha IPC channel；
3. 创建 remote Aha RPC client 和 AI client；
4. 按 authority + channel 缓存并复用；
5. 创建期间复核 channel 未更换；
6. channel 失效时清理旧 client。缓存上限为 5。

ModularManager 同时实现 local Aha IPC 与 remote Aha RPC，根据远端环境/产品条件选择。说明同样的 AI 面板可以操作不同执行环境，不需要模型每次重新登录。

当前 CN 安装还有 `harness.dll`、`toolhost.dll`、`bin/agent-tool-host.exe` 等执行组件。前端可见 `run_command / RunCommand`、commandId、outputPath、状态查询和停止适配器。打开 AI 终端会先检查运行环境能力，再以命令 ID 和输出日志打开 toolhost 终端视图。

因此需要区分：

- SSH 引导通道负责连接、安装和转发；
- AI RPC/工具运行时负责会话与具体工具执行；
- UI 投影工具状态与输出，不是执行器本身。

尚未对 native harness/toolhost 和真实远端部署做运行时验证，不能断言每个工具的进程归属、PTY 创建、取消信号与远端退出语义。

## 三、对 CloudHelm 的建议（设计建议，不是 Trae 的已证实策略）

1. 推荐作为独立后台请求：回答完成后才生成，失败静默降级，不阻断主回答。
2. 输入只包含经过脱敏的近期用户问题、最终答复/摘要和明确授权上下文；不要默认上传完整当前文件、终端日志或认证信息。
3. 推荐返回结构化项，绑定 conversationId、最终响应 ID 和请求代次；切换会话/新问题时取消或丢弃旧结果。
4. 区分「发送」与「填入草稿」；推荐只产生普通用户消息，后续远端操作仍需 SafetyGate。
5. SSH 可借鉴连接复用、流式日志、退出码、代次绑定和失效清理，不必改成远端安装完整 IDE server。CloudHelm 的产品边界和威胁模型不同。
6. 不因本地 abort 或 UI 停止动画就声明远端进程已退出；未知结果继续核验。

## REA 与源码证据索引

为避免对 15MB+ bundle 反复完整分析，本轮对原始小 chunk 和小型打包文件做定向分析，并使用 TypeScript **只解析、不执行**地提取精确 factory/method 范围进行补充分析。提取文件带语法包装，不是完整原程序；其依赖与动态绑定仍可能未知。

缓存目录：`.cache/trae-ai-analysis/`。其中 `factories/provenance.json` 与 `workbench/provenance.json` 记录原文件 SHA-256、UTF-16 范围、字节范围和片段 SHA-256；`readable/` 是格式化阅读副本，不应当成原始偏移坐标。

| 输入/用途 | REA 完整父记录 ID |
|---|---|
| CN 原始聊天适配器 chunk 8 / 914 | `ev_02fe7e93adff757481e492cf21de9706ba7bdea38455db598134da3dbef7c06e` |
| CN 推荐精确 factory 片段 | `ev_5f312df2d90af6d136926e2ca7b8b9db6ef763e6f72642de56502624754b9281` |
| CN 原始 localServer / askpass-main | `ev_94aeed8474ba0744ecf20f50e08320d7c096c8bcd67faec9f4ca31e748e23afa` |
| CN SSH 精确 factory 片段 | `ev_1e3998b91dcadb2a65c74aa4c667716242b3c40a0cbbe5e233c0f0c52dab3997` |
| CN workbench 远端 client 精确方法片段 | `ev_89f230262e1641c66057758ca725bd546a5245d1a3b7a71e86ebb854ff64a9ae` |

原始聊天 index SHA-256：`d71c9c0e00e103152f5b188ba0a2e531bdb852a079b0a22bb3d548f9193b0682`。
CN SSH extension.js SHA-256：`9543691a6984ea6887c9662769f7112adec1836ea9054a4bf27eb3c078695cb5`。

这些是同一 REA 会话的记录，部分图谱受选定 source scope、节点数量和语义别名限额约束。静态图谱不证明网络已发送、认证成功或远端命令已执行。
