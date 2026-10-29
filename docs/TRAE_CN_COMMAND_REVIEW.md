# Trae CN 3.4.9 命令审核机制

## 范围与结论

目标：当前安装的 Trae CN 3.4.9 / VSCode 1.107.1，commit `e96bc25bf31ae57a3866ca419d23a6f563b24579`。

本轮只读安装制品，使用 REA 分析选定 JS 片段，并检查 harness.dll 原始字节中的类型、诊断和策略文本。没有调用审核模型、执行待审命令、修改 Trae 配置、连接 SSH，或读取真实凭据/会话数据库。

**核心结论：它是“权限策略 + 命令/脚本检查 + 沙箱边界 + 可选自动审核 + 人工决定”的组合，不是单独把命令交给聊天模型判断。**

需区分三条相互关联但不等同的版本轴：旧命令运行模式 v1/v2、新权限模型开关、自动审核 Guardian/Reviewer 路由。安装包同时包含这些路径，本轮未确认当前账号/任务实际启用哪种组合。

## 1. 权限模式：决定需要谁来审

前端识别以下 profile：

| profile | 可确认的产品语义 |
|---|---|
| manual_approval | 需要确认的操作交给用户，不代表所有只读动作都必然弹窗 |
| auto_approval | 启用自动审核，由下游审核组件决定 |
| full_access | 界面明确警告关闭安全审核策略、自动批准支持的工具调用，涉及文件、命令和外部资源 |
| defaultCustomProfile / 自定义 profile | 组合沙箱、审核人、场景规则、文件和网络策略 |

自动审核是否可用、默认是否启用还受动态配置 `toolAutoApprove.visible/default` 影响；配置未就绪时 PermissionModePort 初始为 manual_approval。

新权限模型另外受 `autoRunConfig.useNewPermissionModel` 与用户 `new_permission_model.enabled` 控制。不能把某个内置 profile 的完整默认值从一个自定义模板反推出来。

默认**自定义**模板可直接确认：

- shellSandbox.enable=true；onRestrict=request_permission_retry_sandbox；
- approval.reviewer=user；commandAstDangerChecker=true；
- filesystem.default=read_only；network.default=allow。

这不是所有模式、企业环境或远端的统一默认值。

## 2. 规则层：不只有命令黑名单

新权限配置包含：

- commandRules / mcpRules；
- 文件系统只读、读写授权；
- 网络 allow / deny；
- shell 沙箱及受限后的处理方式；
- 场景规则：commandAstDangerChecker、shellFileProtection、deleteToolApproval、mcpToolApproval；
- reviewer 选择。

JS 中能直接看到新增命令放行规则写成 `{ approval: "allow", execEnv: "host" }`。界面“本会话允许”/“始终允许”可将命令前缀写成 `<prefix> *`；不是所有允许都只绑定某一次完整命令。

配置服务使用相应环境的产品数据目录：

```text
permission/global.json             全局 profile、资源授权与规则
permission/tasks/<id>.json         任务资源授权
permission/rules/<id>.json         任务命令/MCP 规则
```

Work 产品分支还会加入 `permission/work`。远端工作区会解析远端 userHome 下的产品目录，而不是一律写本机；本轮未读取这些实际文件。

旧版还保留 whitelist / blacklist / always-run / always-ask、IDE/SOLO 和计划任务的独立配置。旧黑名单文案的语义是“执行前请求用户同意”，不能将其等同于下面的硬拒绝。

## 3. 内置硬拒绝：不是一般的确认弹窗

前端与原生类型文本同时出现：

- enterprise_command_blacklist；
- immutable_safety_deny；
- critical_destructive_operation、rule_id 等拒绝信息。

前端对 immutable_safety_deny 返回高危警告配置，不生成普通的批准按钮配置；正文说明这是不可覆盖的内置安全规则，命令未执行。

harness.dll 的对应模型可见结果模板还明确区分：

- 企业策略拒绝；
- 内置不可覆盖规则拒绝；
- 当前版本不认识的策略拒绝。

这些模板要求 Agent 不重试同一破坏操作、不换等价命令/工具绕过；这与“用户取消”“暂时执行错误”“等待批准”不同。拒绝本身不表示损害已经发生。

