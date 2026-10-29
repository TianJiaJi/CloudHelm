# 开源命令审核：固定提交源码审查

## 结论

已按用户要求直接 Git 克隆并阅读源码。此前依赖网页检索的候选介绍现在有了可核对的源文件依据。

**对 CloudHelm 最值得优先借鉴的是 cc-safety-net 的 Git 解析、包装上下文、语义事实与测试；不是直接安装它接管 SSH。** sh-guard 更适合风险结果结构与解释参考；bash-guard 的扫描机制比名称暗示的简单，不能直接替换现有 AST + SafetyGate。Codex 适合策略匹配设计，OpenHands 适合风险/确认分离和组合分析。

本轮只克隆和阅读：没有安装依赖、运行构建/安装/Hook 脚本、运行第三方测试、执行待审命令、调用审核模型或连接业务 SSH。以下测试结论指“源码中存在的断言”，不代表本轮实际运行通过。

## 1. 下载位置与版本身份

所有检出位于 `.cache/oss-command-research/repos/`；没有改动项目依赖或业务实现。

| 仓库 | 固定 commit | 检出范围 |
|---|---|---|
| cc-safety-net | `5b0fc4731aad33b88d2e91b4970eb34821cc67fa` | 浅克隆，源码与测试 |
| sh-guard | `92005d65b1232946924b524bcad267a29d8a2cb5` | 浅克隆，源码与测试 |
| bash-guard | `1bac41bcb2e02f49d0df6c637943547e676cd24d` | 浅克隆，源码与测试 |
| Codex | `479f7046ebbb5039c587b72a33af4e3776eac281` | execpolicy 等选定目录稀疏检出 |
| OpenHands Software Agent SDK | `6edd54d481cd778abcdb0dab6ce566e529788d4a` | security 等选定目录稀疏检出 |
| destructive_command_guard | `5c060064bd8630b667c7d6c3a3aeea0125cca755` | 仅根目录资料/许可证；不审查实现 |

完整 clone 元信息：`.cache/oss-command-research/clone-manifest.json`。ShellCheck、mvdan/sh、GitHub Agentic Workflows 本轮没有克隆，其先前介绍仍是初筛资料。

## 2. cc-safety-net：最值得阅读，但存在本地环境假设

### 已确认的库入口

`package.json` 声明版本 2.7.0、Node >=22、MIT，显式导出 `./api`。

