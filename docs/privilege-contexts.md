# 受控提权：操作级 root 需求与按需认证

## 常规操作流程（P0＋P1）

AI 对一个具体字面命令设置 `run_remote(privilege="root")`，无需准备上下文或传 sessionId。后端通过审计的 `id -u` 在当前连接／终端／授权租约内确认 UID；已是 root 时直接审核执行，否则先构造 sudo 命令和 root 目标身份再审核。授权指纹包含目标权限，执行意图去重不因新增权限字段失效。

固定传输组件针对本次命令执行内部非交互 `sudo -n -l -- <精确argv>`，并在查询结束后再次等待后台复核；该阶段没有业务派发，也不索密。列表策略不能代替命令认证策略：查询因需密码等原因不确定时不授权身份后备，复核后由原已审核命令自行通过 sudo 策略与认证。实际派发仍执行原 sudo 目标程序，不用 root Shell 包装业务命令。sudo 不可用或该命令被 sudo 授权拒绝，且传输证明未启动、无影响时，可提出受控 su，用户确认后新身份／新操作重新审核。没有 sudo 时建议配置而非强制安装，安装与 sudoers 修改必须另行授权。root SSH 仅显式选择，取消／拒绝／未知／部分影响不触发后备。

密码不根据登录方式推测：免密路径不弹窗，认证仅接受可信通道事件。sudo 每个命令最多三次可信挑战，非交互列表查询不会消耗认证次数。root SSH 先完成指纹验证、认证协商；只有服务端认证请求或解析器确认的加密私钥需求才索密。无口令私钥及免密认证无需提问；密码／私钥口令最多三次尝试，失效后的回答不提交。受控 su 每次派发只有单次密码窗口（注入上限 1）；认证失败由上层呈现，用户决定是否发起新派发，禁止 agent 盲试。受控 su 不再依赖远端 Python，依赖 su/PAM 及账户配置，未宣称所有平台可用。

## 受控 su 备选（legacy 上下文入口已移除）

legacy `request_root_session` 工具与 `CLOUDHELM_LEGACY_ROOT_SESSIONS` 开关已随 P1a（2026-11-19）移除；模型侧正常入口只有 `run_remote(privilege="root")`。root SSH 仍仅显式选择，不自动尝试。

- 受控 su 由结构化反馈触发：sudo 失败且传输证明业务未启动、无影响时，后端提出 su 备选，用户确认后本次业务命令被包装为单条字面 `su -c` 形态，经独立 SafetyGate 审核后在凭据绑定的 native PTY 上派发。无会话、无持久凭据、每次派发一个密码窗口。
- 开窗条件：客户端生成的 nonce 标记（wrapper printf 前导、PTY ECHO=0、业务代码尚未运行，不可被 payload 伪造复现）＋ LC_ALL=C 下 `Password: ` 提示，双条件按序满足才开窗；状态机一次进出，注入后窗口立即关闭。
- 失败分类：`su: Authentication failure` 为认证失败（pam_unix），BusyBox 变体同口径处理；用户不存在特征明确拒绝；超时／缺 exit-status 一律 unknown，不冒充认证失败，写锁不自动解除、不自动重放。
- 不启动 sudo bash、sudo su 或通用 root Shell 代理。仅允许单条字面命令；复杂命令链、展开、管道、重定向、其他目标用户、嵌套认证及权限探测在 su 备选中拒绝。
- 目录仍必须可由登录用户访问，不悄悄更改 cwd 或使用额外 root Shell；需要访问/root 下文件时可从可访问目录使用绝对路径。
- sudo/su 不提升 SFTP；文件写入走操作级受控文件事务，或用户明确确认 root SSH。不会无声降级成其他身份。

## 认证与恢复

- sudo通过现有操作专属askpass socket收集输入，不进入业务stdin、模型、审计正文或诊断。
- 第2次及以后的弹窗明确显示再次认证及次数，不仅凭再次挑战就断言密码错误；通常使用登录账户密码，但sudo/PAM可以有特殊配置。
- 缓存只复用已验证凭据，最多5分钟且绑定任务、账户、主机、连接、终端、代次和策略；再次挑战时清除被拒缓存，暂停/断线/结束清除。
- 每个单sudo操作最多3次挑战（包含缓存尝试），超时/取消/失效/晚到回答不会变成业务输入。到达上限就暂停，不能靠AI重开工具自动清零。
- root SSH沿已选择认证方式建立独立连接，并重新验证主机身份；直接su弹窗明确说明通常需要root密码，不是登录账户的sudo密码。
- root SSH 会话仍须验证 root 通道及`id -u`结果，成功才登记为已确认root会话；受控 su 不再登记会话——每次派发独立审核、独立认证，成功仅绑定该次操作，不创建全主机持久能力标志。
- 认证停止提供明确resumeReason和继续入口，但不会自动换身份、刷新请求预算或重放成功操作。产品SafetyGate拒绝不能通过其他身份绕过。

## 结构化反馈与证据边界

操作可带`privilege`元数据：`method/stage/code/source/businessCommand/recovery`。本地日志只增加有界错误码，不记录密码或原始认证正文。

| code | 含义与处理 |
| --- | --- |
| authentication-required | 需要当前操作的私密认证 |
| authentication-rejected | 观察到认证拒绝；不等于已证明哪项密码错误 |
| authentication-unconfirmed | 认证未完成、PAM/协议不兼容或无法确认原因 |
| authorization-denied | 观察到sudoers/命令授权限制，其他方案需用户确认 |
| sudo-unavailable | 固定执行组件确认sudo可执行程序不可用 |
| cancelled / timeout | 已取消、输入失效或等待超时 |
| attempts-exhausted | 当前操作认证次数已用尽 |
| transport-unavailable / unsupported | 通道中断或当前机制不支持 |

