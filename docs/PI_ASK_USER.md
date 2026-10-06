# Pi 需求澄清扩展

CloudHelm 内置 `@cloudhelm/pi-ask-user`，模型工具名为 `ask_user`。实现参考并移植了 [eko24ive/pi-ask](https://github.com/eko24ive/pi-ask) 1.2.0 的提示词和结构化问答设计，固定源码提交为 `49482b7e5d0d57be8af1db81f490f6e860792cfb`。上游 MIT 许可证与来源说明随源码及应用构建产物保留。

## 加载方式

扩展位于 `packages/adapters/src/pi-extensions/ask-user/`，包含标准 Pi `package.json` 清单和默认 `ExtensionAPI` 工厂，通过 `pi.registerTool` 注册工具。桌面发行版把工厂编译进 utility process，通过 Pi 0.99.1 官方 `DefaultResourceLoader.extensionFactories` 加载，再由 `ExtensionRunner` 和 `wrapRegisteredTools` 接入现有 Agent。每次建立或恢复对话都会创建独立实例；更新应用并重启后自动使用新插件，无须手动安装。不是向用户的全局 Pi 目录安装，也不自动发现第三方插件。

加载器使用隔离的临时目录和内存设置；不读取用户或项目的 Pi 扩展、提示词、模型配置或凭据。只注册内置 `ask_user`，加载失败则本轮失败，不静默禁用。此移植版依赖 CloudHelm 的事件桥接与 React 卡片，不包含上游 Pi TUI 界面。

## 提示词与工作流程

- 先调查已有信息，只对会影响下一步的需求、范围或偏好歧义提问；常规实现细节自行决定。
- 一次 1–3 个问题，每题可提供 2–5 个互斥选项，也可只接受文字；始终支持自定义回答。推荐不等于用户已经选择。
- 模型单独调用 `ask_user`。Pi 扩展通过事件桥请求 Application 层协调器创建问题，后端进入 `waiting-user`，界面展示内联卡片。
- 用户提交后，后端校验请求 ID、对话归属、有效期和答案，将问题与答案作为工具结果交回模型，直接继续当前轮次。回答不是主机或本地文件授权，远端变更仍经过 SafetyGate。
- 同一批次中若包含提问和其他工具，其他工具全部拦截；多个提问调用也拦截，要求模型重新发起单个批次。
- 每个对话最多一个待回答请求，默认 24 小时过期。取消、停止、断线、关闭执行终端或超时会中止等待并停止模型，不自动猜测、不重放操作。
- 切换对话保留回答草稿；提交失败保留草稿。重复或迟到的提交由后端拒绝。
- 请求与回答存入现有 SQLite records 表的新 bucket，没有数据库结构变更。重启或 utility process 退出后，待回答请求失效，对话暂停。已经提交的问题和答案保留在历史中，上下文压缩保留完整问答；预算不足则停止并报告。
- 不向用户索取密码、验证码、私钥等凭据，认证继续使用独立通道；界面提醒勿填秘密，后端拒绝凭据问题和可识别的密钥格式。

## 验证

单元与本地 HTTP/SSE 模型集成测试覆盖真实 Pi 加载、提示词注入、问答继续、混合工具批次、取消、过期、重复提交及上下文保留。`pnpm test:ui` 覆盖草稿、选项、自定义回答、提交失败及重试。`pnpm test:desktop` 与 `pnpm test:desktop:packaged` 使用本地模拟模型，跨 IPC、utility process 和 SQLite 检查重启前后插件注册及旧请求失效。
