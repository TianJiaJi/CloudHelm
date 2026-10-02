# 架构与安全边界

```text
Renderer ──窄 preload API──> Electron main ──带 ID 的 RPC──> utility process
                              │                         │
                       SQLite / safeStorage        TaskRunner / SafetyGate
                                                        │
                                            Pi / Bash analyzer / SSH PTY
```

依赖方向：`application → core`、`adapters → core`、`desktop 装配入口 → application + adapters + contracts`、`renderer / preload → contracts`。Core 提供业务类型、端口和纯策略；Application 协调安全、终端、交互请求和主机写锁；Adapters 封装 Pi、SSH、数据库和解析器。CI 禁止反向/循环依赖，检查手写文件不超过 800 行。

## 对话与授权

Renderer 通过 `startConversation`、`sendMessage`、`setConversationModel` 等动作交互。首句绑定一个主机或显式空授权；切换终端只改变视图，不改变旧对话的主机范围。后台保留 TaskView/TaskRunner 作为持久化与恢复记录的技术名称，产品界面显示对话。旧多主机历史在首版只读。

主机连接配置变更建立新修订。已打开的终端和对话继续绑定旧修订，避免悄悄重定向到新地址。主进程系统文件选择器发放本地资料令牌，Renderer 不能授权任意路径。读取校验实际路径，上传绑定内容哈希，审核后内容改变则拒绝。

## 模型与执行循环

`ConversationModel` 分开保存已选模型和当前请求快照；请求边界才启用新选择，审核调用沿用产生操作的请求快照。全局默认只用于新对话。每次模型请求记录来源，凭据及地址修订保存在对话；更换 Key/地址后，旧记录恢复前要求明确重选，不把新 Key 发往旧端点。

`TaskRunner` 协调 Pi 循环与状态；`remote-tools` 生成有授权范围的提议；`WorkJournal` 管理计划、日志检索、核验和验收证据。验收必须引用本对话成功操作，存在未完成/未知结果时拒绝；新消息和新操作会使旧报告失效。

CloudHelm 保留权威记录，Pi 使用当前运行上下文。上下文整理按当前模型预算处理，日志通过操作 ID 分页检索；授权、审批、凭据和控制权不依赖对话摘要。

## 统一安全与终端

所有 Agent 远端变更进入 `SafetyGate`：硬禁令 → 低风险规则 → 档位审核 → 执行前复核。审核绑定完整内容、主机、目录、身份、策略和终端代次。Jev 经 Pi 分类接口调用 Vercel Gateway；无 Jev Key 时使用主模型独立审核，已配置服务超时/故障转人工。

`HostSerialExecutor` 串行同主机 Agent 变更。未知结果按操作保存锁，重启时恢复；只读核验可继续，仍在运行的远端命令不能通过核验工具解除锁。核验一次只解除对应操作。

Agent 使用独立真实 SSH PTY。审核后把完整命令发送到固定环境的非登录 Bash，明确 cwd，真实远端回显。结果标记和命令处于同一 Shell 命令行，避免标记成为业务 stdin。人工输入撤销 Agent 租约，不自动停止已有进程。交还后新建受控 Agent 会话，旧 PTY 留给用户。只有显式“停止命令”动作发送 Ctrl+C，仍须观察实际退出结果。

## 交互与密码

`InteractionCoordinator` 绑定请求、操作、主机、连接代次、终端代次、接收方和有效期；界面只提交请求 ID 和回答。普通日志中的 Password 字样不能独立触发索密。

sudo 使用专属 askpass；密码通过私有短生命周期 FIFO/独立 SSH channel 输入，不成为业务命令 stdin。受限 util-linux su 强制已核验的非交互 shell，业务代码之前关闭密码输入与继承描述符，再发出认证结束标记。无法确认接收方、PAM 流程或安全投递条件时暂停并要求人工接管。APT 只有明确无删除等新增影响时复用授权，否则结束当前尝试并重新审查。

取消输入与终止进程分别处理。密码不进入模型工具参数、持久化日志、终端录制或系统剪贴板；默认仅本次使用。SSH keyboard-interactive 直接通过 ssh2 结构化认证回调回复。

## 存储与恢复

主进程保存版本化 SQLite 记录，凭据通过 safeStorage 加密。日志流式脱敏和分块，默认保留 30 天、总量 5 GB。模型按本对话操作 ID 读取有界日志页。运行进程崩溃或连接断开时更新状态，使待处理输入与审批失效；未明确完成的操作进入未知结果核验流程。安全限制与仍待验收项目见 [STATUS.md](STATUS.md)。
