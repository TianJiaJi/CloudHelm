# Pi 旧版本会话样本

`pi-0991-history.jsonl` 与 `pi-0991-compacted.jsonl` 是在升级前使用实际安装的 `@earendil-works/pi-coding-agent@0.99.1` 的 `SessionManager.inMemory()` 生成的合成记录。

- 不是个人对话，不包含真实凭据、服务器地址或个人目录。
- 仅通过 SDK 的 append 方法构造历史，没有执行 SSH 命令或调用模型。
- 包含用户/模型消息、工具调用及结果、模型/思考选择、custom message、context edit；第二份额外包含 compaction。
- `cwd` 固定为 `/synthetic-workspace`。历史工具 `observe` 只表示一条合成的既往观察，不表示当前服务器状态。
- 样本用于验证新版打开旧文件时不丢失历史、不回放工具、不自动发送模型请求，以及显式继续后的上下文投影。
- 不得用待验证的新 SDK 重新生成并覆盖这些旧版样本来使升级测试通过。
