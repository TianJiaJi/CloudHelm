# SPIKE-C：edit_file Layer C（推翻覆盖禁令）可行性备忘录

- 状态：**NO-GO**（判据①②③全部成立，判据一经写死未因调查结果修改）
- 日期：2026-11-21；时间盒内只读调查，未改动任何生产行为
- 输入：`docs/AGENT_REFACTOR_ROADMAP.md`（权威事实源）、Phase 0 计划 SPIKE-C 段、仓库源码与 ssh2 1.17.0 包实现核查
- 结论速览：SFTP 直接覆盖既有文件在"原子发布"前提下必然丢失 ACL/xattr 且无法经 ssh2 补齐；受控事务路径以 ≤3 人日即可覆盖全部冻结场景清单（唯一缺口是大 diff 整文件重写）；"元数据未验证仍提交"无法经现有 `commit-operation-risk` 通道补正。C 明确降级不做，痛点由 A+B 承接。

## 一、三层风险回顾

| 层 | 内容 | 风险 | 处置 |
|---|---|---|---|
| A 门面重塑 | 单一 `edit_file` 内部编排 read(hash)→prepare→apply，内部仍是独立 ProposedOperation 逐个过 SafetyGate | 中 | Phase 2 路线图项（前置：Phase 1 IntentManager 稳定） |
| B 自愈语义 | hash 冲突时门面自动读当前内容返回模型重生成 diff | 中低 | Phase 2 与 A 同批 |
| C 推翻覆盖禁令 | 允许既有文件的直接覆盖提交 | 高、前置未知 | **本备忘录门控：NO-GO** |

## 二、冻结清单（开工前写死，不因调查结果修改）

### 2.1 目标发行版清单（判据①适用对象）

| # | 发行版 | 默认文件系统 |
|---|---|---|
| 1 | Ubuntu Server 24.04 LTS | ext4 |
| 2 | Ubuntu Server 22.04 LTS | ext4 |
| 3 | Debian 12 | ext4 |
| 4 | RHEL 9 | xfs |
| 5 | Rocky Linux 9 / AlmaLinux 9 | xfs |
| 6 | openSUSE Leap 15.6 | btrfs |
| 7 | Fedora Server 41 | btrfs |

三者（ext4/xfs/btrfs）的 POSIX ACL、xattr（`user.*`、`security.capability` 等）与 inode flags（chattr）均为**逐 inode**存储。

### 2.2 已有文件编辑场景清单（判据②适用对象）

- S1 既有配置文件唯一字面替换（≤1 MiB UTF-8 常规文件、执行身份属主、无特殊权限位）
- S2 既有文件整文件重写（大 diff，>64 KiB）
- S3 root 属主既有文件编辑（privilege=root）
- S4 既有文件删除并保留恢复副本
- S5 误编辑恢复（回滚到上一版本）
- S6 无 SFTP 子系统主机上的既有文件检查

### 2.3 NO-GO 判据（三条，满足任一即 NO-GO）

1. **判据①（可量化）**：目标发行版清单内默认文件系统经 SFTP 直接覆盖路径会丢失 ACL/xattr，且 ssh2 缺所需扩展（v6 acl/ext）补齐、shell 辅助回写验证成本 > 5 人日 → NO-GO。
2. **判据②（可证伪）**：受控事务路径（A 门面 + prepare/apply）已能以 ≤3 人日覆盖"已有文件编辑"场景清单 → C 无增量价值 → NO-GO。
3. **判据③（可证伪）**：安全覆盖语义若必须依赖"元数据未验证仍提交"，且无法通过用户显式逐次风险接受（现有 `commit-operation-risk` 通道）补正 → NO-GO。

## 三、Spike 四问调查证据

### 问① `executor.supportsFileTransactions === false` 的确切条件

- 端口定义为可选能力标志：`OperationExecutor.supportsFileTransactions?: boolean`，注释明确"Driver availability only, not a grant or proof that a host supports metadata preservation"（`packages/core/src/ports.ts:57-64`）。
- 桌面装配恒为 true：普通路径 `ordinary: new FileOperationExecutor(...)`（`apps/desktop/src/worker/server.ts:116`）、root 会话 `entry.executor = new FileOperationExecutor(...)`（`privileged-runtime.ts:263`），而 `FileOperationExecutor.supportsFileTransactions = true` 硬编码（`file-operation-executor.ts:11`）；`HostSerialExecutor`（`host-serial-executor.ts:38`）与 `PermissionAwareExecutor`（`permission-aware-executor.ts:22`）只向下游透传 `=== true`。
- 结论：**生产装配中该标志恒为 true**；`false` 仅出现于未声明该字段（undefined）的执行器实现（测试替身、假想的无文件能力执行器）。**运行期 SFTP 不可用不翻转该标志**，而是经驱动回执降级：写操作在任何远端效果前拒绝 `sftp-required-for-controlled-writes`（`file-transaction-runner.ts:43`；`shell-file-inspection.ts:16,24`），检查快照如实标注 `commitSupported:false + limitation`（`shell-file-inspection.ts:82`）。提示词投影 `controlledFiles`（`task-runner.ts:152` → `remote-tools.ts:23` 决定 `FileEditService` 是否构造）因此只反映执行器形态，不反映主机能力。

