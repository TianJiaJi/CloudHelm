# 命令审核开发参考：Trae 制品线索与 CloudHelm 实测

测试已统一迁入 [Tests/](../Tests/README.md)。下列阶段数字保留为历史证据；当前完整验证以 [STATUS.md](STATUS.md) 为准。原临时会话交接已清理，正式设计、固定源码研究及回归入口继续保留。

## P0 实施补记（当前源码）

交接中的三类分类缺口已修复；下文第 4 节、历史探针表格和“本轮未改业务代码”描述保留为**修复前研究记录**，不能当成当前分类结果。`.cache` 原始观察报告未被新结果覆盖。

当前实现：

- `adapters/command-semantics/git.ts` 共享解析真正子命令、全局选项和值以及符号化目录变换。`git -C/-c … reset --hard` 在三档中维持 ask/evaluate/ask；未知选项、别名、执行相关配置等保持 partial，不读取本机 Git 配置或展开别名。当前仅将 `core.quotepath` 的明确布尔配置作为无害配置识别。
- `adapters/command-semantics/tar.ts` 区分创建、列出、解压，提取归档/成员的读写角色。创建归档的输出进入磁盘设备、关键文件及方向性保护路径检查；正常字面归档仍可自动允许。解压成员、文件列表和不支持的参数保留未知，不能由解析参数宣称已经检查归档内容或防住路径穿越。
- `adapters/command-semantics/collect.ts`、`wrappers.ts` 根据 AST 保存调用上下文与原文范围；env/sudo 的 chdir 仅传播到内层调用。子 Shell、命令替换不污染兄弟命令；条件、函数、管道等不支持的最终状态显式未知。请求身份不代表认证成功，chroot/login 等不确定上下文不伪造为入口目录。
- Core 的 `CommandDirectory`/`CommandSemantics` 及纯解析函数只处理词法信息，入口目录来自 `OperationScope`，不是本机 cwd/realpath。`coverage=complete` 仅指支持的参数语义已覆盖，不代表所有运行时效果安全或已验证远端文件身份。
- 缺失或部分语义不能走普通有界/只读快速通道；已识别硬禁令与高影响优先，其他不透明性仍按原三档路由处理。第三档仍允许部分不透明操作，没有暗中改为所有未知都拒绝。
- 改变 cwd 的脚本暂不交给按入口 cwd 读取的 ScriptInspector，以免审核错误文件；保持不透明路由。未增加 sudo 执行器支持范围，未修改原命令、fingerprint、精确批准或远端执行机制。

正式回归入口：`Tests/adapters/command-semantics.test.ts`、`Tests/adapters/command-semantics/*.test.ts`、`Tests/core/{command-semantics,safety-semantics}.test.ts`、`Tests/application/safety-gate-semantics.test.ts`。均使用解析文本或假执行器，无真实 SSH/危险命令执行。

验证过程：初始 64 项新回归中 46 项如预期失败，确认测试确实命中修复前缺口；随后新增类型、参数角色、上下文、脚本与 Gate 边界用例。首次默认并发全仓测试发现一个真实兼容回归：纯诊断 `a || b` 被误标为 cwd 未知；已修正为只有可能改变 Shell 状态时才保守处理，并增加专门回归，45 项既有诊断测试重跑通过。带 cd 的失败分支仍保持未知，未扩大免审能力。

并发运行还观察到原有 `PiConversationSession.dispose()` 异步删除临时目录的 Windows EPERM 未处理错误；修复命令分类时未忽略错误或改动该代码，提权/恢复两文件独立串行复跑 6 项通过，但整个串行集仍复现错误。用户随后通过结构化确认授权追加本地清理修复，见下文。

### 验收过程与已解除的阻塞