[`src/entries/api.ts:18`](https://github.com/kenryu42/cc-safety-net/blob/5b0fc4731aad33b88d2e91b4970eb34821cc67fa/src/entries/api.ts#L18) 提供：

```ts
checkCommand({ command, cwd })
// -> { kind: 'allow' }
// 或 { kind: 'deny', reason, ruleId }
```

这不是只有 CLI Hook 的项目，确实有可供程序调用的分析入口。不过它要求 cwd 是本机可用的绝对目录，并调用 createProcessEnvironment。

`src/core/environment.ts` 默认使用本机环境变量、home/tmp、realpath/stat 等事实；特定辅助路径还会使用受限本机 getconf/Git 配置查询。不能把它当成完全无 I/O 的纯函数，更不能把 Windows 本地文件系统信息当成 SSH Linux 目标事实。

### 正好对应 CloudHelm 两个缺口的模块

1. [`git/parse.ts:86`](https://github.com/kenryu42/cc-safety-net/blob/5b0fc4731aad33b88d2e91b4970eb34821cc67fa/src/gate/analyzer/git/parse.ts#L86)：extractGitSubcommandAndRest 跳过全局选项及值，再取子命令，而不是固定读取 args[0]。还处理命令行/环境的 Git 配置、别名解析及有界展开。
2. [`wrapper-prelude.ts:192`](https://github.com/kenryu42/cc-safety-net/blob/5b0fc4731aad33b88d2e91b4970eb34821cc67fa/src/gate/analyzer/wrapper-prelude.ts#L192)：sudo -D/--chdir、env -C/--chdir 会更新 currentCwd，无法确定时保留 null。
3. `analyze-command.ts` 的状态中有 effectiveCwd、Shell/Git 环境、函数定义、已创建目录等；不是只有扁平命令名数组。
4. parser 是其自有 POSIX/PowerShell 结构化解析模块，不应误称它直接复用了 CloudHelm 的 Tree-sitter。

测试源码中可直接看到：

- `tests/gate/analyzer/base.test.ts:611`：Git 全局选项及其值不干扰子命令提取；
- `git-rules.test.ts`：-C 的多种形式、别名和高风险 Git 操作；
- `secret-protection.test.ts`：env -C / sudo -D 后的相对路径读取；
- `git-index.test.ts`：worktree、Git 配置与 -C 的特殊判断。

这些是很有价值的回归语料，但项目的策略目标与 CloudHelm 不同：比如危险 Git 丢弃可能直接拒绝，也可能按配置在临时目录/工作树中放宽，不能机械复制其 verdict。

### 设备规则不是所有写入效果的通用证明

[`device.ts:106`](https://github.com/kenryu42/cc-safety-net/blob/5b0fc4731aad33b88d2e91b4970eb34821cc67fa/src/gate/analyzer/device.ts#L106) 明确处理 dd、格式化、分区/擦除、shred；`:129` 处理写磁盘设备的 Shell 重定向。

在已读内置设备模块及 tar 相关搜索中，没有找到通用的 tar -f 输出设备效果解析。tar 还用于敏感文件归档识别，这与“识别归档输出写设备”不同。**不能据此断言该项目完整管线一定允许/拒绝某条 tar 命令**：自定义规则、其他阶段与配置可能介入，本轮未执行验证。

### 失败策略与接入限制

分析器区分 invalid / partial / limited；严格档对 partial 拒绝，部分非严格路径有不同降级处理。管线依赖失败、解析限制等也有独立原因和决策，不能仅凭一个 fail-closed 标签概括所有模式。

**建议**：优先吸收模块设计和测试。若复用其分析内核，要显式接入远端事实快照及后台策略，避免公开 API 自动加载本机环境/配置。其 PathResolver 等接口是同步的，不能简单把异步 SFTP 函数塞进去；缺失事实应保持不确定，由 Application 有界补充，而不是阻塞控制通道等待任意远端查询。

## 3. sh-guard：确实有 AST 和 Node 绑定，但它是评分器

### 实际入口和输出

MIT 不是它的许可证。`crates/sh-guard-core/Cargo.toml` 明确写 GPL-3.0-only，LICENSE 是 GPLv3。引入/分发需核对义务，不作法律兼容性保证。

`crates/sh-guard-napi/src/lib.rs` 确实提供 classify、risk_score、risk_level、classify_batch；不必仅以外部 CLI 形式考虑，但 N-API/Electron 构建及跨平台打包没有实测。

核心结果包含 score、level、quick_decision、reason、risk_factors、sub_commands、pipeline_flow、parse_confidence。

[`scorer.rs:9`](https://github.com/aryanbhosale/sh-guard/blob/92005d65b1232946924b524bcad267a29d8a2cb5/crates/sh-guard-core/src/scorer.rs#L9) 的实际评分组合包括：

- 意图权重；
- 目标范围与敏感度；
- 危险参数修正、可逆性、上下文修正；
- 注入/Zsh 模式；
- 多段命令最大值及管道组合结果。

这比“看危险关键词”丰富，但分数不是执行批准，也不是确定性灾难规则的替代品。

### 几个必须知道的边界

- [`lib.rs:161`](https://github.com/aryanbhosale/sh-guard/blob/92005d65b1232946924b524bcad267a29d8a2cb5/crates/sh-guard-core/src/lib.rs#L161)：Fallback 在原分数上加 10，Partial 加 5；不是解析不完整一律拒绝。
- `analyzer.rs:133` 的危险参数匹配仍对 raw 文本 split_whitespace 后匹配规则，不是每种工具都具备完整参数语义。
- `analyzer.rs:147` 按像路径的操作数和重定向收集目标，没有统一地将每个目标标成输入或输出；不能推定完整识别 tar 输出语义。
- `analyzer.rs` 明确有注释：注入检测暂时未做真正的引号剥离，可能产生保守误报。
- `classify()` 会自动发现本机 project_root/cwd/home 下的规则文件；不能当作远端可信配置。
- `classify_with_rules()`、`classify()` 的自定义规则处理入口不同；集成前应明确选哪一个、谁控制配置，而不是只看 API 名。

**建议**：借鉴可解释结果、风险因子和管道组合。若用于 CloudHelm，必须额外保持 hard deny、解析失败处理、证据完整度与权限决定；不能只写 `score < 某阈值就执行`。

## 4. bash-guard：权限位模型值得参考，文本扫描不能替换现有 AST

`Cargo.toml` 声明 0.3.0、MIT，LICENSE 已核对。

[`policy.rs:88`](https://github.com/lloydzhou/bash-guard/blob/1bac41bcb2e02f49d0df6c637943547e676cd24d/src/policy.rs#L88) 将需求分成 system / external / network / workspace 四组读写执行位，再与允许位做包含判断。

但实际 `scan_script()`（`:408`）是替换连接符/分号后逐行扫描，`scan_segment()` 使用 split_whitespace、命令前缀和正则。它不是完整 Shell AST 解析器，引号、命令结构和目录作用域不能按完整 Shell 语义保证。

[`main.rs:103`](https://github.com/lloydzhou/bash-guard/blob/1bac41bcb2e02f49d0df6c637943547e676cd24d/src/main.rs#L103) 还有明确模式差异：

- 7777 直接跳过本地/Jev 风险审查，但仍处理审计失败；
- Jev 成功时用其 required_mode 决定是否允许，不是与本地拒绝取最严格结果；
- Jev 出错时回退本地策略，本地允许时可以继续。

它对无效 Hook 输入、缺失字段、审计故障的拒绝路径是真实存在的，但不能扩展解读成“任何分析不确定性都拒绝”或“本地禁令始终不能被模型改变”。

**建议**：参考权限位、输入验证、审计与客户端适配；不要整套替换 CloudHelm，特别不要复制到完全访问档后关闭硬禁令。

## 5. Codex execpolicy：明确的策略匹配，不是命令危险语义库

根 LICENSE 是 Apache-2.0。

`execpolicy/src/policy.rs` 的 check 接收 argv 和调用方提供的 heuristics_fallback；没有匹配规则时交给 fallback。`decision.rs` 的顺序是 Allow < Prompt < Forbidden，多个匹配取最严格结果。

它适合参考：规则表示、匹配证据、justification、规则融合与可测试性。它本身不会自动解决 tar 输出含义、Shell 作用域、远端路径、用户授权与精确批准绑定。不能从完整 Codex 的能力推断 execpolicy 单模块具备所有能力。

## 6. OpenHands：本次还找到了确定性分析模块

根 LICENSE 是 MIT，当前 security 目录不只有 LLM/ToolShield：

- `defense_in_depth/pattern.py`：可执行参数与 thought/reasoning 分开建语料；破坏性 Shell 模式只扫描真正执行的字段，注入模式另行处理。
- `defense_in_depth/policy_rails.py`：fetch-to-exec、raw-disk-op、catastrophic-delete 三类组合规则；相关结构无法确定时返回 UNKNOWN。
- `RailDecision` 注释明确说明 LOW 只是没有命中这些规则，不是普遍安全或授权结论。
- `ensemble.py`：异常按 HIGH；默认 propagate_unknown=False，有具体风险时过滤 UNKNOWN；严格模式可开启 UNKNOWN 传播。
- `confirmation_policy.py`：风险分析结果与是否确认分开；存在 AlwaysConfirm / NeverConfirm / ConfirmRisky，因此 HIGH 本身也不等于不可覆盖的硬拒绝。

已读 raw-disk rail 重点是 mkfs 和 dd，不能把它描述为所有工具写设备都覆盖。

**建议**：这套“可执行内容 vs 讨论内容”“组合风险”“明确 UNKNOWN”“风险与确认分离”值得吸收；不必为此引入整个 Python Agent SDK。SDK 的 MIT 不推导其可选 ToolShield 等全部外部依赖许可。

## 7. dcg 许可证结论已从检索升级为原文核对

根 LICENSE 的实际标题是 `MIT License (with OpenAI/Anthropic Rider)`，正文确有特定主体及向其提供访问的限制，且把分析、测试等也列入其定义。

因此不按普通 MIT/标准开源依赖推荐。本轮只阅读根许可证，不审查实现、不做测试、不从它复制代码。许可解释或使用授权应另行取得专业意见/权利人确认。

## 8. 更新后的选择与实施顺序

| 目标 | 优先参考 | 不应做的事 |
|---|---|---|
| 修 Git 全局参数误分类 | cc-safety-net 的 git/parse.ts 和测试 | 继续只看 args[0] |
| 修 env/sudo 的目录传播 | cc-safety-net 的 wrapper-prelude 与分析状态 | 只剥掉包装器，不传播 cwd |
| 补设备/文件输出语义 | 结合现有 SafetyGate 自建小型效果模型 | 假设某个守卫已覆盖所有 tar/cp/解释器形式 |
| 丰富风险解释 | sh-guard 的结果类型和因子 | 用低分代替授权 |
| 定义策略匹配优先级 | Codex execpolicy | 无条件套用前缀允许 |
| 组合检测与确认 | OpenHands 的 rails/ensemble/policy | 忽略 UNKNOWN 或把模型自评当强安全边界 |
| Hook 故障和审计 | bash-guard | 将其文本扫描视为完整 AST |

建议继续保留 Tree-sitter + Pi + SafetyGate，只在 adapters/core/application 的既有边界内增加小模块。现阶段先修已复现的三类缺口，再决定是否引入外部库。禁止未经明确设计就新增永久前缀授权、自动安装全局 Hook 或向审核模型开放任意远端读写。

## 9. 可复核性与未验证项

- commit、克隆来源和范围：clone-manifest.json；
- 已读关键文件的工作副本 SHA-256：source-review-files.json；
- 本轮不声称运行过第三方测试，不提供性能或检测率排名；
- 不把未找到的规则等同于已证明的漏洞；
- 克隆成功不等于供应链、完整依赖许可、Electron 打包与 SSH 运行行为已通过验收；
- 未修改 CloudHelm 的业务代码、依赖或现有未提交改动。
