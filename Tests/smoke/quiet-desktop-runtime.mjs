import process from 'node:process';

// Installed BEFORE importing the application, including its dependency graph.
// An early import failure must not become Electron's uncaught-error dialog.
export function installQuietStartupGuards({ app, dialog }, runtime = process) {
  const fail = () => { runtime.stderr.write('QUIET_DESKTOP_FAILURE: native UI or startup failure\n'); app.exit(1); };
  runtime.on('uncaughtException', fail);
  runtime.on('unhandledRejection', fail);
  dialog.showErrorBox = fail;
  if (runtime.env.CLOUDHELM_TEST_WINDOW !== 'cloudhelm-quiet-desktop-v1') { fail(); return; }
  const evidence = { protocol: 'cloudhelm-quiet-desktop-v1', windowsCreated: 0, violations: [] };
  Object.assign(globalThis, { __cloudhelmQuietDesktop: evidence });
  app.on('browser-window-created', (_event, window) => {
    evidence.windowsCreated++;
    const violation = (event) => { evidence.violations.push(event); fail(); };
    if (window.isVisible() || window.isFocused() || window.isFocusable()) violation('construction');
    for (const event of ['show', 'focus', 'maximize', 'enter-full-screen']) window.on(event, () => violation(event));
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}
