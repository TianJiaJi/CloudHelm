# AI 工具集与 root 权限整改方案

> 状态：源码审计和隔离复核完成 / 待实施。未修改业务源码，未连接真实 SSH 或读取真实凭据。
>
> 对应[综合整改总表](PROJECT_REMEDIATION_SUMMARY.md) C01–C05、B01/B03/B08、D01–D03、H02/H03/H05。本专项细化既有工作，不把每个工具差异另算一个安全漏洞。

## 一、结论

**工具设计确实会制造“AI 不够聪明”的表现，尤其是 root 操作。但不能据此声称所有错误都来自工具，或模型本身已被排除。**

当前不是完全没有提权方案：`run_remote(privilege=root)` 的操作级提权、按需私密认证和身份绑定已经存在，方向正确。主要问题是它没有成为命令、服务和文件工具共同遵循的完整契约。

模型目前要同时理解：

- 普通执行、`privilege=root`、手写 sudo；
- prepared sudo 上下文与真正确认的 root 身份；
- su、root SSH、各自的密码及能力限制；
- SFTP 不会因为 Shell 提权而成为 root；
- 普通命令允许的语法，在 root 路线上可能不支持；
- 文件操作失败后，需要自行编排暂存、安装、备份和验证。

**这些本应由后端确定的机制细节，被大量泄露成模型的决策负担。** 继续加提示词能减少部分错误，但不能替代一致、可验证的工具契约。

## 二、实际工具面：不是只有 Shell，也不应该无限加工具

当前 TaskRunner 装配 14 个业务注册项，另由 Pi 注入 ask_user、tool_search、codemode；实际适用性/可见性受授权和上下文影响，不等于每次都能调用全部工具。

| 类别 | 当前工具 |
| --- | --- |
| 执行与变更 | run_remote、write_remote_file、delete_remote_file、upload_selected_file、manage_service |
| 高级身份 | request_root_session |
| 后台控制 | stop_remote_job |
| 状态与历史 | inspect_host_environment、query_operation_history、read_operation_log |
| 用户选定的本地资料 | list_selected_directory、read_selected_text_file |
| 计划与恢复 | update_plan、record_reconciled_result |

已有历史查询、日志分页、环境观察、服务预检和后台停止值得保留。`submit_verification` 已从当前模型工具装配中排除；codemode 只能编排有授权的 query 工具，不能执行任意变更，这些不是需要倒退的限制。

高价值缺口是**远端文件的可靠读取/差异修改/条件提交，以及跨工具一致的权限处理**，不是再加几十个程序名包装器。

## 三、本轮确认的具体问题

F=隔离复现；S=源码确认；D=设计整改；V=真实环境待验收。

### 1. 同样需要 root，工具却使用不同语义（S/F）

| 入口 | 现状 |
| --- | --- |
| run_remote | privilege=root；后端确认 UID，必要时使用 sudo，严格条件下询问 su |
| manage_service | sudo:boolean；没有 sessionId 时只给 restart 加 sudo，inspect/logs 不提权 |
| write/delete/upload | 没有同样的 privilege 参数；sudo/su 上下文不能提升 SFTP |
| request_root_session | 仍在常规注册面，提供高级旧式上下文流程 |

复核例子：`manage_service(action=logs, sudo=true)` 仍提交普通用户的 journalctl；在相同的“传输证明 sudo 缺失、业务未启动”条件下，run_remote 进入确认 su 路由，服务 wrapper 不进入，并汇总为 `service-restart-unresolved`。

这些行为中有些是当前明确规定的设计，不是偶发代码异常；问题在于跨工具的权限意图不一致。也不是所有服务日志都必须 root，而是“请求了提权”不能在不同动作中含义不同。

源码：`remote-tools.ts`、`service-tool.ts`、`operation-privilege.ts`、`operation-input-bridge.ts`。

### 2. root 文件修改仍依赖模型临场拼流程（S/D）

当前提示词要求：非秘密文件先读，生成完整新文件，普通身份暂存，再分别审核 sudo install 与验证。模型因而承担了：