- 新增 7 个测试文件，共 109 项语义/策略/执行边界测试；均已通过。
- 追加清理修复前的 `pnpm exec vitest run --maxWorkers=1 --no-file-parallelism`：**148 文件、1531 项断言通过，7 文件/19 项按配置跳过**；仍有 **10 个临时目录 EPERM 未处理拒绝，进程退出码 1**。没有剩余断言失败，但不能报告为全仓测试通过。
- 清理修复前的错误定位到 `packages/adapters/src/pi-session.ts` 原有 `dispose()`：`void rm(this.cwd, { recursive: true, force: true })` 没有等待或接住删除错误；测试 finally 与 fixture afterEach 还会重复 dispose，可能并发删除同一目录。隔离小集偶尔通过，整个串行测试集仍可复现，故不能将它解释成仅测试文件并行问题。未读取真实用户数据库、凭据或私钥。
- TypeScript、ESLint、依赖方向、源文件行数检查及桌面构建最终全部通过；最终条件分支与清理修复均已纳入复核，不依赖先前失败测试链之后未执行的命令冒充验证。
- 上述串行结果仅为追加清理修复前的阻塞记录。用户另行授权处理清理问题后，最终默认并发全仓测试已通过，原阻塞解除。未关闭 Vitest 的未处理错误检查，未新增排除或跳过测试。
- 没有安装依赖、运行危险业务样例、连接真实 SSH、调用真实审核模型或生成安装包；已有未提交改动保留，未提交或批量暂存。

运行记录：首次新回归 `b4baa315b`；首次定向 `b64a323fc`（断言全过但清理错误退出）；提权/恢复隔离复跑 `bab619f18`（通过）；默认全仓 `b2bca53e9`（诊断回归后已修复，另有清理错误）；追加修复前串行全仓 `b76b7d5e9`（断言全过但10个清理错误退出）。

### 用户追加授权：本地会话临时目录清理

- 新增 `adapters/session-directory-cleanup.ts`，每个 mkdtemp 目录只有一个清理 Promise；`PiConversationSession.dispose()` 幂等，重复关闭不会再次调用原生 dispose 或并发删除同一路径。
- 使用 Node rm 的有限重试（4 次，100ms 线性退避），应对短暂的 Windows 文件锁；启动失败的清理同样复用此机制，保留原始初始化异常。
- 永久失败返回明确的 failed 状态，并发出固定类别 `CLOUDHELM_SESSION_CLEANUP_FAILED` 警告，只含有限错误类别，不携带原始异常、路径或内容。不会通过空 catch 或关闭 Vitest 错误检查假装删除成功。
- 只删除创建时持有的临时目录，不删除持久会话存储，也不改变远端停止、认证或授权语义。追加 8 项专门单测，验证重复调用合并、重试参数、终态失败与脱敏警告、持久存储隔离；已通过。
- 清理修复后，原生会话、提权/恢复、诊断、Docker 查询、重试与预算等 9 个文件、51 项测试通过（`b634bc98c`），没有清理失败警告或未处理拒绝。

### 最终结果（当前源码）

- `be9e8b911`：`pnpm test && pnpm typecheck && pnpm lint && pnpm lint:deps && pnpm lint:lines && pnpm build` 完整链成功，退出码 0。
- 默认并发全仓测试 **149 个文件、1539 项通过**，另 **7 文件、19 项按既有条件跳过**，没有未处理错误。无需单 worker、忽略错误或修改测试配置来通过。
- 类型、ESLint、依赖方向（398 模块、1552 依赖）、行数检查及 Electron/Vite 桌面构建全部通过。新增语义安全与清理测试共 8 个文件、117 项。
- 仍未开展真实 SSH、真实模型、安装包或远端并发竞态验收；词法上下文与有限命令语义不是 OS 沙箱或通用 Shell 安全证明。

## 结论先行（历史研究）

CloudHelm 已有正确的主骨架：Tree-sitter Bash 解析、纯策略、独立审核、精确人工批准、执行前复核、脚本哈希校验。最值得投入的不是再换一个审核模型，而是：

