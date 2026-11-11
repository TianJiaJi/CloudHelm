# 不弹窗、不抢焦点的桌面测试

用户正在使用电脑或游戏时，测试不得弹出窗口、聚焦或触发切屏。此约束优先于真实窗口的最大化、全屏和系统焦点验收。

## 实现与边界

- 测试启动器 `Tests/smoke/quiet-electron.mjs` 默认仅允许本工作区开发版 Electron、独立绝对路径测试 profile 和含本协议标记的开发构建。旧构建、未知可执行文件及安装包在启动前拒绝；标记检查用于防止误跑陈旧构建，不是签名或防篡改认证。
- `quiet-desktop-bootstrap.mjs` 在动态导入应用及其依赖前装配错误处理与窗口事件监测。早期异常只失败退出，不显示 Electron 错误对话框。恢复应用路径使用 Electron 内部 `app.setAppPath`，需随固定 Electron 版本回归；不把它当公共稳定 SDK。
- 应用仅在测试进程的版本化 `CLOUDHELM_TEST_WINDOW` 设置下启用策略。窗口在**构造时**即 `show:false`、`focusable:false`、`skipTaskbar:true`，不是创建之后再隐藏；关闭原生最大化、最小化和全屏能力。附加测试窗口同样设置这些属性。
- 测试模式不激活第二实例、不显示系统通知、不打开外部浏览器。原生文件对话框默认取消；确认框必须有明确的取消按钮，否则拒绝，绝不自动批准退出或业务操作。需要验证选择逻辑时可以显式替换为合成对话框结果。
- 没有该测试设置的正常用户启动保持原行为。配置错误或测试失败不回退为前台模式。测试设置不通过 Renderer IPC 暴露。
- 启动监测记录窗口初始状态及 show/focus/maximize/fullscreen 违规并失败。事件监测是回归检测，不是操作系统沙箱；防止当前已知窗口抢焦点依赖构造参数及关闭原生 UI 入口。
- 普通浏览器 smoke 已使用 `headless:true`。UI 操作通过自动化协议完成，不向用户桌面注入鼠标键盘。隐藏界面仍可进行 DOM/IPC 检查和应用自身截图，不截取用户桌面。

参考用户指定的本地项目的隐藏窗口策略与验收思路，未运行或修改该项目。该方案**不是 Windows 虚拟桌面或独立登录会话**，也不是性能、声音或剪贴板隔离。

## 隐藏截图路径

标准桌面长流程曾两次在Playwright `page.screenshot`处超时（原30秒预算，失败截图5秒也超时）。诊断时页面/字体就绪、整页1424×881且无页面溢出；同一窗口的Electron原生捕获返回非空同尺寸图像，前后均不可见/未聚焦/不可聚焦且零窗口违规。该证据区分了捕获路径，不足以断言Chromium内部根因或用户游戏导致故障。

`Tests/smoke/quiet-screenshot.mjs`为标准桌面截图显式使用`webContents.capturePage(undefined, { stayHidden:true, stayAwake:false })`，不先失败再回退；保留30秒预算。绑定当前Playwright页面的原生窗口，捕获前后校验测试协议与隐藏状态；先检查整页可放入视口，拒绝静默裁剪，拒绝空图/无像素变化图，超时后的迟到结果不写成成功产物。不会show/focus、开启offscreen、改变系统唤醒策略或捕获用户桌面。专用quiet验收同时保留原Playwright初始窗口截图，并覆盖新的原生路径。新专项与完整桌面复验结果以`REPAIR_PROGRESS.md`为准。

接口依据：[Electron webContents.capturePage](https://www.electronjs.org/docs/latest/api/web-contents#contentscapturepagerect-opts)，并核对工作区固定Electron版本的类型声明；未升级依赖。

## 验证状态与执行

首轮3文件10项纯测试、静态检查和重新构建通过。首次真实隐藏启动因固定argv下标误读Playwright调试参数而在导入应用前失败，启动保护直接退出；未转为前台模式。已改为按自身bootstrap路径定位、严格验证唯一绝对入口，并补调试参数前置/歧义/缺失反例。随后4文件13项纯测试和工程检查通过，真实Windows专用隐藏验收也已通过：不可见/不可聚焦、零原生窗口事件、未替换文件选择取消、第二实例不激活、应用截图成功，0模型/VM调用。后续全量252文件2337项通过（25项条件跳过），但隐藏引用恢复发现第二实例退出码为1：夹具已预设userData，主入口误把该测试路径当作正常默认目录。改为根据appData与应用名识别默认目录，保留明确正常目录拒绝和原退出码断言；新增回归后4文件14项、工程检查与重新构建通过。专门隐藏验收、引用恢复/删除/凭据/思考偏好/标准五项Windows桌面，以及headless Chrome剪贴板/完整UI均已通过。最终无界面全量252文件2338项通过、7文件25项条件跳过（274.04秒），版本与更新日志检查通过。本阶段完成开发态验收，不因此扩大为安装包、系统前台焦点或游戏性能验收。

```text
pnpm exec vitest run Tests/desktop/main/test-window-policy.test.ts Tests/smoke/quiet-electron.test.mjs Tests/smoke/quiet-desktop-runtime.test.mjs Tests/smoke/quiet-bootstrap-entry.test.mjs --maxWorkers=2
pnpm build
node Tests/smoke/quiet-desktop-smoke.mjs
```

先通过专门的隐藏窗口验收，再运行原有开发态桌面 smoke。该验收核对不可见、未聚焦、不可聚焦、零原生窗口事件、文件选择默认取消、第二实例不激活，以及应用截图能够渲染。

隐藏窗口运行可能影响动画时钟和后台调度；不以隐藏测试冒充用户前台 FPS、物理显示刷新率、Windows DPI、系统输入焦点、真实最大化/全屏或游戏前台进程监测。当前没有开启离屏渲染。安装包及需要原生可见交互的验收保留为未验收，待用户另外安排，不自动开启。