### 问② 受控事务路径 ACL/xattr 读回验证的实际范围

- 摘要集刻意不含 ACL/xattr：v2 `metadataDigest = {size, mode, uid, gid, mtimeSec}`、`attributeDigest = {uid, gid, mode}`，头注"deliberately carries no ACL/xattr/device/inode promise"（`packages/core/src/file-transaction.ts:1-19`）。
- apply 发布**新 inode**：私有 0700 暂存目录内 `writeFileExclusive`（'wx'）写入候选 + `setstat` 仅复制 uid/gid/mode，再以字面 `ln` 硬链接备份原 inode、字面 `mv` 同目录 POSIX rename 发布（`sftp-file-transaction.ts:157-193`）。读回复核 = 内容 sha256 + 属性摘要（`verifyPublished`，同文件 :127-134）。**ACL/xattr/flags 既不复制也不核验也不声称**——能力边界文档明示"SFTP 无法核验或复制 ACL/xattr，apply 不声称保留它们；需要保留 ACL/xattr 的文件应人工处理"（`docs/CONTROLLED_FILE_EDITS.md` 能力边界）。
- 原 inode 经硬链接备份完整保留（inode 级 ACL/xattr/flags 随 inode 存续）；restore 把原 inode rename 回原位，属性自然恢复（`sftp-file-transaction.ts:210-272`）。
- 提交能力前置拒绝：特殊权限位或非执行身份属主不签发提交令牌（`file-transaction-protocol.ts:48-55`），apply/restore 复核属主（`ownership-preservation-unavailable`，:162/:236）。
- 历史参照：退役的固定 Python 驱动曾以"ext/XFS、xattr/flags 接口、`renameat2`、实际 UID 0+CAP_SYS_ADMIN"为完整元数据声明门槛（`docs/REPAIR_PROGRESS.md` C03），该门槛在原生 SSH 迁移中随驱动一并退役，v2 摘要集明确放弃了该项承诺。

### 问③ SFTP 直接覆盖需验证的元数据集与 ssh2 支持

- ssh2 1.17.0 只协商 SFTP v3：客户端/服务端 VERSION 报文硬编码 `0,0,0,3`（`node_modules/.pnpm/ssh2@1.17.0/node_modules/ssh2/lib/protocol/SFTP.js:104-112`），客户端面无 ACL/xattr/flags 操作（v6 草案 acl/ext 未实现，OpenSSH 亦只支持 v3）。
- 两种覆盖变体的元数据结局：
  - **temp+rename（现行发布模型）**：原子，但新 inode 替换旧 inode → 2.1 清单全部发行版的默认文件系统上 ACL/xattr/flags 丢失。这正是 `SshTransport.writeFile` 拒绝一切既有目标的根因——"lstat's mode/uid/gid cannot establish absence of ACL/xattr"，`RemoteFileMetadataError('metadata-unverifiable')` 在任何暂存动作之前抛出（`ssh-transport.ts:320-338`，错误文案 :34-39）。
  - **open(O_TRUNC)+write 原地覆盖**：inode 保留 → ACL/xattr/flags/属主天然保留，但失去内容原子性（并发读者见撕裂状态、崩溃窗口、无内置备份），与现行 staging+rename 原子发布+读回复核模型冲突；immutable flag 下 open 直接 EPERM。该变体不满足"原子覆盖"目标，不作为 C 的候选实现；其非原子语义若要引入需独立设计与门控，超出本 spike 的 GO 范围。
- 工具面现状：`write_remote_file` 仅新建，"Current backend refuses existing-file replacement because complete ACL/xattr preservation is unverified, even with a hash or root SSH. expectedSha256 is legacy and rejected before terminal allocation"（`remote-tools.ts:91`，拒绝路径 :99）；`delete_remote_file`/上传同理声明边界（:109/:138）。

### 问④ 降级语义可接受性（对照判据③）

- rename 型 C 的安全语义必然落在"元数据未验证仍提交"：SFTP v3 无法核验 ACL/xattr 是否受影响（问③既有结论），SafetyGate 分析器同样只有 stat 字段集。
- 现有 `commit-operation-risk` 通道是**事后**未知结果风险确认，不是预提交接受：`accept-operation-risk` 前置 `operationOutcomeResolvable`（操作已执行、结果未知）、10–1000 字理由、同主机较新成功只读证据（`apps/desktop/src/main/recovery-ipc.ts:28-57`），worker 侧只做写锁解除与记录回放（`server.ts:162-173`）。它不接入审批前置流程、无预提交元数据绑定，无法承担"逐次接受未验证元数据"的补正角色；引入预提交风险接受需新增接受种类并扩展 SafetyGate 审批流，不属于"现有通道补正"。