`source=output-inference`的sudo文本分类只是诊断推断：包括`-n`报告需要密码的分支，都不据此断言业务未执行，不把不在sudoers说成不在某个组，不把某条命令授权拒绝扩大成全账户不可用，不清除possible/unknown结果。只有固定传输组件能确认启动边界时才标`businessCommand=not-started`；先前步骤可能已执行时仍为unknown。

提权网络诊断仍保守处理：裸有界ping的规则不自动扩展到sudo ping；date/hostname的设置形式不分类为只读。自动批准范围不因sudo查询能力扩大。

当前会话和近期操作的有界事实直接从现有记录派生，包含来源ID、原登录/目标账户和版本；成功认证仅绑定该次操作，不创建全主机永久能力标志。没有用户配置或实际观察的权限保持未知，不主动做权限探测。

## 代码职责

- `packages/application/src/privileged-sessions.ts`：唯一会话授权状态，区分prepared与已验证ready，绑定任务/主机和撤销。
- `apps/desktop/src/worker/privileged-runtime.ts`：已有资源装配，连接/终端索引不是另一套授权状态；sudo复用普通执行器。
- `apps/desktop/src/worker/operation-input-bridge.ts`：复用私密认证、重输、凭据缓存及交互协调。
- `packages/core/src/sudo-outcome.ts`：唯一sudo结果解释入口；`privilege.ts`只定义安全反馈类型和文字，不另造认证分类器。
- `packages/adapters/src/ssh-command-terminal.ts`、`remote-command-program.ts`：固定执行协议、启动前错误与私密认证事件。
- `packages/adapters/src/native-ssh-pty.ts`、`packages/core/src/su-plan.ts`：su 窗口模式（双条件开窗、单次注入、一次进出）与 su 命令包装；`su-session.ts`／`su-session-program.ts` 生产路径已不引用，保留至 P3 统一删除。
- Renderer只展示后端元数据，不决定是否换身份、清锁或执行。

## 验证边界

本轮实际验证以 [P0＋P1](P0_P1_EXECUTION_REDESIGN.md) 和 [STATUS.md](STATUS.md) 为准。以下数字与 VM 记录属于此前上下文实现，不证明本轮新增命令级授权或 su 重试已经过真实 Linux PAM 验收。

自动门禁使用本地SSE、内存/临时数据库、合成认证输入和协议fixture，不连接用户主机、不调用真实模型，不读取日常AppData或凭据。`b53c2bcab`完整复核退出0：139文件1400测试通过、7文件19项原条件跳过；typecheck、ESLint、依赖方向、800行、版本/CHANGELOG、Edge UI、Markdown、隔离Windows Electron装配及diff通过。`b2066ba92`构建、静态及6项恢复/提权原生链通过。之前一次旧恢复夹具初始化0请求在隔离和全量复跑均未复现，原因未确认，未降低断言/超时或修改生产重试。

用户后续单独授权本地虚拟机SSH只读sudo身份验证；使用独立临时Electron用户目录、本地SSE代替真实模型，密码由用户在产品私密UI输入，不写脚本/命令行/日志。已确认隔离验证能完成SSH登录；`bddc1b865`复测元数据确认：固定Python环境预检返回127，并出现not-found类提示，操作为unsupported/effects=none，业务sudo尚未启动、未取得UID0。这只说明本次SSH执行环境的预检失败，不证明虚拟机完全没安装Python，也可能涉及非交互PATH或测试环境限制。用户已选择先交付本地验收通过的代码，VM部分交由手动核验，不计提权验证通过，不猜成root密码错误，也不自动更换身份。Windows不能运行的POSIX/PTY fixture仍按原条件跳过；这也不等于已验证所有PAM、sudoers、root SSH禁用及发行版差异。新增认证暂停会明确提供继续原因；本次不批量改写旧对话的暂停记录，旧对话仍可通过明确发送下一步消息继续。

## 交付后的手动核验

1. **远端运行环境**：在VM控制台确认`command -v python3`、`python3 --version`；若交互终端可用而应用失败，再核对非交互SSH中的PATH/运行环境。不要只据本次自动化失败就断言需要重装Python。
2. **默认sudo真实链路**：在应用选择测试VM，发送“申请默认sudo提权上下文，目录用 /，然后仅执行id -u验证身份。不要使用root SSH或直接su，不修改文件”。应优先显示sudo；上下文prepared不声称已登录root；实际审核/终端显示`sudo -- id -u`，成功后才依据UID0作本次操作结论。
3. **私密认证**：密码只在认证框输入，不发聊天、不放命令行。需要认证时应使用sudo自身要求的凭据，而非引导设置root密码。免密sudo没有弹窗是正常结果。
4. **重输/取消**：只有确认本地VM锁定策略允许时才做错误输入测试；同一操作有界再次询问，取消/耗尽后暂停、提供显式继续入口，不自动换身份或重放。不要为测拒绝而修改现有sudoers，可使用另行准备的受限测试账户。
5. **真实模型与兼容性**：真实模型是否稳定默认选sudo、实际PAM/额外认证、root SSH禁用、发行版差异和本地POSIX/PTY跳过项仍未验收；1400项本地通过不代表这些已经通过。

回传信息只需操作ID、退出码、是否出现UID0及脱敏后的错误类别，不要提供密码、验证码或完整私有日志。
