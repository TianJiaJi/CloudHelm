# 开源命令分析与风险判定候选

> **后续更新：已按用户要求直接 Git 克隆并阅读固定提交源码。当前结论见 [固定提交源码审查](OPEN_SOURCE_COMMAND_SAFETY_SOURCE_REVIEW.md)。下文保留首次网页初筛记录，不再代表最终核验状态。**

## 首次调研边界

本轮检索了公开项目说明，重点区分危险命令检测、权限策略、语义审核和语法解析。没有安装、执行或接入任何候选项目。

**来源限制**：默认 Ollama 搜索未登录；已使用另一可用检索服务。GitHub、raw.githubusercontent.com、GitHub API 和相关文档站的直接抓取因本地 TUN/fake-IP 地址触发 SSRF 防护而被阻止。没有修改网络安全设置或绕过该限制。

因此，以下新增候选的功能和许可主要来自检索服务对上游 README/文档的索引说明，**不是本轮已下载、逐文件阅读和运行验证的结果**。许可证、维护状态、API 与规则覆盖在正式选型前必须以固定提交的原文复核；本轮不提供未经验证的版本号、维护承诺或安全保证。

## 1. 最贴近需求的命令风险项目

### cc-safety-net

- 仓库：<https://github.com/kenryu42/cc-safety-net>
- 定位：AI Coding Agent 工具执行前的命令守卫。
- 检索说明：TypeScript 项目、MIT；阻止部分破坏性 Git/文件系统操作与敏感文件访问，支持多种 Agent CLI，其中包括 Pi。
- 对 CloudHelm 的价值：技术栈接近，值得优先研究命令检测器、包装处理、敏感路径规则和对抗性测试案例。
- 边界：CLI hook 的 Pi 支持不等于可无改造嵌入 CloudHelm；它不是远端沙箱，也不能取代主机身份、精确审批、SFTP 安全和未知结果写锁。
- 推荐用途：**第一批源码研究和离线对照候选**，不是直接安装其 hook 接管现有执行链。

### sh-guard

- 仓库：<https://github.com/aryanbhosale/sh-guard>
- README：<https://github.com/aryanbhosale/sh-guard/blob/main/README.md>
- 定位：面向 AI Agent 的 Shell 语义风险分类。
- 检索说明：Rust / tree-sitter-bash；分析命令、目标、参数和管道关系，提供 JSON 和 0–100 风险评分；许可标注 GPL-3.0-only。
- 对 CloudHelm 的价值：与已有 Tree-sitter 路线一致，尤其值得研究它如何从 AST 走到效果和风险，而不是重新选一个 parser。
- 边界：风险分数不代表用户已授权，低分也不能覆盖硬禁令、失败状态或不完整证据。未验证它能识别 CloudHelm 本轮发现的 Git 全局选项、tar 设备输出和 cwd 包装问题。
- 推荐用途：**AST → 语义/风险规则的对照实现**；若有纯分析 CLI，可评估适配器接入，但须先检查输入是否绝不被执行、部署与许可条件。

### bash-guard（lloydzhou）

- 仓库：<https://github.com/lloydzhou/bash-guard>
- 定位：针对 Claude Code / Codex 的 fail-closed Bash 安全门禁。
- 检索说明：Rust、MIT；本地权限策略、JSON hook 输入、审计；说明中特别处理二进制缺失、输入无效、审计失败等拒绝路径。
- 对 CloudHelm 的价值：适合研究“分析器不可用怎么办”“策略与审计失败能否放行”，以及工具调用到门禁的适配。
- 边界：不能仅因项目叫 fail-closed 就推定它覆盖所有危险语法或远端状态；当前未确认完整 AST、cwd/身份变换与参数解析覆盖。
- 推荐用途：**门禁协议与故障处理参考**，与前两个候选一起做纯文本评测。

## 2. 成熟体系中可拆出来研究的模块

### OpenAI Codex execpolicy

- 模块：<https://github.com/openai/codex/tree/main/codex-rs/execpolicy>
- 文档：<https://github.com/openai/codex/blob/main/codex-rs/execpolicy/README.md>
- 许可文档：<https://github.com/openai/codex/blob/main/docs/license.md>
- 检索说明：Rust；Codex 主仓库 Apache-2.0；参数前缀规则，allow / prompt / forbidden，规则可附 justification。文档说明接口处于 preview。
- 价值：策略表示、可解释匹配、规则优先级和规则测试。
- 边界：prefix policy 不是理解任意 Shell 语义的万能分析器；把 `git *` 允许并不能解决子命令、脚本、路径及授权绑定问题。整体 Codex 的 sandbox/approval 机制也不能全部归功于 execpolicy 单个模块。
- CloudHelm 建议：研究其小型策略语言和测试方式，不为复用它而替换现有 Pi 会话层。

### OpenHands Software Agent SDK 的安全分析模块

- 仓库：<https://github.com/OpenHands/software-agent-sdk>
- 已有项目研究记录：`docs/PERMISSION_RESEARCH.md` 中固定过提交与 security 模块路径。
- 定位：动作风险分析接口、独立 guardrail LLM、风险等级与分析结果组合。
- 检索说明：SDK 为 MIT；ToolShield 是可选依赖，**不能由 SDK 的 MIT 推断 ToolShield 本身及其全部依赖也使用 MIT**。
- 价值：结构化动作上下文、独立审核、UNKNOWN 的融合方式。
- 边界：不是一个直接替代 Shell AST/确定性硬禁令的库；引入整个 Python Agent SDK 对 Electron/TypeScript 项目成本较大。
- CloudHelm 建议：以代码/协议设计参考为主，暂不整套接入。

