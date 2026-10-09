import { DiagnosticLogger, diagnosticSettings } from './diagnostic-logger.js';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, shell } from 'electron';
import { SqliteStore, listModelProviders } from '@cloudhelm/adapters';
import type { AppEvent, DesktopAPI, HostDraft, LocalScope } from '@cloudhelm/contracts';
import { AppState } from './app-state.js';
import { registerHostSafetyIpc } from './host-safety-ipc.js';
import { registerConversationIpc } from './conversation-ipc.js';
import { RuntimeBridge } from './runtime-bridge.js';
import { HostConnectionTester } from './host-connection-test.js';
import { AppShutdown } from './app-shutdown.js';

if (process.env.CLOUDHELM_USER_DATA) app.setPath('userData', process.env.CLOUDHELM_USER_DATA);

let window: BrowserWindow | null = null;
let store: SqliteStore;
let state: AppState;
let runtime: RuntimeBridge;
const untrustedFingerprints = new Map<string, string>();
const connecting = new Map<string, Promise<void>>();
const selectedLocalPaths = new Map<string, LocalScope>();

function takeLocalSelections(tokens: string[]): LocalScope[] {
  if (!Array.isArray(tokens) || tokens.length > 20
    || tokens.some((token) => typeof token !== 'string' || !selectedLocalPaths.has(token))) {
    throw new Error('Local files must be selected with the system file picker');
  }
  const scopes = tokens.map((token) => selectedLocalPaths.get(token)!);
  for (const token of tokens) selectedLocalPaths.delete(token);
  return scopes;
}

function restoreLocalSelections(tokens: string[], scopes: LocalScope[]): void {
  tokens.forEach((token, index) => selectedLocalPaths.set(token, scopes[index]!));
}

function publish(event: AppEvent): void {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('cloudhelm:event', event);
}

async function connectHost(hostId: string): Promise<void> {
  if (state.getHost(hostId).status === 'connected') return;
  const pending = connecting.get(hostId);
  if (pending) return pending;
  const connection = connectOnce(hostId).finally(() => connecting.delete(hostId));
  connecting.set(hostId, connection);
  return connection;
}

async function connectOnce(hostId: string): Promise<void> {
  const host = state.runtimeHost(hostId);
  if (host.jumpHostId) {
    const jumpHost = state.getHost(host.jumpHostId);
    if (jumpHost.jumpHostId) throw new Error('Only one jump host is supported');
    if (jumpHost.status !== 'connected') await connectHost(jumpHost.id);
  }
  const jump = host.jumpHostId ? state.runtimeHost(host.jumpHostId) : undefined;
  state.updateHost(hostId, { status: 'connecting' });
  try {
    await runtime.call({ method: 'connect', host, jump });
    untrustedFingerprints.delete(hostId);
  } catch (error) {
    if (error && typeof error === 'object' && 'hostFingerprint' in error && typeof error.hostFingerprint === 'string') {
      untrustedFingerprints.set(hostId, error.hostFingerprint);
      state.updateHost(hostId, { status: 'changed-key' });
      throw new Error(`Verify SSH host key for ${hostId}: ${error.hostFingerprint}`);
    }
    throw error;
  }
}