- 读取是否完整、是否经过脱敏、能否无损重建；
- 文件类型、符号链接和目标路径检查；
- 备份、源/目标版本、owner/group/mode/ACL/xattr；
- 审批期间并发修改、安装失败、回滚和暂存清理。

这不适合成为常见 `/etc` 配置编辑的标准工作流。**限制 SFTP 不自动提权是正确的，缺的是受控的 root 文件能力，不是放开这道检查。**

另外，普通 command 的授权指纹绑定命令文本，不绑定 install 源/目标的实际文件版本。暂存方案缺少“用户批准的内容就是最终提交内容”的完整结构化闭环。本轮是源码确认的设计风险，没有演示真实暂存文件被替换或生产配置损坏。

源码：`agent-prompt.ts`、`privileged-runtime.ts:163–180`、`file-operation-executor.ts`、`packages/core/src/fingerprint.ts`。关联 C01–C03。

### 3. legacy root 会话与正常操作入口竞争（S/F/D）

request_root_session 虽写了 legacy，但仍是基础工具项。默认流程还会让用户从 sudo、root SSH、su 选择；prepared sudo 只是准备上下文，并不是已经登录 root。

无授权主机时，基础 activeNames 仍可包含 root/run 工具；真实调用会拒绝越界，且系统提示已有 applicability=false，因此**不是权限绕过，也不是完全没有能力提示**。问题是工具声明、适用性提示、旧上下文和新操作级路线没有形成干净一致的模型界面。

常规模型不应该为了“编辑一个配置”先研究该申请什么 root session。历史兼容可以保留，但高级身份入口应由后端/用户显式启用，不作为默认推荐步骤。

### 4. 参数可被接受，却没有所期待的权限效果（S/F）

本地真实 `toPiTool` 边界复现：write_remote_file 的 schema 没有 privilege 字段，但也未封闭额外属性；传入 `privilege=root` 可以通过当前校验，假执行器收到的却是普通账户 write-file。

这是**额外字段静默不生效**，不是提权成功或实际写入了受保护文件。没有将此探针扩大为所有 provider 原生序列化路径的证明。

应统一参数、封闭额外字段、表达互斥条件；不支持的能力明确返回“未执行＋如何修正”，而不是让模型误以为已经应用。

源码：`remote-tools.ts`、`packages/adapters/src/pi-tool-validation.ts`。

### 5. 执行限制容易被误认成“权限没拿到”（S/F/V）

- 根路由在探测 UID 前就拒绝管道/重定向/展开；即使实际为 UID0，也不能走这条复合命令路线。已隔离复现。这是保守语法限制，不应通过开放任意 root Shell 来修。
- sudo 启动前的 cwd 检查仍按登录用户权限执行；请求 root 不意味着能直接以 cwd=/root 启动。可访问目录＋绝对路径是现有替代形式，但错误应明确指出 cwd，而不是泛泛建议再加 sudo。此点仅源码确认。
- 命令执行依赖 Python3/POSIX/PTY、可写暂存位置与 SFTP；登录 SSH 成功不等于执行通道 ready。固定执行 PATH 也不同于完整登录环境。
- 现有历史文档明确记录一次 VM 环境预检失败，业务 sudo 未启动、没有取得 UID0；不能说已通过真实 root 验收，也不能猜成密码错误。

源码：`sudo-plan.ts`、`operation-privilege.ts`、`ssh-command-terminal.ts`、`remote-command-program.ts`。真实 Linux、PAM 和发行版矩阵仍需验收。

## 四、root 的目标方案：AI 提业务需求，后端决定提权机制

### 统一的外部心智模型

AI 只声明：**“对这台主机的这个资源执行这个操作，目标身份是当前用户或 root。”**

所有有远端副作用的工具使用同一套权限意图。可以沿用 `privilege=current/root`，不需要为了重构先发明一套全新命名。服务/文件工具的每一步是否需要该身份由明确契约决定，不默默忽略。

模型不传密码、不维护 root session、不自行尝试 sudo→su→SSH。后端保留实际路由与受限上下文，并用机器可判定的结果告诉模型：已完成、缺信息、等待用户、未执行、需核验或能力不支持。