1. **命令语义归一化与参数角色识别**，防止换一种写法就降低审核等级。
2. **风险发现与授权决定分开**，保留全部风险依据和未分析部分。
3. **审核证据可验证且有界**，明确知道了什么、不知道什么。
4. **变形测试**，用等价/增权写法检验分类稳定性。

本轮没有改业务代码，没有执行待测命令、连接远端或调用真实审核模型。新增探针仅将命令文本传给本地解析器和纯策略函数。

## 1. 证据等级

下文使用三种标记：

- **[源码/探针]**：CloudHelm 源码及本轮本地纯函数观察，可复现。
- **[制品线索]**：Trae CN 3.4.9 的 JS、原生字节、源码路径/诊断/类型文本；原生字符串不等于已恢复函数或证明运行时拦截。
- **[建议]**：适合 CloudHelm 的原创设计，不宣称是 Trae 的真实源码。

Trae 版本、前端确认协议和此前 REA 记录见 [命令审核分析](TRAE_CN_COMMAND_REVIEW.md)。本轮没有完整反编译大型原生库的风险判定控制流，也没有验证 Trae 的真实命令匹配结果。

## 2. 比“黑名单 + AI”更细的 Trae 实现线索

### 2.1 Shell 提取、路径检查和命令规则分模块

**[制品线索]** harness.dll 可定位到：

```text
permission/src/command_safety/analysis.rs
permission/src/command_safety/extract_shell_cmds/{bash,fish,powershell,mod}.rs
permission/src/command_safety/is_dangerous_command/{mod,path,cp}.rs
permission/src/command_safety/immutable.rs
permission/src/command_safety/deny_list.rs
```

邻近数据包含复制/移动类命令、重定向、命令包装和选项相关文本，例如 --target-directory、--no-target-directory、Git 的 -C/-c/--work-tree，以及绝对 cwd 要求。

这支持“分层提取语法，再理解路径和命令参数”的架构判断，但不证明每个选项的具体处理算法、顺序或完整覆盖。不能直接将邻近字符串拼成一份未经验证的 Trae 白名单。

**[建议]** 对 CloudHelm，最重要的不是再往 ORDINARY_COMMANDS 加名字，而是给高价值命令族定义参数语义：

- Git：全局选项、真正的子命令、作用目录、影响工作树的动作。
- cp/mv/install：源、目标、目标目录选项、递归/覆盖语义。
- tar：读取归档还是创建归档、归档输出位置、解压目标。
- env/sudo/timeout 等包装：可执行文件、工作目录/身份变化、剩余参数。

未知选项不能被静默当成“不影响语义”。

### 2.2 分析器有资源预算与覆盖信息

**[制品线索]** 明确出现这些错误/诊断类别：

- 单个脚本过大、累计解析字节过多；
- 嵌套 Shell 深度、AST 节点、命令、管道数量超限；
- 拒绝规则数量、正则长度超限；
- command analysis worker failed；
- elapsed_ms、segments、ast_nodes、commands、pipelines、parsed_bytes、deny_hits、known_safe。

具体数值上限未恢复。

**[建议]** 除安全判定外，要记录 `coverage` 和资源消耗。解析器自己被复杂输入拖垮，也是执行系统的可用性问题。

### 2.3 脚本不是只在执行时看一次

**[制品线索]** 可见 script_safety/file_review.rs、script_safety/file_effects/mod.rs、post_write_safety_finding，以及 ScriptSafetyFinding 的 path/rule/command 字段。

这支持脚本内容与文件效果存在额外检查阶段的推断，但不能证明所有写入/上传/执行入口都被统一拦截。

另有明确诊断：脚本文件审核超时后继续普通权限检查。它不等于“审核超时直接放行”，说明需要分清可选补充检查与最终权限门禁。

**[建议]** 脚本内容风险、脚本执行许可和文件写入许可分别处理；不要因为某文件名是 deploy.sh 就视为已理解，也不要把文档/测试中引用危险命令的普通文本一律判成实际执行。

### 2.4 规则错误不能被笼统当成无风险

