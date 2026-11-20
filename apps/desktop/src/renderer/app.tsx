import { draftFor, insertTerminalReference, useMessageDrafts } from './message-drafts.js';
import { holdDraftReferences } from './reference-drafts.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { HostView, TaskView } from '@cloudhelm/contracts';
import { isActiveTaskStatus } from '@cloudhelm/contracts';
import { useUi, type WorkspaceTab } from './store.js';
import { HostDialog, SafetyDialog, ConfirmDialog } from './host-dialogs.js';
import { InputCard } from './interaction-cards.js';
import { capture } from './ui-helpers.js';
import { ErrorDialog } from './error-dialog.js';
import { useErrorNotices } from './use-error-notices.js';
import { ContextMenuHost, openContextMenu, type ContextMenuAction, type ContextMenuEntry } from './context-menu.js';
import { copyEntries, copyText, readClipboardText } from './clipboard.js';
import { editableTarget, editMenuEntries } from './edit-menu.js';
import { useKeyboardShortcuts } from './use-shortcuts.js';
import { useShortcuts } from './shortcut-store.js';
import { isMacPlatform, menuHint, type ShortcutActionId, type ShortcutContext } from './shortcuts.js';
import { terminalActions } from './terminal-actions.js';
import { focusHostTreeSearch } from './host-tree-actions.js';
import { SshLayout } from './ssh-layout.js';
import { AgentLayout } from './agent-layout.js';
import type { LayoutProps } from './layout-props.js';
import styles from './ui.module.css';

type Confirmation = { title: string; message: string; label: string; action(): Promise<void> };
type Dialog = { kind: 'host'; hostId?: string } | { kind: 'safety'; hostId: string } | null;
type Hint = Pick<ContextMenuAction, 'hint' | 'hintMuted'>;

/**
 * App owns cross-layout state: dialogs, confirmations, host/connection flows,
 * and the context menus shared by both layouts. The layout shells project it.
 */