### 后端路由

```text
业务操作＋目标身份
  → 校验作用域、资源、环境与已有风险
  → 确定当前身份及所需权限
      已是所需身份：按该身份审核执行
      需要 root：准备具体 sudo 动作并审核
          无需密码：不询问密码
          收到可信认证挑战：操作绑定的私密输入
          证明未启动且 sudo 不可用/命令授权受限：
              提供用户确认的修复或替代身份入口
          已拒绝/取消/可能执行/结果未知：
              不换身份，不自动重放
  → 派发前复核授权、版本、租约
  → 分别记录认证、派发、进程退出和业务观察
```

- 产品审核拒绝不能用 su 绕开；用户确认替代身份，也不取消新操作的审核。
- root SSH 不做自动 fallback，不为了成功率建议启用 root 密码登录、改 sudoers 或关闭安全设置。
- 没有 sudo 时可以明确说明管理员配置或受控 su 选项，不自动安装/修权；不知道 root 密码时不反复弹 su 框。
- 不把所有 permission denied 都自动升级 root。只有权限需求明确，且前次确定未执行/无影响时，才可按策略准备新的获审操作；未知副作用先核验。
- 凭据复用和操作批准是两件事。保留已有有界、绑定身份/连接/任务的内存缓存及失效规则；不能用“少弹窗”换成全局 root 凭据缓存或永久授权。

### root 文件能力应怎么做

模型接口示意（拟议，不是当前已有工具）：

1. `read_remote_file`：返回受限内容、完整性、版本、元数据及权限上下文；脱敏/截断内容不能直接用于整文件覆盖。
2. `prepare_remote_edit`：基于原版本和 patch 生成可审核差异、目标属性与恢复计划，暂存材料由后端管理。
3. `apply_remote_edit`：只接受后端发出的 editId；提交前校验内容哈希、原版本、路径身份、授权和元数据，变更则拒绝/重新准备。
4. 独立校验和服务动作复用统一权限路线；读取、配置语法检查、服务 active 与业务健康分别给证据。

原子重命名不等于完成所有安全要求：普通文件、符号链接/路径变化、owner/group/mode、ACL/xattr、备份权限、远端并发修改、暂存生命周期都要有明确策略。支持秘密字段时必须有独立私密数据路径，不能让模型拿脱敏占位符拼回原文件。

root 文件驱动需要专项设计，不能把普通 SFTP 标记为 root，或让模型自由调用一个通用高权限脚本执行器。具体实现应暴露有限的可审核文件操作，而非长期 root Shell。

### 用户应该感受到什么

例如“修改服务配置并重启”：用户看到具体差异、目标主机/身份、重要影响与必要确认；需要认证时在私密框输入。其余读取、准备、校验由产品可靠组织，而不是 AI 每步询问怎么 sudo、要哪个密码、是否换 root SSH。

**每个动作经过 SafetyGate，不等于每个动作都弹人工确认。** 若未来合并前台批准，必须授权一个精确、有界的变更集，后端仍逐步复核；这需要正式契约，不能把一次点击当成批准整段任意脚本。

## 五、实施顺序与保留项

1. **先统一契约和测试**：跨工具的 privilege、封闭 schema、派发/认证/结果字段；把本轮反例改为目标行为回归。对应 C04、B01/B03/B08。
2. **收敛常规模型工具面**：所有需要权限的业务工具复用同一路线；legacy 会话留兼容和显式高级入口。同步修复说明和反馈，不再继续堆互相矛盾的例外。
3. **优先补 root 文件闭环**：有界 read→diff→条件提交→元数据与内容验证。对应 C01–C03；这是高频运维任务，不应留给模型自己拼。
4. **对齐服务/日志与环境 readiness**：复用 manage_service 预检→动作→观察的正确方向，但统一提权和结果语义。对应 C05、D01–D03。
5. **再做真实模型与 Linux 验收**：不把假 SSE 按脚本发出正确调用当成模型真的能稳定选工具。