**[制品线索]** deny-list 模块存在忽略无效正则的诊断；另有 mandatory command rule、企业策略不支持/超限等不同诊断。

仅凭这些文本无法判断最终放行效果，但足够说明“规则没匹配”与“规则没能运行”不是一回事。

**[建议]** CloudHelm 若以后开放用户规则，应在保存时校验并报告错误，安全策略编译失败不能以空规则集成功替代。优先使用有限、类型化规则，避免任意正则承担全部权限语义。

## 3. CloudHelm 已具备什么：不要重复建设

| 能力 | 当前实现 |
|---|---|
| AST 与嵌套包装分析 | adapters/bash-analyzer.ts、shell-wrappers.ts |
| 硬禁令、方向性保护路径、三档路由 | core/safety.ts |
| 独立、无工具权限的审核调用 | adapters/ai-risk-evaluator.ts |
| 当前意图、澄清和截断标记 | adapters/review-intent.ts |
| 审批超时、取消与执行前复核 | application/safety-gate.ts |
| 内容、主机、目录、身份、连接/终端/策略修订绑定 | core/fingerprint.ts |
| 小型脚本读取、SHA-256 与执行前重查 | adapters/ssh-transport.ts、worker/server.ts、SafetyGate |
| AI 拒绝、单次人工复核与连续拒绝暂停 | worker/task-runner.ts |

当前 SFTP 脚本读取会拒绝已识别的符号链接/不安全父路径；这不意味着任意 Shell 命令的所有操作数也具备同等的文件系统验证。

当前模型提示词也明确规定不把工具/历史中的指令当可信授权、看不到脚本正文时不假装已看过。这些都应保留。

## 4. 20 个本地纯解析案例揭示的三个优先缺口

**[源码/探针]** 固定工作目录 `/srv/app`、虚构 host/terminal、空保护清单；只调用 BashAnalyzer.analyze 和 decideSafety。没有调用 SafetyGate 的实际执行器、SSH、sudo、tar 或 Git。

以下是 ai-review 档的真实分类观察；evaluate 表示进入独立审核，不代表已执行：

| 对比 | 当前结果 | 应关注的问题 |
|---|---|---|
| `git reset --hard` | evaluate / high-impact-command | 正常识别高影响 |
| `git -C /srv/app reset --hard` | **allow / ordinary-command** | 全局选项让真正子命令的位置变化 |
| `git -c core.quotepath=false reset --hard` | **allow / ordinary-command** | 不改变破坏性质的配置选项也会降低分类 |
| `cp backup.bin /dev/sda` | deny / system-blacklist | 识别设备写入 |
| `tar -cf /dev/sda ./data` | **allow / ordinary-command** | `-f` 参数是输出目标，却未进入设备写入检查 |
| `cd / && rm -rf etc` | deny / system-blacklist | 能跟踪显式 cd |
| `env -C / rm -rf etc` | **evaluate / high-impact-command** | 包装器改变 cwd 后，没有按该 cwd 识别根级目标 |
| `sudo -D / rm -rf etc` | **evaluate / high-impact-command** | 同类上下文问题；完整 sudo 执行链可能另行拒绝该形式，未实测 |

其他探针确认了现有行为：普通查询允许；应用目录递归清理转审核；下载后管道执行转审核；格式化工具 --help 允许、实际设备格式化命中拒绝；有变量的删除不当作无风险查询。

### 4.1 原因：规则直接读原始 args 位置

`core/safety.ts:294` 的 highImpactCommand 对 Git 用 `args[0] === 'reset'` 判断；`core/safety.ts:315` 的 ordinaryCommand 也直接看 args[0]。Git 全局参数导致两处都看不到真正子命令，最后落入普通命令允许。

**[建议 / P0]** 共享一个 Git 参数解析结果，禁止高影响和普通允许各自解释原始参数。未知全局参数的结果应更保守，而不是默认普通。

### 4.2 原因：输出目标未统一建模

