# SSH 权限重构：源码研究与取舍

这份记录区分可核对的开源实现与仅能依据公开文档的产品行为。研究时固定源码提交，避免把后续版本变化当作本次实现依据。CloudHelm 没有复制第三方代码；以下借鉴的是设计和测试思路。

| 项目与依据 | 可借鉴的做法 | CloudHelm 的取舍 |
| --- | --- | --- |
| [Codex 策略源码](https://github.com/openai/codex/blob/806d9732c974bc8a51b8317c1bd8985544fe627c/codex-rs/execpolicy/src/policy.rs)、[Guardian 路由](https://github.com/openai/codex/blob/806d9732c974bc8a51b8317c1bd8985544fe627c/codex-rs/ext/guardian-reviewer/src/routing.rs) | 明确规则命中、单独审核、审核失败分类和执行前复核 | 保留规则编号与精确授权；第三档仍检查硬禁令，这是用户要求，与 Codex Full Access 行为不同。 |
| [OpenHands ToolShield](https://github.com/OpenHands/software-agent-sdk/blob/e2bac66be26e94f571f27b71f507e7192720f825/openhands-sdk/openhands/sdk/security/toolshield_llm_analyzer.py)、[自评分析器](https://github.com/OpenHands/software-agent-sdk/blob/e2bac66be26e94f571f27b71f507e7192720f825/openhands-sdk/openhands/sdk/security/llm_analyzer.py)、[风险融合](https://github.com/OpenHands/software-agent-sdk/blob/e2bac66be26e94f571f27b71f507e7192720f825/openhands-sdk/openhands/sdk/security/ensemble.py) | 独立模型结合少量近期动作，工具内容作为不可信数据 | 不把执行模型自评当独立审核；UNKNOWN 不受 LOW 覆盖，故障转人工。 |
| [OpenCode 权限规则](https://github.com/anomalyco/opencode/blob/055d95bb7e278c94baf06235a52cac79dd13ba67/packages/core/src/permission.ts)、[Bash 路径扫描](https://github.com/anomalyco/opencode/blob/055d95bb7e278c94baf06235a52cac79dd13ba67/packages/core/src/tool/bash.ts) | 拒绝规则优先于保存的允许规则；路径扫描作为提示 | 只提供一次性精确批准，不创建“始终允许”授权；Shell 路径识别不声称是文件隔离。 |
| [Cline 审批拒绝反馈](https://github.com/cline/cline/blob/bf71bf7cd9fe6816972d7ae5ca5ff0e04e63f87d/apps/vscode/src/sdk/tool-approval-denial.ts)、[重订阅处理](https://github.com/cline/cline/blob/bf71bf7cd9fe6816972d7ae5ca5ff0e04e63f87d/sdk/packages/core/src/hub/server/handlers/approval-handlers.ts) | 明确告诉 Agent 操作未执行；重连恢复待审批状态 | 后端状态为权威，旧卡不可重复提交，拒绝不等于远端失败。Cline CLI 自动批准不能代替独立风险审核。 |
| [TRAE IDE 公开仓库](https://github.com/Trae-AI/TRAE)、[公开权限文档](https://docs.trae.cn/ide_permission-and-approval) | 三档交互的产品参考 | 公开仓库不含权限执行代码；`trae-agent` 是另一项目，不能推断 IDE 内部架构。 |
| [Claude Code 公开仓库](https://github.com/anthropics/claude-code) | 公开文档中的操作批准体验可供比较 | 仓库不含核心权限执行代码，不能据此声称内部规则或沙箱机制。 |

## 本次实现的模型

后端对每次 Agent 远端操作依次检查身份与凭据规则、硬禁令、方向性保护路径、Bash 解析与目标、影响级别、审核档位。已知只读及普通写入直接执行，高影响操作在前两档逐次询问；第二档把不确定操作交给无工具权限的独立审核调用。审核拒绝只阻止该次操作，三次连续拒绝暂停；用户可主动申请一次精确人工复核。第三档允许有效但不透明的操作，仍保留硬禁令、保护路径和审计。每次决定记录规则编号和简短原因。

主机档位是新对话默认值，对话可单独切换并持久保存。旧保护路径迁移为禁止读取和禁止写入两组。批准绑定完整操作、主机、目录、身份、策略版本和终端代次，有效期十分钟；执行前复核。审核模型需显式选择当前模型、Jev 或指定模型。密码与验证码仍走原有私密认证通道。

## 边界与后续验证

SSH Shell 命令可能经符号链接、变量、动态脚本或远端并发修改绕过静态识别。SFTP 对本地已有小型脚本做只读检查和执行前哈希重查，但检查和启动之间没有原子锁。黑名单只覆盖明确可识别的灾难性形式；第三档尤其依赖远端账号权限和备份。第三方源码研究不能证明 CloudHelm 检测所有等价表达，也不能把模型审核当作强安全边界。

自动测试覆盖三档、包装命令、保护路径方向、审核失败、审批过期和执行前复核；真实 SSH、不同发行版的 sudo/PAM 及恶意脚本竞态仍需在专用测试主机上验收。