在现有 OperationPrivilege、PrivilegedRuntime、PrivilegedSessions 上分层演进，共享纯策略/端口按 core/application 依赖方向抽取，Desktop 保留装配与私密交互。不要新增第二套万能权限状态机。

应明确保留：私密认证、UID 与租约验证、prepared/ready 区分、审核后派发前复核、取消不换身份、未知结果不重放、工具/脚本权限隔离，以及日志/历史查询。

## 六、验收重点

- UID0、普通用户免密 sudo、sudo 需要认证、sudo 缺失、命令级 sudoers 限制、root 锁定/禁用 SSH、取消/超时/断线。
- 服务 inspect/logs/restart、文件 read/edit/upload/delete 对同一种权限意图给出一致结果；不支持参数直接拒绝，不静默忽略。
- cwd 不可访问、Python/POSIX/PTY 或 SFTP 不可用与真正认证失败分开；不能反复要求错误种类的密码。
- root 文件并发变更、非普通文件、链接变化、元数据不能保留、部分提交、恢复和清理失败都安全终止或进入可解释恢复。
- 密码/验证码不进入模型、命令 stdin、日志；再次挑战不能仅凭次数认定密码错误；特殊 PAM/MFA 能力必须声明，不伪装普遍兼容。
- 真实模型重复执行三条任务：日志诊断、配置修改→校验→服务动作、后台启动→观察→单任务停止。记录首次工具选择正确率、无效调用、重复失败、人工介入、完成率和恢复率。

## 七、本轮证据与限制

- 新增 1 文件 / **5 项契约探针通过**：`.cache/project-review/tool-privilege-audit.test.ts`；它们断言当前差异，**不是修复验收**。
- 现有专项回归 **8 文件 / 67 项通过**，覆盖权限纯策略、私密认证/缓存、上下文绑定、服务与操作级 root 的假终端/本地 SSE 链。
- 完整审计记录：`.cache/project-review/tool-privilege-findings.md`。
- 未实际连接 Linux、修改配置、重启服务、调用真实模型或获取用户密码；不声称已测出模型错误率、全部发行版兼容性或安装包行为。

**根治方向不是让 AI 获得更多 root 权限，而是让它更少承担提权机制、文件事务和失败恢复的实现细节。**

## 八、终端创建与使用专项补充（待实施）

### 当前做对的部分

AI 的常规入口是 `run_remote`，不是自由 `create_terminal`/`write_stdin`。`ConversationTerminalPool` 自动复用同主机、登录身份、连接代次下的空闲 Agent 通道；忙碌 A 可以保留并为诊断分配 B，不抢人工终端。普通 Agent 池默认每对话 4 个条目，不是每主机 4 个或全应用上限。

`TerminalManager` 校验任务、主机、代次、所有权和指纹；新终端不能清除同 hostId 的未决写锁。已有 `stop_remote_job(hostId, jobId)` 经 SafetyGate 精确停止后台任务，不向模型开放任意 PID/信号，且不把停止回执当退出。这些机制应保留；配置身份连续性问题仍另见 A01。

### 已确认的缺口

1. **暂停/失败释放与人工接管混用（F+S）**：TaskRunner 某些非运行状态调用 `releaseIdle`，后者直接转 human，并可能新开交互 Shell，不要求先收到用户输入。保留 4 个这样的空闲条目后，第 5 次分配报上限。普通 answered 不走这一释放分支，不能说正常回答必然每轮新建。池级反例已复现，真实 4 轮桌面操作尚未验收。
2. **终端局部停止变成会话停止（F+S）**：任务终端的 Ctrl+C 转入 `stopOperation`，向同会话全部 pending 通道发停止输入。后台卡已有整会话停止的明确文案/确认，但仍缺单任务用户入口；不能说它没有提示，也不能说没有精确后台停止工具。
3. **窗口与 Shell 状态含义不够清晰（S+D）**：Agent 每次通过受控进程执行，不能跨工具调用继承 cd/export/source。现有提示已要求 cwd 和不继承环境，但返回/界面还应明确实际执行上下文；人工接管是另开交互 Shell，不是恢复原 Agent Shell。
4. **多通道与调度能力不一致（既有 F+S+D）**：诊断 B 可与后台 A 共存，不代表同主机所有独立变更都可继续。仍需 C06 的已知运行/未知结果/资源冲突区分，不能仅扩大终端数量或换通道绕开锁。