`core/safety.ts:73` 的 hardCommandReason 对部分工具和 Shell 重定向检查设备写入，但 tar 的 `-f` 输出没有进入同一目标集合；ordinaryCommand 又可直接允许 tar。

**[建议 / P0]** 将工具参数产生的写目标与 Shell `>` 产生的写目标统一进入效果检查；至少先覆盖归档、复制、截断、设备写入等高价值语义。tar 创建、列出和解压应分别建模，不能只看工具名。

### 4.3 原因：解开包装器不等于继承了其执行上下文

`shell-wrappers.ts:33` 认识 env -C / sudo -D 等带值选项，但 wrappedCommand 主要负责跳过参数、提取内层命令；hardCommandReason 只对显式 cd/pushd 更新 cwd。

**[建议 / P0]** 给内层命令附带 effectiveCwd/effectiveIdentity 的确定性状态；暂时不支持的上下文变换保留 unknown，不能用外层 cwd 计算出一个貌似精确的安全目标。

**边界**：上述已证明的是分类层覆盖缺口，不是已验证远端可利用漏洞。本轮没有证明真实执行器接受所有形式，也没有让任何设备或系统目录承受测试。

## 5. 建议的核心升级：从“调用列表”到“效果与上下文 IR”

**[建议]** 保留原始 command 字节用于执行和 fingerprint；下面的归一化只服务于分析，不应在批准后偷偷改写命令。

```ts
interface CommandEffect {
  callId: string;
  sourceRange: [number, number];
  executable: string;
  subcommand?: string;
  effectiveCwd: { state: 'known'; path: string } | { state: 'unknown' };
  identity: { state: 'known'; account: string } | { state: 'unknown' };
  effects: Array<{
    kind: 'read' | 'write' | 'delete' | 'execute' | 'network' | 'change-access';
    target?: string;
    targetState: 'literal' | 'dynamic' | 'unresolved';
  }>;
  coverage: 'complete' | 'partial';
  unknownReasons: string[];
}
```

按有限语义实现，不尝试静态求解整个 Shell：

1. 用 AST 保留语法和源范围，不按分号/空格硬拆。
2. 解开已知包装，传播确定的 cwd/身份，未知部分显式保留。
3. 命令族解析器识别子命令、选项值、输入/输出操作数。
4. Shell 重定向也变成 read/write 效果。
5. 分支、子 Shell、函数和动态展开保留控制作用域；不要把一个扁平 calls 数组当成真实执行路径。
6. 同一套效果结果同时供硬禁令、保护路径、低风险、影响分类和审核模型使用。

短期可只针对 Git、tar、env/sudo 做小模块，逐步迁移；不建议一次性重写整个解析器。

## 6. 风险发现与最终授权分开

**[建议]** 当前 SafetyDecision 主要返回单条 ruleId/reason，适合决定路由，不足以表达多条同时存在的事实。

增加由后端维护的 RiskFinding 列表：

- 来源：确定性规则、资源边界、补充证据、独立 Reviewer；
- 效果：删除、覆盖、联网、执行未知内容、变更访问控制等；
- 命中目标及参数源范围；
- 证据完整度、未知原因；
- 规则能否人工覆盖；
- 与哪份 operation fingerprint/evidence digest 绑定。

最终仍由纯策略与 SafetyGate 作决定：

- 硬禁令不能被 AI allow、人为改按钮或普通批准覆盖。
- 分析组件失败不同于“业务效果未知”；前者不能降格成放行。
- 证据不完整不能在界面显示为“已证明安全”。
- 普通操作依然可自动执行；不要把改造变成所有命令都弹确认框。
- 现有三档语义与用户只批准精确单次操作的原则继续保留；不照搬 `git *` 之类永久放行。

## 7. 让审核器得到更好的证据，而不是给它更大的权限