## 四、判据逐条验证

### 判据①：成立（NO-GO）

| 链条 | 证据 |
|---|---|
| 2.1 清单全部默认 FS 上 rename 型覆盖丢失 ACL/xattr | 问③：新 inode 替换；ext4/xfs/btrfs 均逐 inode 存储元数据 |
| ssh2 缺 v6 acl/ext 补齐 | 问③：ssh2 1.17.0 仅 SFTP v3，无 ACL/xattr 客户端面 |
| shell 辅助回写验证成本 > 5 人日 | 需重建退役 Python 驱动门槛（setfacl/getfacl、setfattr/getfattr、chattr、`renameat2(RENAME_EXCHANGE)` helper——coreutils 无此入口，需固定字面 Python/CTypes 驱动）并按 7 发行版 × 3 文件系统 × 元数据类别（ACL/xattr/flags）逐项读回验证 + 审批呈现 + 文档；参照退役驱动的实现与验收欠账（REPAIR_PROGRESS.md C03），估算 ≥10 人日 > 5 人日 |

### 判据②：成立（NO-GO，C 无增量价值）

S1–S6 逐项走查（A+B 流程，证据为代码路径）：

| 场景 | 走查结果 | 证据 |
|---|---|---|
| S1 唯一字面替换 | 今天已覆盖：read_remote_file → prepare_remote_edit（editId）→ apply_remote_edit（staging+ln 备份+mv 发布+读回复核） | `file-edit-service.ts` inspect/prepare/apply；`sftp-file-transaction.ts` applyTransaction |
| S2 大 diff 整文件重写 | 唯一实质缺口：diff 64 KiB 上界（`core/file-transaction.ts` `validFileEditCommit` diff ≤65,536 字节）超界拒绝 | Route A 扩展承接（下表） |
| S3 root 属主编辑 | 已覆盖：root SSH 直连驱动，`id -u`==0 复核，否则 `root-identity-unconfirmed` | `file-transaction-runner.ts:50,87-97` |
| S4 删除保留恢复副本 | 已覆盖：content-only 备份并诚实披露 ACL/xattr 不还原 | `ssh-transport.ts:363-386`；`file-operation-executor.ts:109` |
| S5 误编辑恢复 | 已覆盖：原 inode rename 回位，inode 级属性自然恢复，恢复前双重复核 | `sftp-file-transaction.ts:210-272` |
| S6 无 SFTP 主机检查 | 已覆盖：route B 只读检查，快照如实标注不可提交 | `shell-file-inspection.ts`（`commitSupported:false` + limitation） |

S2 缺口的 Route A 扩展估算：prepare 增加 whole-file-replace 模式（或提升 diff 上界），直接绑定 `expectedSha256 + attributeDigest`，复用既有 apply 发布算法与读回复核，估算 **1–2 人日 ≤ 3 人日**。场景清单全量 ≤3 人日覆盖 → 判据②成立。

### 判据③：成立（NO-GO）

- rename 型 C 必须依赖"元数据未验证仍提交"（问④）。
- 现有 `commit-operation-risk` 通道无法补正（问④：事后语义、无预提交绑定）。
- 对照红线：红线②（SafetyGate 分析能力与 fail-closed）——覆盖操作对 ACL/xattr 的影响超出分析器可见的 stat 字段集，按 fail-closed 应拒绝，放行即违反；红线④（凭据隔离）——shell 辅助回写若需提权执行，须扩展现有固定字面私密通道（可行但成本已计入判据①）；另红线③（审批绑定与执行前复核）决定事后通道不能改造为预提交接受而不新增绑定语义。

## 五、结论与处置

**NO-GO**（判据①②③全部成立）。按既定降级处置：

1. **C 明确降级不做**：不引入 SFTP 直接覆盖既有文件的提交路径；`write_remote_file`/上传保持新建边界，既有拒绝语义与提示词口径（"Current backend refuses existing-file replacement…"）不变。
2. **痛点由 A+B 承接**：Phase 2 `edit_file` 门面在受控事务可用时走 read(hash)→prepare→apply；不可用主机（无 SFTP 子系统、非执行身份属主、特殊权限位）列为已知限制并告知模型——现状已由 route B limitation 字段、工具描述与能力边界文档承担。
3. **S2 承接项进 Phase 2 候选**：大 diff 整文件重写作为 Route A 扩展（whole-file-replace 模式，估算 1–2 人日），不作为重启 C 的理由。
4. **A/B 层维持原计划**：A 门面与 B 自愈语义仍按 ROADMAP Phase 2 跟踪，红线不变。

## 六、验证范围声明

本备忘录为只读代码调查：结论基于仓库源码引用与 ssh2 1.17.0 包实现核查；发行版文件系统行为基于标准 POSIX/Linux 逐 inode 元数据语义与仓库内既有验证边界。未连接真实主机（H03 VM 验收冻结中），真实平台元数据行为不在本 spike 范围，判据证据链不依赖未实测项。