### 目标契约与职责

| 位置 | 改造方向 |
| --- | --- |
| `packages/application/src/conversation-terminal-pool.ts` | 区分运行租约、空闲资源、退役资源和显式人工接管；安全复用已退出/明确未派发的普通通道，重租时更新代次；无人接管且无 pending、日志已安全归档的空闲通道可按预算回收，历史视图保留。容量满返回结构化原因，不让模型反复建终端。 |
| `packages/application/src/terminal-manager.ts` | 拆开释放 Agent 租约、请求停止、确认退出、转人工控制、关闭资源；暂停撤销旧执行权限，不自动打开人工 Shell，也不借回收清除未决结果。 |
| `packages/adapters/src/ssh-command-terminal.ts` | 普通操作继续受控执行，不改成长期万能 Shell；只有明确人工接管才开交互入口。执行通道准备失败、业务已派发、退出未知分别反馈。 |
| `apps/desktop/src/worker/task-runner.ts`、`server.ts` | 接收精确控制目标与范围，分别处理模型暂停、单操作/后台任务停止、终端关闭和整会话停止；恢复按需分配，不因恢复模型就无条件创建一组交互资源。 |
| `background-job-tool.ts`、相关 contracts/IPC、`execution-job-status.tsx` | 模型发起停止仍走 SafetyGate；用户显式停止不依赖模型代调用。共享后端目标归属、身份/代次和退出观察，复用现有 job 控制，不新增平行 kill 状态机。 |
| `remote-tools.ts`、`operation-feedback.ts`、上下文投影 | 保持 hostId/command/cwd/privilege/background 等业务意图；返回 operation/job、实际身份和 cwd、非持久 Shell 语义、输入能力、日志游标及下一步。敏感环境不进入模型。 |

局部停止是否同时暂停模型派发必须明示；即使暂停模型，也不能因此向其他后台任务发送停止信号。不能把旧批准沿用到新代次、自动抢回真正人工会话、回收仍运行/未知通道，或把关闭窗口当成进程结束。

默认工具面继续采用 `run_remote`＋历史/日志查询＋精确后台停止，不增加任意敲键/接管/换身份接口。短命令等待退出；临时长任务使用有界后台协议；生产服务交给服务管理器；交互程序只有受支持协议或显式人工接管，不让模型猜 stdin 和密码。

### 实施顺序与验收

1. 先分离释放/接管与控制范围，新增正式反例回归，避免暂停导致资源累积、局部停止误伤其他任务。
2. 补结构化执行上下文与通道状态，保持操作/后台 job 才是结果追踪单位，不能依赖当前窗口或可见缓冲恢复任务。
3. 随 C06 改资源调度；之后验收真实 Linux/PTY、断线、人工接管和真实模型选用行为。

验收：连续正常使用不持续增开；多轮暂停/恢复不无意义创建人工 Shell 或耗尽池；显式人工会话不被抢回；后台 A＋诊断 B 不串 stdin；单任务停止不停止其他任务；信号送达但进程未退仍显示待观察；重连/换身份使旧租约失效；新终端不能清未知风险；历史输出不靠重放找回。

本次新增隔离探针 **1 文件/4 项通过**，确认当前行为；既有相关回归 **7 文件/79 项通过**，与前轮有重叠，不合计宣传独立覆盖。首次探针仅因缓存目录导入失败而未收集测试，改相对源码导入后复跑通过。没有真实 SSH、外部模型、进程停止或桌面端操作验收；没有修改业务代码。

证据：`.cache/project-review/terminal-lifecycle-findings.md`、`.cache/project-review/terminal-lifecycle-audit.test.ts`。归入总表 C06/C07、D01、F05 和 H02/H03，不新增父项计数。