**[源码/探针]** 当前 reviewState 提供命令/AST 摘要、主机、目录、目标和近期动作；脚本只提供 SHA-256，不提供源码。近期动作最多 5 条，每条截到 800 字符。reviewIntent 对目标/澄清已有截断和省略标记，值得复用。

SHA-256 只能标识内容，不能证明其效果。现有测试还明确允许独立审核器在 ai-review 档自动批准无法读取的脚本；这是当前策略选择，不应包装成已完成内容验证。

**[建议]** 先保持当前“不把文件正文发给审核模型”的隐私边界，由 Application 收集有限的后端事实：

- 目标路径是否存在、是否普通文件/链接/设备；
- 脚本大小、编码、SHA-256、解析是否完整；
- 已识别的效果、硬规则命中与不能分析的内容；
- 目标/近期动作是否截断，省略了多少记录；
- 证据的来源、采集环境、连接代次与有效期。

这些可作为 EvidenceRef 关联到本次操作。不能让审核模型任意指定 SSH 路径读取，更不能授予 Bash 或写文件工具；密码、验证码、私钥和受保护文件保持现有禁止边界。

如果未来确需发送脚本正文，必须先单独设计显式隐私授权、范围、脱敏、审计与配置变化失效，不作为本次默认建议。

Reviewer 返回值可增加风险和授权理由、证据引用；但“模型声称获得授权”不是实际批准，完整度也应以后台事实为准，而不是让模型自评一个 confidence 就升级权限。

## 8. 文件身份与 TOCTOU：不要过度承诺

**[源码/探针]** literalPath 使用词法路径归一化；SFTP 结构化操作和脚本检查另有拒绝符号链接的措施，但它们不构成任意 Shell 参数的文件系统隔离。

**[建议]** 用明确的 RemotePathFacts 端口采集必要的元信息，在与执行相同的主机/身份/命名空间语境下解释；不能用本机 realpath 或另一容器的路径事实批准 SSH 操作。

脚本可保存 `host + path + contentSha256 + interpreter + policyVersion` 的检查记录；执行前仍重查，并将审核依据的 evidence digest 与授权关联。目录扫描要有条目和时间上限，超限记录 unknown，不能当成未命中。

读取元信息与真正执行之间仍存在竞态。重复 stat/hash 只能缩小窗口，不是原子执行。把脚本复制到固定目录再执行也会改变相对路径、BASH_SOURCE 等语义，不能在批准后暗中替换；若要采用，必须作为显式的新执行模式设计并重新绑定。

远端最小权限、备份、审计和未知结果写锁仍然必要；不要宣称以上改进能提供 OS 沙箱级保证。

## 9. 性能与失败策略

**[源码/探针]** 当前 BashAnalyzer 已有限制：命令长度 65,536、嵌套 Shell 深度 4、每层包装展开有界；小型脚本读取上限 65,536 字节。

**[建议]** 再补累计解析字节、AST 节点、调用/管道数、证据读取总量和耗时统计。具体阈值应基于本项目测量，不把 Trae 未恢复的数值编造成默认值。

Tree-sitter 是同步 CPU 工作，Promise.race 超时不会中断解析；需要硬时间预算时，应考虑受控的解析 worker，让超时不会堵住 Agent/SSH 的控制通道。取消或解析 worker 故障返回分析不可用，不自动切到无审核执行。

## 10. 最有价值的测试矩阵

**[建议]** 先写回归用例，再修复规则；本轮探针记录当前行为，不是永久的安全通过标准。

| 测试族 | 不变量 |
|---|---|
| Git 全局选项前置 | 同一高影响子命令不能因 -C/-c 前置变普通 |
| 复制/归档/重定向 | 同一设备/保护目标不会因输出写法不同漏检 |
| cwd/身份包装 | 确定的上下文变化被传播；不确定时不伪造目标 |
| 引号与字面编码 | 只改变表达形式不降低已识别风险；不执行文本求值 |
| 命令链与子 Shell | 守住作用域/条件，不将无关步骤的 cwd 错用于另一命令 |
| 动态变量/替换 | 解析成功不等于效果已知 |
| 脚本修改与并发替换 | 内容/身份变更使旧证据与批准失效 |
| Reviewer 输出缺字段/引用不存在 | 不承认其虚构证据，不绕过原有失败策略 |
| 资源预算超限/解析器故障 | 不执行、保留原因；不把取消当正常完成 |
| 规则更新/断线/接管 | 继续验证现有精确授权与未决结果写锁 |