function registerIpc(): void {
  const hostTester = new HostConnectionTester(state, (host, jump) => runtime.call({ method: 'test-host', host, jump }));
  ipcMain.handle('cloudhelm:test-host', (_event, input: Parameters<DesktopAPI['testHostConnection']>[0]) => hostTester.test(input));
  registerConversationIpc({ sessionRoot: join(app.getPath('userData'), 'pi-sessions'), state, runtime, connectHost, takeSelections: takeLocalSelections, restoreSelections: restoreLocalSelections });
  ipcMain.handle('cloudhelm:snapshot', () => state.snapshot());
  ipcMain.handle('cloudhelm:app-version', () => app.getVersion());
  ipcMain.handle('cloudhelm:add-host', (_event, host: HostDraft) => state.addHost(host));
  ipcMain.handle('cloudhelm:edit-host', (_event, hostId: string, host: HostDraft, newSecret?: string) => state.editHost(hostId, host, newSecret));
  ipcMain.handle('cloudhelm:set-host-secret', (_event, hostId: string, secret: string) => {
    state.getHost(hostId);
    state.saveSecret(`host:${hostId}`, secret);
  });
  registerHostSafetyIpc(state, runtime);
  ipcMain.handle('cloudhelm:save-profile', (_event, profile: Parameters<DesktopAPI['saveModelProfile']>[0]) => state.saveProfile(profile));
  ipcMain.handle('cloudhelm:save-review-settings', async (_event, settings: Parameters<DesktopAPI['saveReviewSettings']>[0]) => {
    state.saveReviewSettings(settings);
    await runtime.call({ method: 'set-review-key', jevKey: state.reviewKey() });
  });
  ipcMain.handle('cloudhelm:shortcuts', () => state.shortcuts());
  ipcMain.handle('cloudhelm:save-shortcuts', (_event, settings: Parameters<DesktopAPI['saveShortcuts']>[0]) => state.saveShortcuts(settings));
  ipcMain.handle('cloudhelm:read-clipboard', () => clipboard.readText());
  ipcMain.handle('cloudhelm:write-clipboard', (_event, text: string) => {
    if (typeof text !== 'string' || text.length > 200_000) throw new Error('Invalid clipboard content');
    clipboard.writeText(text);
  });
  ipcMain.handle('cloudhelm:test-model', (_event, profile: Parameters<DesktopAPI['testModelConnection']>[0]) => runtime.call({ method: 'test-model', profile: state.testProfile(profile) }));
  ipcMain.handle('cloudhelm:available-models', () => state.availableModels());
  ipcMain.handle('cloudhelm:disconnect-host', async (_event, hostId: string) => {
    state.getHost(hostId); await runtime.call({ method: 'disconnect', hostId }); state.updateHost(hostId, { status: 'disconnected' });
  });
  ipcMain.handle('cloudhelm:delete-host', async (_event, hostId: string) => {
    state.getHost(hostId); await runtime.call({ method: 'disconnect', hostId }); state.archiveHost(hostId);
  });
  ipcMain.handle('cloudhelm:list-model-providers', () => listModelProviders());
  ipcMain.handle('cloudhelm:model-provider-settings', (_event, providerId: string) => state.modelProviderSettings(providerId));
  ipcMain.handle('cloudhelm:connect-host', (_event, hostId: string) => connectHost(hostId));
  ipcMain.handle('cloudhelm:trust-host-key', async (_event, hostId: string, fingerprint: string) => {
    if (untrustedFingerprints.get(hostId) !== fingerprint) throw new Error('Fingerprint is no longer pending');
    state.updateHost(hostId, { fingerprint });
    await connectHost(hostId);
  });
  ipcMain.handle('cloudhelm:open-terminal', (_event, hostId: string) => {
    state.getHost(hostId);
    return runtime.call<string>({ method: 'open-terminal', hostId });
  });
  ipcMain.handle('cloudhelm:close-terminal', (_event, terminalId: string) => runtime.call({ method: 'close-terminal', terminalId }));
  ipcMain.handle('cloudhelm:select-private-key', async () => {
    // Selecting an SSH credential does not grant the Agent local file access.
    const options: Electron.OpenDialogOptions = { title: '选择 SSH 私钥', buttonLabel: '使用此私钥',
      defaultPath: join(app.getPath('home'), '.ssh'), properties: ['openFile', 'showHiddenFiles', 'dontAddToRecent'] };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('cloudhelm:select-local-path', async (_event, kind: LocalScope['kind']) => {
    if (kind !== 'file' && kind !== 'directory') throw new Error('Invalid local selection type');
    const options: Electron.OpenDialogOptions = { properties: [kind === 'file' ? 'openFile' : 'openDirectory'] };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    const scope: LocalScope = { path: await realpath(result.filePaths[0]), kind };
    const token = randomUUID();
    selectedLocalPaths.set(token, scope);
    return { token, scope };
  });
  ipcMain.handle('cloudhelm:terminal-input', (_event, terminalId: string, data: string) => runtime.call({ method: 'terminal-input', terminalId, data, humanIntent: true }));
  ipcMain.handle('cloudhelm:terminal-protocol', (_event, terminalId: string, data: string) => runtime.call({ method: 'terminal-input', terminalId, data, humanIntent: false }));
  ipcMain.handle('cloudhelm:stop-terminal', (_event, terminalId: string) => runtime.call({ method: 'stop-terminal', terminalId }));
  ipcMain.handle('cloudhelm:resize', (_event, terminalId: string, cols: number, rows: number) => runtime.call({ method: 'resize', terminalId, cols, rows }));
  ipcMain.handle('cloudhelm:decide-approval', (_event, approvalId: string, approved: boolean) => runtime.call({ method: 'decide-approval', approvalId, approved }));
  ipcMain.handle('cloudhelm:answer-input', (_event, requestId: string, answer: string) => runtime.call({ method: 'answer-input', requestId, answer }));
  ipcMain.handle('cloudhelm:cancel-input', (_event, requestId: string) => runtime.call({ method: 'cancel-input', requestId }));
  ipcMain.handle('cloudhelm:pause-task', (_event, taskId: string) => runtime.call({ method: 'pause-task', taskId }));
  ipcMain.handle('cloudhelm:accept-task', (_event, taskId: string) => state.acceptTask(taskId));
  ipcMain.handle('cloudhelm:list-remote', (_event, hostId: string, path: string) => runtime.call({ method: 'list-remote', hostId, path }));
  ipcMain.handle('cloudhelm:read-terminal-log', (_event, terminalId: string) => state.readTerminalLog(terminalId));
}

/**
 * macOS keeps a system application menu, but its default items bind Cmd+N to a
 * new window and Cmd+W to close the window. Both are owned by the workspace
 * shortcuts now, so the menu is rebuilt without those accelerators.
 */
function macApplicationMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'services' },
      { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { role: 'quit' }] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] }
  ]);
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1440, height: 920, minWidth: 980, minHeight: 640,
    backgroundColor: '#111715', title: 'CloudHelm',
    webPreferences: { preload: join(import.meta.dirname, '../preload/index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false }
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (['https:', 'http:'].includes(target.protocol) && !target.username && !target.password) {
        void shell.openExternal(target.href).catch(() => undefined);
      }
    } catch { /* Malformed and non-web model links remain inert. */ }
    return { action: 'deny' };
  });
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  window.on('closed', () => { window = null; });
}