export function App(): React.JSX.Element {
  const ui = useUi();
  const { snapshot, terminals, tabs, activeTabId, activeHostId, selectedConversationId, settingsOpen } = ui;
  const bindings = useShortcuts((state) => state.bindings);
  const shortcutsEnabled = useShortcuts((state) => state.enabled);
  const isMac = isMacPlatform();
  const [dialog, setDialog] = useState<Dialog>(null);
  const { current: error, report: setError, dismiss: dismissError } = useErrorNotices();
  const [fingerprint, setFingerprint] = useState<{ hostId: string; value: string } | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [hiddenInputs, setHiddenInputs] = useState<string[]>([]);
  const [connecting, setConnecting] = useState<string[]>([]);
  const [quoteNotice, setQuoteNotice] = useState('');
  const [appVersion, setAppVersion] = useState('');
  const navigationGuard = useRef<((next: () => void) => void) | null>(null);
  const registerNavigationGuard = useCallback((guard: ((next: () => void) => void) | null) => { navigationGuard.current = guard; }, []);
  function navigate(action: () => void): void {
    if (settingsOpen && navigationGuard.current) navigationGuard.current(() => { useUi.getState().setSettingsOpen(false); action(); });
    else action();
  }
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const activeTerminal = activeTab?.kind === 'terminal' ? terminals[activeTab.terminalId] : undefined;
  const terminalId = activeTerminal?.id;
  const reportTerminalError = useCallback((message: string) => setError(message, terminalId ? { terminalId } : undefined), [setError, terminalId]);
  const reportConversationError = useCallback((message: string) => setError(message,
    selectedConversationId ? { conversationId: selectedConversationId } : undefined), [setError, selectedConversationId]);
  const activeHost = snapshot?.hosts.find((host) => host.id === activeHostId);
  const hostName = (hostId: string): string => snapshot?.hosts.find((host) => host.id === hostId)?.label ?? hostId;

  /** Shortcut hints only appear where the binding can actually fire. */
  function hintFor(actionId: ShortcutActionId, context: ShortcutContext = 'default'): Hint {
    const value = menuHint(actionId, bindings, isMac, context, shortcutsEnabled);
    return value ? { hint: value.hint, hintMuted: value.muted } : {};
  }

  useEffect(() => {
    void useShortcuts.getState().load();
    try { void window.cloudhelm.appVersion().then(setAppVersion).catch(() => setAppVersion('')); }
    catch { setAppVersion(''); }
  }, []);

  useEffect(() => {
    const unsubscribe = window.cloudhelm.onEvent((event) => {
      if (event.type === 'message-preparation') {
        for (const [key, draft] of Object.entries(useMessageDrafts.getState().drafts)) {
          if (draft.request?.id === event.requestId) useMessageDrafts.getState().set(key, {
            compressing: event.status === 'compressing',
            compressingReference: event.referenceId ?? draft.compressingReference,
            summaryRequests: event.summaryRequests ?? draft.summaryRequests,
            preparationContext: draft.locked ? event.context ?? draft.preparationContext : undefined
          });
        }
      }
      const previous = useUi.getState().snapshot;
      useUi.getState().applyEvent(event);
      // Main projects worker task-status events into snapshots. Only a new
      // failure of an already known conversation should interrupt the user;
      // restoring historical failed conversations must stay quiet.
      if (event.type !== 'snapshot' || !previous) return;
      const previousStatuses = new Map(previous.conversations.map((item) => [item.id, item.status]));
      for (const item of event.value.conversations) {
        const before = previousStatuses.get(item.id);
        if (before && before !== 'failed' && item.status === 'failed') {
          setError(item.summary || 'Unknown conversation failure', { conversationId: item.id });
        }
      }
    });
    void window.cloudhelm.snapshot().then(useUi.getState().setSnapshot).catch((cause: unknown) => setError(String(cause)));
    return unsubscribe;
  }, [setError]);
  useEffect(() => { if (!quoteNotice) return; const timer = setTimeout(() => setQuoteNotice(''), 3000); return () => clearTimeout(timer); }, [quoteNotice]);

  async function connectHost(hostId: string, alwaysNew = false): Promise<void> {
    if (connecting.includes(hostId)) return;
    setConnecting((ids) => [...ids, hostId]);
    try {
      const existing = Object.values(useUi.getState().terminals).find((terminal) => terminal.hostId === hostId && !terminal.taskId && terminal.state !== 'closed');
      if (existing && !alwaysNew) { useUi.getState().openTerminal(existing.id); return; }
      const host = useUi.getState().snapshot?.hosts.find((item) => item.id === hostId);
      if (host?.status !== 'connected') await window.cloudhelm.connectHost(hostId);
      const id = await window.cloudhelm.openTerminal(hostId);
      if (!useUi.getState().terminals[id]) useUi.getState().setSnapshot(await window.cloudhelm.snapshot());
      useUi.getState().openTerminal(id); setError('');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const value = /SHA256:[A-Za-z\d+/=]+/u.exec(message)?.[0];
      if (value) setFingerprint({ hostId, value }); else setError(message);
    } finally { setConnecting((ids) => ids.filter((id) => id !== hostId)); }
  }

  /** A terminal whose AI operation is still running must not be closed silently. */
  function executingTerminal(tab: WorkspaceTab): boolean {
    if (tab.kind !== 'terminal') return false;
    const terminal = terminals[tab.terminalId];
    return !!terminal?.taskId && !!snapshot?.operations.some((operation) => operation.taskId === terminal.taskId
      && operation.logRef === terminal.id && ['running', 'unknown'].includes(operation.status));
  }

  async function closeTabNow(tab: WorkspaceTab): Promise<void> {
    if (tab.kind === 'terminal') await window.cloudhelm.closeTerminal(tab.terminalId);
    useUi.getState().closeTab(tab.id);
  }

  function closeTab(tab: WorkspaceTab): void {
    if (!executingTerminal(tab)) { void capture(() => closeTabNow(tab), setError); return; }
    setConfirmation({ title: '断开正在运行的 AI 终端？',
      message: '关闭这个标签会断开真实 SSH 会话。远端进程不一定停止，当前操作的结果可能需要重新核验。你也可以先点击“停止”，等待命令退出。',
      label: '断开并关闭', action: () => closeTabNow(tab) });
  }

  function closeTabs(targets: WorkspaceTab[]): void {
    if (!targets.length) return;
    const risky = targets.filter((tab) => executingTerminal(tab));
    const close = async (): Promise<void> => { for (const tab of targets) await closeTabNow(tab); };
    if (!risky.length) { void capture(close, setError); return; }
    setConfirmation({ title: `关闭 ${targets.length} 个标签？`,
      message: `其中 ${risky.length} 个 AI 终端正在执行命令。关闭会断开真实 SSH 会话，远端进程不一定停止，结果可能需要重新核验。`,
      label: '断开并关闭', action: close });
  }

  function cycleTab(step: number): void {
    if (tabs.length < 2) return;
    const index = tabs.findIndex((tab) => tab.id === activeTabId);
    const next = tabs[(index + step + tabs.length) % tabs.length];
    if (next) navigate(() => useUi.getState().selectTab(next.id));
  }

  function disconnect(host: HostView): void {
    setConfirmation({ title: `断开 ${host.label}？`, message: '将断开这台主机的 SSH 会话。正在执行的命令可能仍在远端运行，重新连接后会先核验结果。', label: '断开 SSH',
      action: () => window.cloudhelm.disconnectHost(host.id) });
  }

  function removeHost(host: HostView): void {
    setConfirmation({ title: `移除 ${host.label}？`, message: '从主机列表移除该连接配置，历史对话和审计记录会保留。不会删除服务器上的数据。', label: '移除主机',
      action: () => window.cloudhelm.deleteHost(host.id) });
  }

  function quoteTerminal(): void {
    if (!activeTerminal) return;
    const source = activeTerminal;
    const conversationId = selectedConversationId ?? undefined;
    const key = conversationId ?? `draft:${source.hostId}`;
    const selection = terminalActions(source.id)?.getSelection() || undefined;
    void capture(async () => {
      if (draftFor(key).locked) throw new Error('这条消息正在发送，请等待完成后再添加引用');
      const epoch = draftFor(key).epoch;
      const draftId = await holdDraftReferences(key, { conversationId, hostId: source.hostId }, draftFor(key).parts);
      const reference = await window.cloudhelm.quoteTerminal({ draftId, terminalId: source.id, hostId: source.hostId, conversationId, selection });
      insertTerminalReference(key, reference, epoch);
      setQuoteNotice('已添加到 AI 对话草稿');
      if (useUi.getState().activeTabId === source.id) terminalActions(source.id)?.focus();
    }, setError);
  }

  function hostActions(host: HostView): ContextMenuEntry[] {
    return [
      { id: 'edit-host', label: '编辑主机', icon: 'settings', run: () => navigate(() => setDialog({ kind: 'host', hostId: host.id })) },
      { id: 'safety', label: '安全设置', icon: 'shield', run: () => navigate(() => setDialog({ kind: 'safety', hostId: host.id })) },
      { id: 'new-terminal', label: '新终端', icon: 'terminal', ...hintFor('terminal.new'),
        run: () => navigate(() => void connectHost(host.id, true)) },
      { id: 'disconnect', label: '断开 SSH', icon: 'disconnect', run: () => navigate(() => disconnect(host)) },
      { id: 'd1', separator: true },
      { id: 'remove-host', label: '移除主机', danger: true, run: () => removeHost(host) }
    ];
  }

  function conversationActions(item: TaskView): ContextMenuEntry[] {
    const blocked = isActiveTaskStatus(item.status);
    return [
      { id: 'open', label: '打开对话', icon: 'chat', run: () => navigate(() => useUi.getState().selectConversation(item.id)) },
      { id: 'report', label: '查看完整报告', icon: 'expand', run: () => navigate(() => useUi.getState().openReport(item.id)) },
      { id: 'd1', separator: true },
      ...copyEntries('复制对话文本', conversationText(item)),
      { id: 'd2', separator: true },
      { id: 'delete', label: '删除对话', icon: 'close', danger: true, disabled: blocked,
        title: blocked ? '对话仍在进行中，请先停止或等待结束再删除' : '永久删除这条对话及其记录',
        run: () => deleteConversation(item) }
    ];
  }

  /** Deleting removes the conversation and its records; the backend re-checks state. */
  function deleteConversation(item: TaskView): void {
    setConfirmation({ title: `删除“${item.goal}”？`,
      message: '将永久删除这条对话的消息、操作记录与相关终端日志，无法恢复。相关标签会一并关闭。主机配置、凭据与其他对话不受影响。',
      label: '删除对话', action: () => window.cloudhelm.deleteConversation(item.id) });
  }

  function conversationText(item: TaskView): string {
    const messages = (snapshot?.messages ?? []).filter((message) => message.taskId === item.id);
    const lines = [`# ${item.goal}`, ...messages.map((message) => `${message.role === 'user' ? '你' : message.role === 'agent' ? 'CloudHelm' : '系统'}：${message.text}`)];
    return lines.join('\n\n');
  }

  function tabActions(tab: WorkspaceTab): ContextMenuEntry[] {
    const others = tabs.filter((item) => item.id !== tab.id);
    const othersLabel = others.length ? `关闭其他标签（${others.length}）` : '关闭其他标签';
    const allLabel = tabs.length > 1 ? `关闭全部标签（${tabs.length}）` : '关闭全部标签';
    return [
      { id: 'close', label: '关闭标签', icon: 'close', ...hintFor('tab.close'), run: () => navigate(() => closeTab(tab)) },
      { id: 'close-others', label: othersLabel, ...hintFor('tab.closeOthers'), disabled: !others.length,
        run: () => navigate(() => closeTabs(others)) },
      { id: 'close-all', label: allLabel, ...hintFor('tab.closeAll'), run: () => navigate(() => closeTabs([...tabs])) }
    ];
  }

  /** Fallback menu: native editing commands for fields, copy/select for plain text. */
  function handleContextMenu(event: React.MouseEvent): void {
    const field = editableTarget(event.target);
    if (field) { openContextMenu(event, editMenuEntries(field, bindings, isMac, setError), '编辑菜单'); return; }
    const selection = window.getSelection()?.toString().trim() ?? '';
    const entries: ContextMenuEntry[] = [];
    if (selection) entries.push({ id: 'copy-selection', label: '复制选中内容', icon: 'copy', run: () => void copyText(selection) });
    entries.push({ id: 'select-all', label: '全选', run: () => document.execCommand('selectAll') });
    openContextMenu(event, entries, '页面操作');
  }

  useKeyboardShortcuts({
    'terminal.new': () => { if (activeHost) void connectHost(activeHost.id, true); },
    'conversation.new': () => navigate(() => useUi.getState().newConversation(activeHostId ?? null)),
    'settings.open': () => navigate(() => useUi.getState().setSettingsOpen(true)),
    'tab.close': () => { if (activeTab) closeTab(activeTab); },
    'tab.closeOthers': () => { if (activeTab) closeTabs(tabs.filter((tab) => tab.id !== activeTab.id)); },
    'tab.closeAll': () => closeTabs([...tabs]),
    'tab.next': () => cycleTab(1),
    'tab.previous': () => cycleTab(-1),
    'agent.toggle': () => useUi.getState().toggleAgentPanel(),
    'terminal.toggleDrawer': () => { if (useUi.getState().layoutMode === 'agent') useUi.getState().toggleDrawer(); },
    'search.focus': () => { if (useUi.getState().layoutMode === 'agent') focusHostTreeSearch(); },
    'terminal.copy': () => { const target = terminalActions(terminalId); if (target?.getSelection()) void copyText(target.getSelection()); },
    'terminal.paste': () => { const text = readClipboardText(); void text.then((value) => { if (value) terminalActions(terminalId)?.paste(value); }).catch(() => undefined); },
    'terminal.selectAll': () => terminalActions(terminalId)?.selectAll(),
    'terminal.clear': () => terminalActions(terminalId)?.clear(),
    'terminal.quote': () => quoteTerminal()
  });

  const layoutProps: LayoutProps = {
    connecting, hiddenInputs, appVersion, navigate, connectHost, disconnect, closeTab, closeTabs, quoteTerminal,
    openInput: (id) => setHiddenInputs((items) => items.filter((item) => item !== id)),
    openHostDialog: () => navigate(() => setDialog({ kind: 'host' })),
    setError, reportTerminalError, reportConversationError, hostActions, conversationActions, tabActions, registerNavigationGuard
  };
  const sensitiveInput = snapshot?.inputs.find((input) => (input.kind === 'secret' || input.kind === 'otp') && !hiddenInputs.includes(input.id));
  const hosts = snapshot?.hosts.filter((host) => !host.archived) ?? [];
  return <div className={styles.app} onContextMenu={handleContextMenu}>
    {ui.layoutMode === 'agent' ? <AgentLayout {...layoutProps} /> : <SshLayout {...layoutProps} />}
    {dialog?.kind === 'host' && <HostDialog hosts={hosts} editing={snapshot?.hosts.find((host) => host.id === dialog.hostId)} close={() => setDialog(null)} report={setError} />}
    {dialog?.kind === 'safety' && snapshot?.hosts.find((host) => host.id === dialog.hostId) && <SafetyDialog host={snapshot.hosts.find((host) => host.id === dialog.hostId)!} close={() => setDialog(null)} report={setError} />}
    {confirmation && <ConfirmDialog title={confirmation.title} confirmLabel={confirmation.label} action={confirmation.action} close={() => setConfirmation(null)} report={setError}>{confirmation.message}</ConfirmDialog>}
    {fingerprint && <div className={styles.scrim}><div className={styles.dialog} role="dialog" aria-modal="true" aria-label="核对 SSH 主机指纹">
      <h2>核对 SSH 主机指纹</h2><p>{hostName(fingerprint.hostId)} 的服务器身份需要确认。请通过可信渠道核对以下指纹；一致后再连接。</p><code className={styles.fingerprint}>{fingerprint.value}</code>
      <div className={styles.dialogActions}><button onClick={() => setFingerprint(null)}>取消</button><button className={styles.primary} onClick={() => void capture(async () => { const target = fingerprint; await window.cloudhelm.trustHostKey(target.hostId, target.value); setFingerprint(null); await connectHost(target.hostId); }, setError)}>已核对，信任并连接</button></div>
    </div></div>}
    {sensitiveInput && <div className={styles.scrim}><InputCard key={sensitiveInput.id} input={sensitiveInput} host={hostName(sensitiveInput.hostId)} report={setError} later={() => setHiddenInputs((items) => [...items, sensitiveInput.id])} /></div>}
    {error && <ErrorDialog key={JSON.stringify([error.code, error.context])} notice={error} close={dismissError} configureModel={() => useUi.getState().setSettingsOpen(true)} />}
    <ContextMenuHost />
    {quoteNotice && <div role="status" style={{ position: 'fixed', bottom: 20, left: '50%', padding: '8px 14px', background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, zIndex: 50 }}>{quoteNotice}</div>}
  </div>;
}
