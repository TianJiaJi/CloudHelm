import { contextBridge, ipcRenderer } from 'electron';
import type { AppEvent, DesktopAPI, StoredAppearanceSettings, StoredLayoutSettings } from '@cloudhelm/contracts';

const invoke = <T>(method: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(`cloudhelm:${method}`, ...args) as Promise<T>;

// Resolved before the renderer paints so the first frame already matches the
// persisted theme; 'system' is resolved against the OS preference here.
const initialAppearance = ipcRenderer.sendSync('cloudhelm:initial-appearance') as StoredAppearanceSettings;
const resolvedTheme = initialAppearance.mode === 'system'
  ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
  : initialAppearance.mode;
// Same for the layout mode: the store reads this before its first render.
const initialLayout = ipcRenderer.sendSync('cloudhelm:initial-layout') as StoredLayoutSettings;

// In a sandboxed renderer the preload runs before the parser creates <html>,
// so the attributes are written as soon as the document element appears —
// still ahead of the deferred entry module that initializes the stores.
const applyInitialDocumentState = (): void => {
  if (!document.documentElement) return;
  document.removeEventListener('readystatechange', applyInitialDocumentState);
  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.dataset.layout = initialLayout.mode;
};
if (document.documentElement) applyInitialDocumentState();
else document.addEventListener('readystatechange', applyInitialDocumentState);

const api: DesktopAPI = {
  openReferenceDraft: (scope) => invoke('open-reference-draft', scope),
  claimDraftReferences: (draftId, ids) => invoke('claim-draft-references', draftId, ids),
  releaseReferenceDraft: (draftId) => invoke('release-reference-draft', draftId),
  quoteTerminal: (input) => invoke('quote-terminal', input),
  readReference: (id) => invoke('read-reference', id),
  sendStructured: (input) => invoke('send-structured', input),
  cancelMessage: (id) => invoke('cancel-message', id),
  snapshot: () => invoke('snapshot'),
  appVersion: () => invoke('app-version'),
  addHost: (host, credentials) => invoke('add-host', host, credentials),
  editHost: (hostId, host, newSecret, credentials) => invoke('edit-host', hostId, host, newSecret, credentials),
  testHostConnection: (input) => invoke('test-host', input),
  setHostSecret: (hostId, secret) => invoke('set-host-secret', hostId, secret),
  updateHostReviewMode: (hostId, mode) => invoke('update-host-review-mode', hostId, mode),
  updateHostSafety: (hostId, mode, protectedReadPaths, protectedWritePaths) => invoke('update-host-safety', hostId, mode, protectedReadPaths, protectedWritePaths),
  updateConversationReviewMode: (taskId, hostId, mode) => invoke('update-conversation-review-mode', taskId, hostId, mode),
  requestAiDenialReview: (taskId, operationId) => invoke('request-ai-denial-review', taskId, operationId),
  readRecoveryOperationLog: (operationId, cursor) => invoke('read-recovery-operation-log', operationId, cursor),
  acceptOperationRisk: (operationId, explanation, sourceTaskId, evidenceOperationIds) => invoke('accept-operation-risk', operationId, explanation, sourceTaskId, evidenceOperationIds),
  saveModelProfile: (profile) => invoke('save-profile', profile),
  testModelConnection: (profile) => invoke('test-model', profile),
  outboundLimit: () => invoke('outbound-limit'),
  saveOutboundLimit: (cap) => invoke('save-outbound-limit', cap),
  availableModels: () => invoke('available-models'),
  saveReviewSettings: (settings) => invoke('save-review-settings', settings),
  shortcuts: () => invoke('shortcuts'),
  saveShortcuts: (settings) => invoke('save-shortcuts', settings),
  appearanceSettings: () => invoke('appearance-settings'),
  saveAppearanceSettings: (settings) => invoke('save-appearance-settings', settings),
  layoutSettings: () => invoke('layout-settings'),
  saveLayoutSettings: (settings) => invoke('save-layout-settings', settings),
  readClipboard: () => invoke('read-clipboard'),
  writeClipboard: (text) => invoke('write-clipboard', text),
  listModelProviders: () => invoke('list-model-providers'),
  modelProviderSettings: (providerId) => invoke('model-provider-settings', providerId),
  disconnectHost: (hostId) => invoke('disconnect-host', hostId),
  deleteHost: (hostId) => invoke('delete-host', hostId),
  connectHost: (hostId) => invoke('connect-host', hostId),
  trustHostKey: (hostId, fingerprint) => invoke('trust-host-key', hostId, fingerprint),
  openTerminal: (hostId) => invoke('open-terminal', hostId),
  closeTerminal: (terminalId) => invoke('close-terminal', terminalId),
  selectLocalPath: (kind) => invoke('select-local-path', kind),
  selectPrivateKey: () => invoke('select-private-key'),
  terminalInput: (terminalId, data) => invoke('terminal-input', terminalId, data),
  terminalProtocolResponse: (terminalId, data) => invoke('terminal-protocol', terminalId, data),
  stopTerminal: (terminalId) => invoke('stop-terminal', terminalId),
  resizeTerminal: (terminalId, cols, rows) => invoke('resize', terminalId, cols, rows),
  startConversation: (input) => invoke('start-conversation', input),
  sendMessage: (id, message, tokens, queueMode) => queueMode === undefined
    ? invoke('send-message', id, message, tokens ?? []) : invoke('send-message', id, message, tokens ?? [], queueMode),
  cancelQueuedInput: (id, inputId) => invoke('cancel-queued-input', id, inputId),
  setConversationThinking: (id, level) => invoke('set-conversation-thinking', id, level),
  setConversationModel: (id, model) => invoke('set-conversation-model', id, model),
  answerClarification: (taskId, requestId, answers) => invoke('answer-clarification', taskId, requestId, answers),
  cancelClarification: (taskId, requestId) => invoke('cancel-clarification', taskId, requestId),
  stopOperation: (id) => invoke('stop-operation', id),
  decideApproval: (approvalId, approved) => invoke('decide-approval', approvalId, approved),
  answerInput: (requestId, answer) => invoke('answer-input', requestId, answer),
  cancelInput: (requestId) => invoke('cancel-input', requestId),
  pauseConversation: (taskId) => invoke('pause-task', taskId),
  resumeConversation: (taskId) => invoke('resume-task', taskId),
  rebuildVerificationReport: (taskId) => invoke('rebuild-verification-report', taskId),
  extendRequestBudget: (input) => invoke('extend-request-budget', input),
  listRemote: (hostId, path) => invoke('list-remote', hostId, path),
  readTerminalLog: (terminalId) => invoke('read-terminal-log', terminalId),
  readOperationLog: (taskId, operationId, cursor) => invoke('read-operation-log', taskId, operationId, cursor),
  deleteConversation: (id) => invoke('delete-conversation', id),
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: AppEvent) => listener(value);
    ipcRenderer.on('cloudhelm:event', handler);
    return () => ipcRenderer.off('cloudhelm:event', handler);
  }
};

contextBridge.exposeInMainWorld('cloudhelm', api);
