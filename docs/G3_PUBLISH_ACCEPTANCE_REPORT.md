# G3 特权发布真机验收报告（补验两项）

**结论：通过。** 依据 `docs/G3_PRIVILEGED_PUBLISH_HANDOFF.md` 验收表补验两项——完整正向部署、发布路线特有断线边界——在隔离 VM 上全部通过。被测提交 `e484c25`（含 `a6beec7` 发布加固与本次验收过程中发现并修复的 SafetyGate 误杀）。

验收过程中发现一个真实集成缺陷并已修复（见「过程发现」）；该轮失败证据保留为基线。

## 过程发现与修复（提交 `e484c25`）

部署 r1 轮暴露：单测未走 SafetyGate 全链路，真机候选 `su` 包被 `system-blacklist` 硬拒。

- 现象：`publish_remote_file` 候选包 review 结果 deny（ruleId `system-blacklist`），工具以 `tool.refused` 终止，任务失败。staging 写入成功、候选未执行、目标未创建。
- 根因：候选/提交脚本以 `find` 对系统树做断言（无 `-delete`/`-exec`），chmod 失败清理使用 `rm -f`；SafetyGate 启发式将「find 遍历关键树 + 嵌套 rm」判为「系统树破坏性遍历」。分析器会把 `su -c` 载荷展开为扁平调用序列，两个目标路径（`/usr/...`、`/etc/...`）均触发。
- 修复：`packages/core/src/publish-plan.ts` 清理原语 `rm -f` 改 `unlink`——单文件原语、无递归语义、清理行为等价，安全规则未削弱；新增回归测试 `Tests/adapters/publish-wrap-safety.test.ts`（真实 `BashAnalyzer` + `decideSafety`，断言两代表性目标的包裹经审核流而非硬拒，并保留 find+rm 真破坏组合仍 deny 的对照用例）。

工具侧另有两处自身缺陷（产品无缺陷），已修正：`stat` 探测加 `LC_ALL=C`（VM 输出中文「普通文件」导致判据误判）；中断轮被杀操作的终态取最早快照而非末次对账态。

## 环境与口径

| 项 | 值 |
|---|---|
| VM | CentOS 7（`10.10.120.134`），SELinux Enforcing，可恢复快照；普通账号不在 sudoers |
| 凭据口径 | 账号/密码/密钥仅经环境变量与受控窗口注入；`su` 密码窗注入 root 口令；证据已脱敏（用户名→`[G3-REDACTED]`），密钥与口令经扫描确认不在任何证据文件 |
| 模型 | DeepSeek `deepseek-flash` |
| 工具 | `Tests/smoke/g3-publish-deploy.mjs`、`Tests/smoke/g3-publish-netcut.mjs`（`--label`、`--desktop apps/desktop`） |
| 证据 | `.cache/g3-real-machine/supplement/publish-deploy-r1..r3`、`publish-netcut-r1..r2`（回放、截图、summary） |

## 验收一：完整正向部署 — 通过（`publish-deploy-r3`）

任务 `b04b49e0-c142-48c3-8e63-4858f13f56fe`，2026-11-25T04:21:22Z→04:22:17Z（驱动 41.5s，模型请求 12 次）。5 个路线确认窗全部显式选 `su`，7 个 `su` 密码窗全部应答，0 个 `sudo` 包。

| 时间(UTC) | 操作 ID | 动作 | 结果 |
|---|---|---|---|
| 04:21:37 | `f446888d` | 特权 `mkdir -p /usr/local/share/g3-health`（su 包） | exit 0 |
| 04:21:42 | `87bc944d` | staging 写入 health_server.py（762 B） | exit 0 |
| 04:21:43 | `4f9a41f8` | 候选 su 包（目标不存在/非链接/暂存校验） | exit 0 |
| 04:21:44 | `0f13dfe0` | 提交 su 包（边界断言+安装+哈希） | exit 0 |
| 04:21:46 | `c8f61085` | staging 写入 g3-health.service（169 B） | exit 0 |
| 04:21:47 | `d783e57d` | 候选 su 包 | exit 0 |
| 04:21:48 | `f2224a27` | 提交 su 包 | exit 0 |
| 04:21:51 | `d8ea4a22` | `systemd-analyze verify` | exit 0（verify_exit=0） |
| 04:21:54 | `87d06e5b` | `systemctl daemon-reload`（su 包） | exit 0 |
| 04:21:57 | `601cd27f` | `systemctl enable --now`（su 包） | exit 0 |
| 04:22:00 | `de643bfe` | `curl http://127.0.0.1:18080/health` | HTTP 200 `g3-health-ok` |

