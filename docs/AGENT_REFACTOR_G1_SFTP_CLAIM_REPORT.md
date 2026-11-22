# G1-J 子批报告：SFTP 文件路线的分步准入核验

> 对应交接文档 §3.2“其余执行路线的启动许可”的 SFTP 文件部分。原则不变：预检是只读步骤不消费写许可；写交接点（`writeFile`/`deleteFile` 调用前）单次消费许可；许可绑定主机、解析后目标路径、操作 kind 与确切内容哈希（删除仅绑定路径）。

## 交付内容

- `packages/core/src/ports.ts`：新增 `FileStartTarget`（hostId/path/operationKind/contentSha256?）与 `ExecutionOptions.claimFileStart` 单次许可回调，与命令路线的 `claimStart` 并列、类型显式分离。
- `packages/core/src/file-start-target.ts`（新）：纯规则 `structuredFileTargetOf`——对 upload / 无 fileEdit 的 write-file / delete-path 计算被审写目标（统一 `path.posix.resolve(scope.cwd, …)` 解析与内容哈希推导），受控文件事务与只读文件 kind 返回 undefined。gate 与执行器共用这一条解析规则，消除漂移。
- `packages/application/src/safety-gate.ts`：为结构化文件写铸造 `claimFileStart` 单次许可（首次调用即闭合并判定绑定；执行器链完成后一次性失效）；post-fill 镜像命令语义——消费 ⇒ `handed-off`，未消费 ⇒ `not-sent`/`not-started`，`succeeded && exitCode===0` 才补 `started`。
- `apps/desktop/src/worker/file-operation-executor.ts`：在 `authorized()` 复核之后、`writeFile`/`deleteFile` 派发之前消费许可，绑定实际发送字节的 sha256（upload 用本地复核后的内容、write-file 用被审内容）；拒绝即 `not-dispatched` 关闭边界，不发送任何字节。readFileForEdit 预检与写后读回复核均不消费。

## 关键设计决定

- **写交接点是唯一的许可消费点**：结构化 SFTP 路线的多步 IO（本地重读 → 版本预检 → 写/删 → 读回复核）中，只有 `writeFile`/`deleteFile` 是对被审目标的变更交接。预检失败、哈希不匹配、createOnly 冲突等更早退出均不消费，gate fill 仍给出 `not-sent`/`not-started`。
- **内容哈希绑定到实际字节**：执行器消费时对 `intended` 缓冲现算 sha256，而非照抄操作字段——本地文件被调包、内容字段与实际字节不一致等缺陷会被许可拒绝。
- **受控文件事务不铸造**：write-file 带 fileEdit 的多阶段事务（暂存→校验→发布→读回）每一步已有 `current()` 复核与阶段化拒绝，其发布交接深嵌于适配器事务内部；本批保持每步复核原样，不为它铸造未消费即虚报 `not-sent` 的许可（gate 对其不 fill）。
- **执行器链透传已验证**：生产链 SafetyGate → HostSerialExecutor（options 原样透传）→ PermissionAwareExecutor（非命令原样透传）→ FileOperationExecutor，许可不经序列化、不进模型上下文。

## 验证

- 新契约文件 `Tests/desktop/worker/file-write-start-claim.test.ts`（10 项）：预检先行与写交接点单次消费（事件序）、拒绝零派发、预检拒绝不消费、delete-path 仅绑定路径、upload 绑定本地复核哈希、gate 铸造/消费填充、未消费 `not-sent`/`not-started`、绑定不匹配拒绝且不标记消费、受控事务/命令/只读 kind 不铸造、执行器链结束后许可不可复活。
- 局部回归 144 项通过、0 失败（文件执行器 14、文件事务/预览/受控服务 9、safety-gate 三套 36、sftp 两套 17、启动许可契约 35、native-ssh-gate 3、新契约 10、命令终端/后台 29）；`pnpm typecheck` 与四项 lint 全部通过。

## 未完成与风险

- 三模式裁决契约（§3.3）未开始；本批完成后 §3.2 全部四条执行路线（exec/PTY/会话/后台/SFTP）启动许可均已接入。
- 全量串行回归与 `pnpm build` 留待 G1 收尾统一执行；真实主机验收未开展。