这是“变形测试”：从一个已知案例自动生成包装、选项和表示变化，检验语义相关的不变量。它比持续手工增加几个危险关键词更容易发现结构性缺口。

## 11. 建议实施顺序与模块边界

### P0：先补已观察到的分类缺口

- Git 全局选项/子命令解析，并同时用于高影响和普通允许规则。
- tar 等工具输出目标进入设备/保护路径检查。
- env/sudo 的上下文变换传播；暂不支持的形式保守处理。
- 先用本轮三组对照案例建立有正确期望的正式回归测试。

### P1：统一风险解释与分析覆盖

- Core 定义 CommandEffect、RiskFinding 和纯策略，拆小模块，不扩成万能安全工具类。
- Adapters 负责 Tree-sitter 与命令族提取，Application 编排证据与授权。
- 审核卡优先显示动作、真实目标、为何要审、证据缺口；详细 AST 放折叠区。
- Renderer/preload 仅通过 contracts 投影状态，不决定接收方、批准或执行权。

### P2：证据与脚本检查生命周期

- 增加受限的 RemotePathFacts/ScriptFacts 端口与证据摘要。
- 绑定摘要、有效期、连接/策略代次，保持现有执行前复核。
- 需要持久化的新字段使用版本化迁移；不在此过程中升级或更换依赖版本。

### 暂不优先

- 全量复制 Trae 的沙箱/VM 或多 Agent 审核团队。
- 给审核模型开放任意 Read/LS/Bash。
- 持久“始终允许某命令前缀”。
- 用 AI 置信度替代确定性规则，或把重试当作未知远端结果的恢复方式。

## 12. 验证、来源与限制

本轮验证：

- 20 个命令文本案例的本地解析/分类观察，包含在 **1 个探针测试**中；完成不表示这些分类全都符合安全预期。
- 现有 7 个安全相关测试文件 **232 项通过**；不是全仓库测试，也不是 SSH/模型/沙箱集成验收。
- 首次探针因 Vitest 默认排除 .cache 未执行，已修正仅用于探针的配置并重跑成功。
- 后台完成记录：`b0b44c209`。

产物：

```text
.cache/trae-command-audit-analysis/cloudhelm-risk-probes.json
.cache/trae-command-audit-analysis/risk-probes.test.ts
.cache/trae-command-audit-analysis/probe.vitest.config.ts
.cache/trae-command-audit-analysis/cloudhelm-source-snapshot.json
.cache/trae-command-audit-analysis/native-internals.json
.cache/trae-command-audit-analysis/native-deep.json
```

其中 native-deep 记录原件 SHA-256、精确字节范围和片段哈希；native-internals 的 LEA/PE unwind 候选仅是分析线索，未经引擎确认，不作为恢复原生调用链的证据。原生完整分支、策略优先级和真实可达性仍未证明。

CloudHelm 关键位置：

- `packages/core/src/safety.ts:23`、`:73`、`:294`、`:315`、`:345`、`:379`；
- `packages/adapters/src/bash-analyzer.ts:93`、`:118`；
- `packages/adapters/src/shell-wrappers.ts:33`、`:44`；
- `packages/adapters/src/ai-risk-evaluator.ts:40`、`:52`、`:70`；
- `packages/application/src/safety-gate.ts:114`、`:157`、`:174`；
- `packages/core/src/fingerprint.ts:4`。

这是开发研究与改造建议，不是已完成修复或完整安全审计。保留仓库已有未提交改动，本轮未修改业务实现。