## 3. 只解决部分问题，但值得配合使用

### ShellCheck

- 仓库：<https://github.com/koalaman/shellcheck>
- 定位：Shell 脚本静态检查，发现语法、引用、展开及常见逻辑问题。
- 检索标注：GPLv3。
- 用处：补充脚本质量提示、定位行号、提供可解释诊断。
- **不能做什么**：一个故意删除重要文件的脚本可能语法完全正确；ShellCheck 无报错不等于操作符合用户目标、有权限或风险可接受。
- 建议：可作补充检查，不把“ShellCheck 通过”设为 SafetyGate 放行条件；打包分发与许可证要求另行核对。

### mvdan/sh

- 仓库：<https://github.com/mvdan/sh>
- 定位：Go Shell parser / formatter / interpreter，包含 shfmt。
- 检索说明：支持多种 Shell 语法；BSD-3-Clause 的许可信息本轮仅检索到旁证，仍需核对仓库 LICENSE。
- 用处：研究 parser、AST 遍历、Shell 作用域和测试语料。
- 边界：parser 不自带 CloudHelm 所需的 SSH 风险策略；不要在命令安全分析中误用 interpreter 去求值不可信输入。
- 建议：CloudHelm 已有 web-tree-sitter 0.27.0 / tree-sitter-bash 0.25.1，不必为了借鉴语义分析先更换语言和 parser。

### GitHub Agentic Workflows 的 Bash parser 规范

- 规范：<https://github.github.io/gh-aw/specs/bash-command-parser-specification/>
- 价值：如何定义提取结果、解析失败/空结果、权限检查责任与不支持语法的契约。
- 检索说明：规范明确提醒 parser 不是 sandbox，解析失败/没有提取到命令不能因此关闭权限检查。
- 建议：用来审查 CloudHelm 的 analyzer port 契约与测试，不把规范本身当现成风险检测库。

## 4. 需要单独警惕的候选：destructive_command_guard / dcg

- 仓库：<https://github.com/Dicklesworthstone/destructive_command_guard>
- 定位：阻止 Agent 执行危险 Git/Shell 命令，功能方向很贴近。
- **许可警示**：多次检索说明显示其为带 OpenAI/Anthropic rider 的非标准 MIT 条款。没有成功直接读取本轮 LICENSE 原文，不能当作普通 MIT/标准开源依赖推荐。
- 建议：先列为许可证需特别核验的公开源码候选，不进入默认可复用依赖清单。不要把 GitHub 可见源码与符合标准开源定义混为一谈。

## 5. 对 CloudHelm 的选型顺序

### 优先离线比较这三个

1. cc-safety-net：技术栈接近，重点看检测规则与测试。
2. sh-guard：重点看 AST 语义、目标和风险输出。
3. bash-guard：重点看门禁、输入验证和故障路径。

并不代表上述项目已被证明安全或生产成熟；只是与当前问题最相关的候选。

### 正式接入前的检查清单

- 固定 commit/tag，直接检查 LICENSE、依赖许可、构建和分发条件。
- 阅读解析器/CLI 入口，确认“分析”绝不执行输入文本，不自动安装全局 hook。
- 查实际处理 Git 全局选项、tar 输出、env/sudo cwd/身份变化的源码和测试；没有案例不能假定覆盖。
- 核对 Windows/Electron 本地打包能力，或是否需额外 Rust/Go/Python 运行制品；不能默认文档里的 macOS/Linux hook 适用于本项目。
- 用已有 20 个纯文本案例作并排评测，分别记录漏判、误报、UNKNOWN、错误、耗时和规则理由。
- 解析器故障、超时、非零退出和无效 JSON 不得变成普通允许。
- 检查路径/文件类型等事实来源，不能把本机上下文冒充 SSH 目标环境。

### 接入位置

若最终选择外部分析器，应封装在 adapters，core 定义必要端口和结果类型，由 Application/SafetyGate 编排；contracts 只向 renderer 投影结果。

静态风险检查不能只挂到主模型的某一个 hook，否则其他 Agent 远端变更入口可能绕过。外部工具的 allow 也不能覆盖现有硬拒绝、精确审批、执行前复核和未决结果写锁。

推荐路线是：先修 `docs/COMMAND_REVIEW_DEVELOPMENT_GUIDE.md` 中三个已复现的分类缺口，同时吸收候选规则和测试，再决定是否需要引入额外运行时。不是先安装一个 guard 就宣称安全问题已解决。

## 6. 本轮产物与未完成验证

检索记录保存在 `.cache/oss-command-research/search-records.json`，包含检索 responseId、索引摘要和来源 URL。它不是原始仓库快照，也不是源码安全审计证据。

尚未完成：上游固定提交下载、直接许可证全文核验、候选源码逐函数审查、构建/运行对照、Windows 兼容性和真实 SSH 安全验收。没有执行任何下载即运行的安装命令，没有变更项目依赖或运行链。