void app.whenReady().then(async () => {
  // Windows keeps no application menu. macOS keeps the system app and edit
  // menus minus accelerators that conflict with workspace shortcuts.
  if (process.platform === 'darwin') Menu.setApplicationMenu(macApplicationMenu());
  else Menu.setApplicationMenu(null);
  store = new SqliteStore(join(app.getPath('userData'), 'cloudhelm.sqlite'));
  state = new AppState(store, publish);
  const diagnostics = new DiagnosticLogger(diagnosticSettings(!!process.env.ELECTRON_RENDERER_URL, process.env, app.getPath('userData')));
  diagnostics.write({ event: 'runtime.started', level: 'info' });
  runtime = new RuntimeBridge((event) => {
    state.record(event);
    if (!window?.isFocused() && Notification.isSupported()
      && (event.type === 'approval-open' || event.type === 'input-open'
        || (event.type === 'task-status' && event.status === 'ready-for-review'))) {
      new Notification({ title: 'CloudHelm', body: event.type === 'task-status' ? 'AI 已提交验证结果，等待验收。' : 'AI 需要你处理一项请求。' }).show();
    }
  }, (taskId, operationId, cursor) => state.readOperationLog(taskId, operationId, cursor), () => { diagnostics.write({ event: 'runtime.stopped', level: 'error' }); state.runtimeStopped(); }, (event) => diagnostics.write(event));
  await runtime.call({ method: 'restore-operations', operations: state.snapshot().operations
    .filter((operation) => operation.status === 'unknown' || (operation.status === 'failed' && operation.effects === 'possible' && !operation.reconciledAt)).map(({ id, hostId }) => ({ id, hostId })) });
  registerIpc();
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
}).catch((error: unknown) => {
  if (shutdown.isClosed) return;
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error('CloudHelm startup failed:', message);
  dialog.showErrorBox('CloudHelm 无法启动', message);
});

const shutdown = new AppShutdown({
  snapshot: () => state?.snapshot(),
  confirmExit: async () => {
    const { response } = await dialog.showMessageBox({ type: 'warning', title: '退出 CloudHelm',
      message: 'AI 或远端命令仍可能在运行', detail: '退出会断开 SSH。远端进程是否停止需要在下次打开时核验。',
      buttons: ['继续使用', '退出并下次核验'], defaultId: 0, cancelId: 0 });
    return response === 1;
  },
  quit: () => app.quit(),
  close: () => { runtime?.close(); state?.close(); store?.close(); }
});
app.on('before-quit', (event) => shutdown.beforeQuit(event));
app.on('will-quit', () => shutdown.willQuit());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