原生文本中列出的规则 ID 包括 root_recursive_delete、filesystem_format、partition_table_destroy、block_device_write；说明其设计覆盖受保护根/系统目录的大规模删除、磁盘格式化、分区/文件系统标识擦除和设备写入等类别，并提到审核脚本内容。

同时有 `command_safety/extract_shell_cmds/powershell.rs` 等语法提取路径，配合 commandAstDangerChecker 配置，支持“存在语法级检查组件”的判断。**本轮没有恢复全部匹配算法，不能保证所有 shell、编码、包装命令、脚本间接调用都被识别，也没有验证各模式下硬拒绝的全部优先级。**

## 4. 沙箱审核与命令内容审核不是一回事

待确认原因包括：

- permission_request；
- command_rule_ask / command_rule_deny / dangerous_command；
- sandbox_execute_failure / sandbox_model_escape；
- sandbox_unavailable / sandbox_to_recovery。

确认数据可包含需要的 rw_paths、ro_paths、networks、command_prefixes 和 justification。

界面会区分“授予指定文件/网络访问”与“允许这些前缀的命令在沙箱外运行”。原生 Reviewer 工作流附近还出现 preflight 和 sandbox_recovery 两种阶段标记。

因此不能把所有审核理解成“命令启动前问一次是否危险”：协议还表达了沙箱执行受限/失败后再次请求资源或沙箱外执行权限。也不能将“沙箱内可运行”自动理解成“宿主或 SSH 上任意运行”。具体执行先后仍取决于模式和原生策略。

## 5. 自动审核：Guardian 和 Reviewer 两条路

旧 SessionService 的路由代码可直接确认：

```text
未启用自动审核 → default
启用 + guardian 路由 → auto
启用 + reviewer 路由 → auto_v2
```

路由来自动态配置 `toolAutoApprove.mode`，不是只由聊天输入框的模型选择决定。没有证据证明审核一定使用与主 Agent 相同的模型。

### Reviewer 的原生实现线索

harness.dll 中存在独立的：

- auto-review/hook.rs、service.rs、reviewer_workflow.rs、reviewer_tools.rs；
- cloud-api/workflow.rs 的启动流、提交工具结果等诊断；
- source_agent_run_id、target_tool_call_id、reviewer_agent_run_id、reviewer_history_id_list。

工作流上下文附近出现 command、args、cwd、sandbox_mode、block_level、confirm_reason、assistant_message、history_id_list、会话/消息/Agent 身份和 review_stage 等字段。

裁决类型 AutoReviewVerdict 附近出现 outcome、risk_level、user_authorization、rationale、circuit_breaker_reason、fallback_to_manual_confirmation。说明设计上不只是返回一个布尔值，还表达风险、授权判断、理由与回退。

尤其有明确诊断：Reviewer 工作流工具仅支持 Read 和 LS，其他工具不允许；另有读取/目录列举参数校验、工具迭代上限、超时、缺少 verdict/biz_data 等错误处理文本。

**据此可合理重建**：单独的审核工作流取得动作与上下文引用，必要时通过受限只读工具补充信息，再返回结构化裁决，而不是执行 Agent 自己在正文里写一句“安全”就放行。

但是上述原生部分仍属于字节/诊断/类型线索，没有完整反编译函数控制流。完整审核提示词、具体模型、风险阈值、允许/拒绝条件与 Guardian 内部算法未恢复，也没有实际调用证明。

## 6. 审核结果如何回到界面

前端直接读取 confirm_info.auto_review_result：

- decision：allow / deny / reviewing 等；
- tier：包括 reviewing / timeout / error；
- reason、review_source；
- fallback_to_manual_confirmation。

review_source=reviewer 且 reviewing 时，普通人工确认区会暂时隐藏；allow 可显示自动审核通过提示；deny 和需人工决定分别有不同提示。

当 Reviewer 连续否决导致 fallback_to_manual_confirmation=true，界面会说明自动批准已停止，需要人工决定，并展示理由。通知服务也有专门的去重提示路径。

