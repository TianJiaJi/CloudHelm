# Agent 重构进度

> 本页记录实际交付，不覆盖 [实施计划](V5_3_REFACTOR_PLAN.md) 和两份配套规格。按风险拆分子批，不以报告数量或测试数量冒充整体里程碑完成。未获得真实主机/付费模型授权，不开展相应验收。

## 当前状态

| 阶段/子批 | 状态 | 已取得证据 | 尚未完成 |
|---|---|---|---|
| G0 基线与可行性 | 本地基线/契约交付完成，可信原生启动支持仍受阻 | SDK 60 秒等待、取消、恢复不重放、关闭独立 IO；原始问题可复现 | 真实 SSH/PAM、可信未启动证明、真实任务体验基准 |
| G1-A 认证诊断 | 保守分类修复通过局部回归 | 不再从混合诊断得出未启动/无副作用，不误触发 su 回退；写锁回归 | 未提供新的可信启动协议，不能宣称原生 su 回退真机已验收 |
| G1-B 受限只读续查 | 本地回归通过 | 923 项通过、2 环境跳过；拒绝/部分变更后可受控只读，不解锁 | 真实任务体验、其它可恢复失败与长期状态收敛 |
| G1-C 审批等待权威 | 本地回归通过 | Application 唯一 pending/期限/续期；938 项通过、2 环境跳过 | 不代表业务任务状态机已全部迁出 Worker |
| G1-D 等待释放/重入槽 | 全量自动回归及构建通过 | b4e2d36c7：3006 项通过、6 环境跳过、0 失败；类型/全量 lint/依赖/行数/布局/版本/日志/构建通过，首轮失败另保留 | 真实环境及主机队列中的最终派发时效仍需独立契约 |
| G1-E 主机队列后入口准入 | 本地扩展回归及构建通过 | b6813330c：950 项通过、2 环境跳过；类型/全量 lint/依赖/行数/布局/构建通过 | 真实传输交接点的时效与单次许可仍未覆盖 |
| G1-F 原生前台启动许可 | 全量自动回归及构建通过 | b921883b7：3019 项通过、6 环境跳过；所有静态/版本门禁及构建通过 | PTY/后台/文件等其它路线尚未覆盖；真实环境未验收 |
| G1-G 统一结果正交事实 | 局部回归通过 | OperationResult/OperationOutcome v2：handoff/businessStart/liveness/effects 四正交事实全执行路线见证；358 项局部通过、类型与四项 lint 通过 | 后台/写交接点启动许可、三模式裁决契约未接入（已随后续批次接入） |
| G1-H PTY/会话启动许可 | 局部回归通过 | native-pty 与会话路线在各自 exec 交接点单次消费启动许可；终端校验派发绑定后重绑被审命令与目录；gate 铸造/填充扩展至两条路线；269 项局部通过、类型与四项 lint 通过 | 真实 PTY 环境未验收 |
| G1-I 后台setsid启动许可 | 局部回归通过 | native-background 仅在 setsid launch 派发点单次消费启动许可；stat 核验/watcher/stop 不触碰许可；gate 铸造/填充扩展至该路线；91 项局部通过、类型与四项 lint 通过 | 真实后台作业未验收 |
| G1-J SFTP文件路线许可 | 局部回归通过 | 结构化 SFTP 写（upload/write-file/delete-path）在 writeFile/deleteFile 交接点单次消费文件启动许可，绑定路径/kind/内容哈希；受控事务保持每步复核不铸造；预检与读回不消费；144 项局部通过、类型与四项 lint 通过 | 真实 SFTP 主机未验收 |
| G1-K 模式二自审确认协议 | 局部回归通过 | adjudication-required 回执绑定操作/身份/策略指纹与终端代次；同模型显式二次确认（adjudications 携带引用、confirmed、basis）后才放行，未确认不派发；过期/不匹配/已消费升级人工；adjudicationId 仅作关联引用不作重放凭证；自审 14/14、端到端闭环、受影响 worker 回归（service-tool 20、review-cancellation 5、results 11、ai-review 2、controlled-file 7、file-edit 3、remote 14）通过；类型与四项 lint 通过 | 真实模型的自审确认行为未验收 |
| G1-L 模式三预授权范围 | 局部回归通过 | core 纯匹配器 matchPreauthorization：单调用形状/参数前缀/文件 kind+路径根命中自动允许（decisionSource='user-preauthorization'、autoAdjudicated），越界 deny 未执行（preauthorization-out-of-scope，receipt 'rejected'，primary 'revise-operation'）；解释器/提权入口 core 匹配层与 contracts 校验层双层拦截；硬门/披露/身份/高影响/保护路径/项目代码/外传不随模式放宽；scope 经 update-host-safety 增量下发（null 清除、undefined 不动）并随 policyRevision 失效；core 12/12、主进程 IPC 7/7、风险矩阵 51 项通过；类型与四项 lint 通过 | 预授权范围的 UI 编辑入口非目标未做；真实主机范围命中率未验收 |
| G1 收尾 | 全量串行与构建通过 | 341 个测试文件通过、4 环境跳过；3086 项通过、6 环境跳过、0 失败；类型/四项 lint/生产构建通过；模式二协议引起的 3 处集成测试预期已对齐（独立审核需显式 dedicated reviewer，自审为默认路径） | 真实主机/付费模型授权的验收仍按计划留待 G3 |
| G2 核验、写锁及一次确认恢复 | 全部子批交付，全量串行与构建通过 | `f9fdd4a` 统一恢复用例的三种具名处置（拒绝/仅解除/接受并继续，恢复决策持久化）；`781b545` 显式逻辑上下文契约（默认 cwd/环境配置随任务显式下发）；`dbab5ca` 业务失联的记录与重建分支（断线归约、recordConnectionLoss、已交接未知不重放）；`2d8b0f2` 收敛长作业观察与精确停止（OBSERVATION_LIMITS 具名常量、onObservationTimeout 钩子、expireObservation unknown 结算、迟到退出仍记账）；345 个测试文件通过、4 环境跳过；3135 项通过、6 环境跳过、0 失败；类型/四项 lint/生产构建通过；补齐批次外 server-preparation 假 runner 的 recordConnectionLoss 桩 | 真实主机/付费模型授权的验收仍按计划留待 G3 |
| G3 隔离真机对照 | 隔离真机验收完成 | [恢复交互](G3_REAL_MACHINE_REPORT.md)、[写操作失联与新旧受阻对照](G3_REAL_MACHINE_SUPPLEMENT_REPORT.md)、[提权路线](G3_PRIVILEGE_ROUTE_REPORT.md)、[正向部署与发布断线](G3_PUBLISH_ACCEPTANCE_REPORT.md)：`e484c25` 在隔离 VM 完成受控 `su` 部署，健康端点 HTTP 200；发布认证窗口断连后结果保持 unknown，先核验对账、再新提案，未自动重发 | 发布守卫异常拒绝与提交前哈希强制检查仍待加固；认证窗口断连不代表已验证提交中途失联；不外推生产准入或模型请求数改善 |
| G4 受控切换 | 未开始 | 无新证据 | 数据/会话/未决账兼容、单一路由、移除旧入口 |
| G5 工具及人工底座收敛 | 未开始 | 无本轮交付证据 | 五域、有界 Schema、人工回归与审计盲区 |
| G6 Skills/MCP/多主机/子代理 | 未开始 | 既有草稿/资源不计作完成 | 各自授权、披露、隔离与恢复验收 |