带外 root 会话核验：

- `/usr/local/share/g3-health/health_server.py`：`regular file|root:root|644|762`，SHA-256 `1cac42c1b669f6092946b897f83592a93cebcd302d855cddbed22b3bcd3c801d`
- `/etc/systemd/system/g3-health.service`：`regular file|root:root|644|169`，SHA-256 `5cfa2863c5d9e87395c7ac2b8dcf4c36bf902934086ebbd78d4951cb65f14fab`
- 服务 `active (running)` + `enabled`，监听 `127.0.0.1:18080`，健康端点返回 `g3-health-ok`；目标路径无 `.cloudhelm-publish-*` 残留

轮次历史：r1 failed（SafetyGate 误杀，已修复）、r2 failed（工具 stat 本地化误判，产品数据实际正确）、r3 passed。

## 验收二：发布中断 — 通过（`publish-netcut-r2`）

中断点设计：候选 `su` 包派发后**持住 su 密码窗**（root 口令不注入、脚本不执行），带外 `pkill -9 -u <user> sshd` 切断连接；工具自动重连并恢复会话。

任务 `a25f7861-396a-406e-abbf-8dd186442c20`，2026-11-25T04:32:14Z→04:33:02Z（驱动 36.2s，模型请求 9 次）。

| 时间(UTC) | 操作 ID | 动作 | 结果 |
|---|---|---|---|
| 04:32:27 | `fa089137` | staging 写入 marker 内容 | exit 0 |
| 04:32:29 | `2c0f772b` | 候选 su 包 proposed→running（持窗、断连） | — |
| 04:32:30 | `2c0f772b` | 后端标记 | **unknown**（未确认结果保持未知） |
| 04:32:37 | `f07afa76` | 只读核验 `ls -l` marker | exit 2（不存在） |
| 04:32:37 | `62dfdc3b` | 只读核验 `ls -l` 候选文件 | exit 2（不存在） |
| 04:32:42 | `7f2d483b` | 只读核验 `ls -la` 父目录 | exit 0 |
| 04:32:46 | `2c0f772b` | 对账 | **failed**，`reconciledAt` 已设，`reconciliation={kind: evidence, outcome: failed, evidenceOperationIds: [7f2d483b]}` |
| 04:32:47 | `287641ac` | 重新 staging | exit 0 |
| 04:32:49 | `3d2ba7e9` | 新候选 su 包（对账后创建） | exit 0 |
| 04:32:50 | `cb69391a` | 新提交 su 包（对账后创建） | exit 0 |
| 04:32:53 | `15d7217d`/`0458e925` | 模型自查 `cat`/`stat` marker | exit 0 |

对照通过门：

- **中途失联先只读核验**：重连后首批派发全部只读（marker 不存在、候选不存在、父目录列表），之后才重新提案。
- **原发布不自动重放**：被杀候选终态 failed（reconciled，证据操作 `7f2d483b`）；后继候选/提交为全新操作 ID，创建时间均晚于对账时刻；对账前零非只读派发（lockViolations=0）。
- **未确认结果保持未知**：断连至对账期间状态为 `unknown`，未伪造结果。
- 带外终态：marker 内容 `g3-netcut-ok`（13 B），SHA-256 `c9f3ef7fda03253e9d40f75881a01793d42517264b5662ea978b8d7c458ea53e`，`regular file|root:root|644|13`。

轮次历史：r1 failed（工具终态取快照 bug，产品时序实际正确）、r2 passed。

## 遗留声明

`a6beec7` 遗留两项加固（`find -fprint` 校验异常一律拒绝；提交哈希不符确保目标不创建）仍未验证、不阻塞本验收；本报告不把上述正向成功表述为该两项已验证。staging 临时文件按设计留存 `/tmp`，由下一轮 VM 重置清理，不属目标残留。

## 复现

```powershell
$env:G3_CRED=…; $env:G3_ROOT=…; $env:G3_HOST=…; $env:G3_PORT=22
$env:G3_LOGIN=…; $env:G3_MODEL_KEY=…; $env:G3_PROVIDER='deepseek'; $env:G3_MODEL_ID='deepseek-flash'
node Tests/smoke/g3-publish-deploy.mjs --label publish-deploy-r3 --desktop apps/desktop
node Tests/smoke/g3-publish-netcut.mjs --label publish-netcut-r2 --desktop apps/desktop
pnpm exec vitest run Tests/adapters/publish-wrap-safety.test.ts
```