这支持存在“重复否决后转人工”的设计，但本轮没有确认触发次数、计数范围或准确重置条件。

**不能把所有审核失败统一理解成转人工或放行。** 已见超时/错误、自动拒绝和人工回退分别有表达；UI 有这些状态，不等于已证明后端每条失败路径都 fail-closed。

## 7. 人工批准如何交回执行端

新 core 工具确认入口会调用 chat.sendUserDecision，适配到 lite.send_user_decision。命令请求携带：

```text
chat_session_id、task_id、plan_item_id、tool_name
 type=tool_confirm
 decision=confirm / skip
 permission_scope=execution / task / device / none
 params（按场景携带序列化工具参数）
```

对应 UI 是单次、本次会话、始终允许、拒绝。会话/设备授权会先更新对应规则或资源授权，再提交这次决定；相关按钮保持 pending，直到面板状态改变。

旧路径使用 task.send_user_decision，通过 toolcall_id 等身份返回决定。旧 SessionService 还会拒绝已完成/失败/取消等结束态步骤的过期确认；命令编辑/配置变更有 verify_and_confirm 路径，取回新的 confirm_info。

**确认的身份字段不等于已证明强绑定。** 本轮没有证明原生执行前将命令字节、主机、目录、身份、策略版本、终端代次全部做一致性复核，或使用了不可重用的授权凭据。参数变更后的完整重审与并发竞争也未实测。

## 8. 容易误判的边界

1. Full Access、自动化任务、特定后台会话有单独策略，不能声称所有任务都必经人工或 AI 审核。配置服务中自动任务 profile getter 甚至有 full_access 回退值；它不证明当前计划任务实际采用该值。
2. 旧 checkHitRedList 的 JS 包装捕获错误后返回空对象；添加白名单调用方在没有 hit_red_list 时可继续写配置。因此不能仅凭“检查过红名单”推断该 UI 辅助路径严格 fail-closed。是否执行仍要看后端后续检查。
3. 关闭危险按钮、显示高危理由和向 Agent 发“不准绕过”提示都不是安全隔离本身；原生执行器和 OS 沙箱才是最终必须验证的位置。
4. `<prefix> *` 是较宽授权，不能等同于对一条精确命令的批准。

## 9. 对 CloudHelm 的建议

借鉴分层而非照搬所有默认值：

```text
规范化操作 + 确定性 SafetyGate
    → 可选独立 AI 风险复核
    → 必要时人工确认
    → 执行前重新核验批准绑定
    → 执行与真实结果核验
```

AI 审核可提供意图、风险和理由，但不能覆盖硬拒绝，不能在异常时替代批准；不要让提出命令的 Agent 自行宣布已获授权。远端变更仍统一经过 SafetyGate，批准继续绑定内容、主机、目录、身份、策略版本和终端代次。

## 证据与覆盖

- JS 原件：`node_modules/@byted-icube/ai-modules-chat/dist/index.mjs` 与 `dist/8.4ad70c6d.mjs`。
- 原生原件：`modules/ai-agent/harness.dll`。
- 缓存：`.cache/trae-command-audit-analysis/`。
- excerpts/provenance.json：原件 SHA-256、字节/UTF-16 范围、片段 SHA-256；片段带合成语法包装，从未执行。
- native-focused.json / native-review-markers.json：原生 SHA-256、原始字节范围及非 ASCII 有损显示；不等于反编译或运行证据。
- REA 完整父记录：`ev_d5962c7897a7397d9938f9298de036b6eb23028cf95614c61794c070ea9c4d2e`。
- REA summary：`ev_b46b303581afeda03522f5c41be203adddbc16fe51fa85d1e8baa38793fccc81`。

本次 REA 选择 11 个片段，全部解析成功，0 parse failures；其中仍有语义 unknown，未选择片段与原生函数控制流不在其证明范围。没有进行命令注入/逃逸测试、审核模型实测、完整原生安全审计或实际远端验证。

问题覆盖：配置与交互链路已回答；Reviewer 架构部分回答；原生精确策略顺序、模型/提示词、全部执行前强绑定和所有失败路径仍未验证。