## G1 退出前还要检查

- 统一结果需区分交接、业务启动、活性/退出、影响、认证与后续准入，不只替换工具文字。
- 三模式的裁决范围及自审条件、单次派发许可、Main ACK 与实际传输交界的复核须形成完整契约；现版基础不等于目标全部落地。
- 审批已迁 Application；TaskRunner/ExecutionScheduler 等仍在 Worker，后续随业务切片迁移，不先做目录搬家。
- 真实未启动证据不足时保持 unknown；不能为了提速恢复 G1-A 已删除的捷径。
- 本轮所有证据均来自本地测试，不宣称已达到真实部署 ≤7 请求或全面改善所有故障。

## 子批报告

- [G0 基线及可行性](AGENT_REFACTOR_G0_REPORT.md)
- [G1-A 认证诊断](AGENT_REFACTOR_G1_AUTH_REPORT.md)
- [G1-B 受限只读续查](AGENT_REFACTOR_G1_CONTINUITY_REPORT.md)
- [G1-C 审批等待权威](AGENT_REFACTOR_G1_APPROVAL_REPORT.md)
- [G1-D 释放执行槽](AGENT_REFACTOR_G1_SLOT_REPORT.md)
- [G1-E 执行器入口准入](AGENT_REFACTOR_G1_ENTRY_REPORT.md)
- [G1-F 原生前台启动许可](AGENT_REFACTOR_G1_NATIVE_START_REPORT.md)
- [G1-G 统一结果正交事实](AGENT_REFACTOR_G1_OUTCOME_REPORT.md)
- [G1-H PTY/会话启动许可](AGENT_REFACTOR_G1_PTY_SESSION_CLAIM_REPORT.md)
- [G1-I 后台setsid启动许可](AGENT_REFACTOR_G1_BACKGROUND_CLAIM_REPORT.md)
- [G1-J SFTP文件路线许可](AGENT_REFACTOR_G1_SFTP_CLAIM_REPORT.md)

历史失败保留在对应报告；复跑通过不追认先前失败链。

## 本地 Git 检查点

按用户最新确认：阶段验证通过后本地 commit，不 push。分支 `refactor/agent-v5_3`，`fffb7d7` 保存 G0 与已验收 G1-A/B/C/D 的工作及计划。旧报告中的“未提交”描述其当批状态，不覆盖此处的后续提交记录。G1-E 通过验证后单独以“修复主机排队后的审批准入时效”提交，本报告不自引用该提交哈希，以本地 `git log` 核对，实际已保存为 `aaca187`。G1-F 验收后以“绑定原生SSH前台命令的单次启动许可”独立提交本地分支，不推送。

用户原有 roadmap、README、Skills 和现状草稿仍留在工作区，不自动纳入阶段提交、整理或重置。

G1-G 验证后以“统一工具结果的正交事实协议”提交本地分支，不 push；本报告和代码同一提交，准确哈希以本地 `git log` 为准。

G1-H 验证后以“扩展PTY与会话路线的单次启动许可”提交本地分支，不 push；本报告和代码同一提交，准确哈希以本地 `git log` 为准。

G1-I 验证后以“扩展后台setsid路线的单次启动许可”提交本地分支，不 push；本报告和代码同一提交，准确哈希以本地 `git log` 为准。

G1-J 验证后以“补充SFTP文件路线的分步准入核验”提交本地分支，不 push；本报告和代码同一提交，准确哈希以本地 `git log` 为准。

G1-K（模式二）验证后以“落地模式二自审确认协议的端到端闭环”提交本地分支，不 push；本报告和代码同一提交，准确哈希以本地 `git log` 为准。

G1-L（模式三）验证后以“建立预授权范围的裁决契约”提交本地分支，不 push；本报告和代码同一提交，准确哈希以本地 `git log` 为准。

模式二协议落地后，三处沿用旧默认的集成测试（独立审核路径、消息准备边界）以“对齐模式二协议的三处集成测试预期”单独提交对齐；G1 收尾全量与构建通过后归档本次进度更新，不 push。

G2 四个子项验证后分别以“统一恢复用例的三种具名处置”、“建立显式逻辑上下文契约”、“统一业务失联的记录与重建分支”、“收敛长作业观察与精确停止”提交本地分支，不 push；本报告和代码同一提交，准确哈希以本地 `git log` 为准。

G2 收尾补齐批次外测试桩缺失后，全量串行（345 个测试文件通过、3135 项通过、6 环境跳过、0 失败）与生产构建通过，以“收尾G2核验写锁与一次确认恢复”提交本地分支，不 push。本轮全量两度出现 `conversation-cleanup` 两个 junction 用例失败（各约 31.3 秒同步阻塞后 EPERM），定位为本机 360 主动防御（ZhuDongFangYu 服务）对长跑进程创建 reparse point 的间歇性行为拦截：单文件隔离运行、裸 Node 脚本与 1500 次 churn 循环均通过，第三次全量在未改动 360 的情况下亦通过。若全量再出现“仅 junction/符号链接用例、30 秒级阻塞后 EPERM”的失败模式，先按环境干扰排查，不要当作代码回归。
