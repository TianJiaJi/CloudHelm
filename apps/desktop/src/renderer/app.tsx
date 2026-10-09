import { draftFor, insertTerminalReference, useMessageDrafts } from './message-drafts.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { HostView, TaskView } from '@cloudhelm/contracts';
import { isActiveTaskStatus } from '@cloudhelm/contracts';
import { useUi, type WorkspaceTab } from './store.js';
import { TerminalView } from './terminal-view.js';
import { TerminalControl } from './terminal-control.js';
import { ModelSettingsDialog } from './model-settings.js';
import { AgentPanel } from './agent-panel.js';
import { HostDialog, SafetyDialog, ConfirmDialog } from './host-dialogs.js';
import { InputCard } from './interaction-cards.js';
import { FilesPage, ReportPage } from './workspace-pages.js';
import { capture, Icon, statusLabel } from './ui-helpers.js';
import { ErrorDialog } from './error-dialog.js';
import { useErrorNotices } from './use-error-notices.js';
import { AnchoredMenu } from './anchored-menu.js';
import { ContextMenuHost, MenuEntryList, openContextMenu, type ContextMenuAction, type ContextMenuEntry } from './context-menu.js';
import { copyEntries, copyText, readClipboardText } from './clipboard.js';
import { editableTarget, editMenuEntries } from './edit-menu.js';
import { useKeyboardShortcuts } from './use-shortcuts.js';
import { useShortcuts } from './shortcut-store.js';
import { isMacPlatform, menuHint, type ShortcutActionId, type ShortcutContext } from './shortcuts.js';
import { terminalActions } from './terminal-actions.js';
import styles from './ui.module.css';

type Confirmation = { title: string; message: string; label: string; action(): Promise<void> };
type Dialog = { kind: 'host'; hostId?: string } | { kind: 'safety'; hostId: string } | null;
type Hint = Pick<ContextMenuAction, 'hint' | 'hintMuted'>;

function hostLineage(host: HostView, hosts: HostView[]): string[] {
  const ids = [host.id];
  let previousId = host.previousHostId;
  while (previousId && !ids.includes(previousId)) { ids.push(previousId); previousId = hosts.find((item) => item.id === previousId)?.previousHostId; }
  return ids;
}

export function App(): React.JSX.Element {
  const ui = useUi();
  const { snapshot, terminals, tabs, activeTabId, activeHostId, selectedConversationId, settingsOpen, agentPanelOpen } = ui;
  const bindings = useShortcuts((state) => state.bindings);
  const shortcutsEnabled = useShortcuts((state) => state.enabled);
  const isMac = isMacPlatform();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [hostMenu, setHostMenu] = useState<{ hostId: string; anchor: HTMLButtonElement } | null>(null);
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
  const conversation = snapshot?.conversations.find((item) => item.id === selectedConversationId);
  const activeHost = snapshot?.hosts.find((host) => host.id === activeHostId);
  const hostName = (hostId: string): string => snapshot?.hosts.find((host) => host.id === hostId)?.label ?? hostId;
  const pendingCount = (snapshot?.approvals.length ?? 0) + (snapshot?.inputs.length ?? 0);

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
            compressing: event.status === 'compressing', compressingReference: event.referenceId
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
      for (const conversation of event.value.conversations) {
        const before = previousStatuses.get(conversation.id);
        if (before && before !== 'failed' && conversation.status === 'failed') {
          setError(conversation.summary || 'Unknown conversation failure', { conversationId: conversation.id });
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
    setHostMenu(null);
    setConfirmation({ title: `断开 ${host.label}？`, message: '将断开这台主机的 SSH 会话。正在执行的命令可能仍在远端运行，重新连接后会先核验结果。', label: '断开 SSH',
      action: () => window.cloudhelm.disconnectHost(host.id) });
  }

  function removeHost(host: HostView): void {
    setHostMenu(null);
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
      const reference = await window.cloudhelm.quoteTerminal({ terminalId: source.id, hostId: source.hostId, conversationId, selection });
      insertTerminalReference(key, reference);
      setQuoteNotice('已添加到 AI 对话草稿');
      if (useUi.getState().activeTabId === source.id) terminalActions(source.id)?.focus();
    }, setError);
  }

  function tabLabel(tab: WorkspaceTab): string {
    if (tab.kind === 'files') return `${hostName(tab.hostId)} · 文件`;
    if (tab.kind === 'report') return 'AI 对话详情';
    const terminal = terminals[tab.terminalId];
    return `${hostName(tab.hostId)}${terminal?.replacementTerminalId ? ' · 人工' : terminal?.taskId ? ' · AI' : ''}`;
  }

  function hostActions(host: HostView): ContextMenuEntry[] {
    return [
      { id: 'edit-host', label: '编辑主机', icon: 'settings', run: () => navigate(() => { setHostMenu(null); setDialog({ kind: 'host', hostId: host.id }); }) },
      { id: 'safety', label: '安全设置', icon: 'shield', run: () => navigate(() => { setHostMenu(null); setDialog({ kind: 'safety', hostId: host.id }); }) },
      { id: 'new-terminal', label: '新终端', icon: 'terminal', ...hintFor('terminal.new'),
        run: () => navigate(() => { setHostMenu(null); void connectHost(host.id, true); }) },
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
    'terminal.copy': () => { const target = terminalActions(terminalId); if (target?.getSelection()) void copyText(target.getSelection()); },
    'terminal.paste': () => { const text = readClipboardText(); void text.then((value) => { if (value) terminalActions(terminalId)?.paste(value); }).catch(() => undefined); },
    'terminal.selectAll': () => terminalActions(terminalId)?.selectAll(),
    'terminal.clear': () => terminalActions(terminalId)?.clear(),
    'terminal.quote': () => quoteTerminal()
  });

  const sensitiveInput = snapshot?.inputs.find((input) => (input.kind === 'secret' || input.kind === 'otp') && !hiddenInputs.includes(input.id));
  const hosts = snapshot?.hosts.filter((host) => !host.archived) ?? [];
  return <div className={styles.app} onContextMenu={handleContextMenu}>
    <aside className={styles.sidebar}>
      <div className={styles.brand}><span className={styles.brandIcon}><Icon name="terminal" size={18} /></span>CloudHelm</div>
      <div className={styles.sectionHead}><span>远程主机</span><button title="添加主机" aria-label="添加主机" onClick={() => navigate(() => setDialog({ kind: 'host' }))}><Icon name="plus" /></button></div>
      <div className={styles.hostList}>{hosts.map((host) => {
        const lineage = hostLineage(host, snapshot?.hosts ?? []);
        const working = snapshot?.conversations.find((item) => item.hostIds.some((id) => lineage.includes(id)) && ['running', 'waiting-review', 'waiting-user', 'recovering', 'human-control'].includes(item.status));
        return <div className={`${styles.hostRow} ${activeHostId && lineage.includes(activeHostId) ? styles.selected : ''}`} key={host.id}
          onContextMenu={(event) => openContextMenu(event, hostActions(host), `${host.label} 主机操作`)}>
          <button className={styles.hostSelect} onClick={() => navigate(() => void connectHost(host.id))} title={`${host.username}@${host.address}:${host.port}`} disabled={connecting.includes(host.id)}>
            <Icon name="server" /><span>{host.label}<small>{connecting.includes(host.id) ? '正在连接…' : working ? statusLabel[working.status] : `${host.username}@${host.address}`}</small></span>
            <i className={`${styles.dot} ${host.status === 'connected' ? styles.online : ''}`} />
          </button>
          <button className={styles.hostMore} aria-label={`${host.label} 更多操作`} title="主机操作" aria-haspopup="menu" aria-expanded={hostMenu?.hostId === host.id}
            onClick={(event) => setHostMenu(hostMenu?.hostId === host.id ? null : { hostId: host.id, anchor: event.currentTarget })}><Icon name="more" /></button>
          {hostMenu?.hostId === host.id && <AnchoredMenu anchor={hostMenu.anchor} label={`${host.label} 主机操作`} close={() => setHostMenu(null)}>
            <MenuEntryList entries={hostActions(host)} />
          </AnchoredMenu>}
        </div>;
      })}{!hosts.length && <button className={styles.addHostEmpty} onClick={() => navigate(() => setDialog({ kind: 'host' }))}><Icon name="plus" />添加第一台主机</button>}</div>
      <div className={styles.sectionHead}><span>AI 对话历史</span><button title="新的自由对话" aria-label="新的自由对话" onClick={() => navigate(() => useUi.getState().newConversation(null))}><Icon name="plus" /></button></div>
      <div className={styles.historyList}>{snapshot && <HistoryList hosts={snapshot.hosts} select={(id) => navigate(() => useUi.getState().selectConversation(id))} menu={conversationActions} />}</div>
      <div className={styles.sidebarFoot}><button className={settingsOpen ? styles.selected : ''} onClick={() => navigate(() => useUi.getState().setSettingsOpen(!settingsOpen))}><Icon name="settings" />设置</button><small>{appVersion ? `CloudHelm · ${appVersion}` : 'CloudHelm'}</small></div>
    </aside>

    <main className={styles.workspace}>
      <header className={styles.toolbar}><div className={styles.tabs}>{tabs.map((tab) => <div key={tab.id} className={`${styles.tab} ${!settingsOpen && activeTabId === tab.id ? styles.activeTab : ''}`}
        onContextMenu={(event) => openContextMenu(event, tabActions(tab), `${tabLabel(tab)} 标签操作`)}
        onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
        onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); event.stopPropagation(); navigate(() => closeTab(tab)); } }}>
        <button className={styles.tabSelect} onClick={() => navigate(() => useUi.getState().selectTab(tab.id))}><Icon name={tab.kind === 'terminal' ? 'terminal' : tab.kind === 'files' ? 'folder' : 'chat'} size={14} /><span>{tabLabel(tab)}</span></button>
        <button className={styles.tabClose} aria-label={`关闭 ${tabLabel(tab)}`} title="关闭标签" onClick={() => navigate(() => closeTab(tab))}><Icon name="close" size={12} /></button>
      </div>)}</div>{activeHost && <button title="新终端" aria-label="新终端" onClick={() => navigate(() => void connectHost(activeHost.id, true))}><Icon name="plus" /></button>}
        {!agentPanelOpen && <button className={styles.panelButton} onClick={useUi.getState().toggleAgentPanel}><Icon name="chat" />AI 助手{pendingCount > 0 && <b>{pendingCount}</b>}</button>}</header>
      {settingsOpen && snapshot ? <ModelSettingsDialog current={snapshot.profile} close={() => useUi.getState().setSettingsOpen(false)} report={setError} registerNavigationGuard={registerNavigationGuard} />
        : activeTerminal ? <div className={styles.terminalArea}>
          <div className={styles.terminalToolbar}><span><i className={`${styles.dot} ${styles.online}`} />{hostName(activeTerminal.hostId)} · {activeTerminal.taskId ? 'AI 专用终端' : 'SSH 终端'}</span>
            <TerminalControl key={activeTerminal.id} terminal={activeTerminal} report={reportTerminalError} />
            <button title="引用选区，或最后一条命令及其全部输出" onClick={quoteTerminal}>引用输出</button>
            <button onClick={() => useUi.getState().openFiles(activeTerminal.hostId)}><Icon name="folder" size={13} />文件</button>
            {activeHost && <button title="断开 SSH" aria-label="断开 SSH" onClick={() => disconnect(activeHost)}><Icon name="disconnect" size={13} /></button>}
          </div>
          {activeTerminal.taskId && <div className={styles.terminalNotice}>{activeTerminal.replacementTerminalId ? 'AI 已切换到新的专用终端。此终端保留供你查看输出或继续人工操作。' : activeTerminal.state === 'human' ? '可以直接输入命令；只有发送消息或点击“继续 AI”才会启动 AI。' : 'AI 执行期间禁止输入。按 Ctrl+C 或点击“停止”，待命令退出后即可输入；停止不会启动新对话。'}</div>}
          <TerminalView terminalId={activeTerminal.id} report={reportTerminalError} onQuote={quoteTerminal}
            onNewTerminal={activeHost ? () => void connectHost(activeHost.id, true) : undefined} />
        </div> : activeTab?.kind === 'files' ? <FilesPage key={activeTab.id} hostId={activeTab.hostId} host={hostName(activeTab.hostId)} report={setError} />
          : activeTab?.kind === 'report' && snapshot?.conversations.find((item) => item.id === activeTab.conversationId) ? <ReportPage conversation={snapshot.conversations.find((item) => item.id === activeTab.conversationId)!} operations={snapshot.operations.filter((item) => item.taskId === activeTab.conversationId)} report={setError} />
            : <div className={styles.empty}><span className={styles.emptyGlyph}><Icon name="terminal" size={36} /></span><h1>{activeHost ? activeHost.label : '你的服务器，随时连接'}</h1><p>{activeHost ? '点击连接，打开真实 SSH 终端。右侧对话仍限定在这台主机。' : '从左侧选择主机，开始 SSH 会话。AI 助手会一直在旁边。'}</p>
              <button className={styles.primary} onClick={() => activeHost ? void connectHost(activeHost.id) : setDialog({ kind: 'host' })}>{activeHost ? '连接主机' : '添加主机'}</button></div>}
    </main>
    {agentPanelOpen && !settingsOpen && <><PanelResizer /><aside className={styles.agentPanel} style={{ width: ui.agentPanelWidth }}>
      {snapshot ? <AgentPanel snapshot={snapshot} host={activeHost} conversation={conversation} report={reportConversationError} hiddenInputs={hiddenInputs} openInput={(id) => setHiddenInputs((items) => items.filter((item) => item !== id))} /> : <div className={styles.agentWelcome}>正在加载 AI 助手…</div>}
    </aside></>}
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

function HistoryList({ hosts, select, menu }: {
  hosts: HostView[]; select(id: string): void; menu(conversation: TaskView): ContextMenuEntry[];
}): React.JSX.Element {
  const snapshot = useUi((state) => state.snapshot);
  const selected = useUi((state) => state.selectedConversationId);
  const conversations = [...(snapshot?.conversations ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
  const groups = new Map<string, typeof conversations>();
  for (const conversation of conversations) {
    const originalHostId = conversation.hostIds[0];
    const currentHost = originalHostId ? hosts.find((host) => !host.archived && hostLineage(host, hosts).includes(originalHostId)) : undefined;
    const key = conversation.hostIds.length > 1 ? 'legacy' : currentHost?.id ?? originalHostId ?? 'chat';
    groups.set(key, [...(groups.get(key) ?? []), conversation]);
  }
  return <>{[...groups].map(([key, items]) => <details key={key} className={styles.historyGroup} open>
    <summary>{key === 'chat' ? '自由对话' : key === 'legacy' ? '旧版多主机记录' : hosts.find((host) => host.id === key)?.label ?? '历史主机'}</summary>
    {items.map((item) => <button key={item.id} className={`${styles.historyRow} ${selected === item.id ? styles.selected : ''}`}
      onContextMenu={(event) => openContextMenu(event, menu(item), `${item.goal} 对话操作`)}
      onClick={() => select(item.id)}>
      <Icon name="chat" size={13} /><span>{item.goal}<small>{statusLabel[item.status]}</small></span>
    </button>)}
  </details>)}{!conversations.length && <p className={styles.historyEmpty}>发送第一条消息后，对话会自动保存在这里。</p>}</>;
}

function PanelResizer(): React.JSX.Element {
  function resize(event: React.PointerEvent<HTMLDivElement>): void {
    event.currentTarget.setPointerCapture(event.pointerId);
    const initialX = event.clientX;
    const initialWidth = useUi.getState().agentPanelWidth;
    const element = event.currentTarget;
    const move = (pointer: PointerEvent): void => useUi.getState().setAgentPanelWidth(initialWidth + initialX - pointer.clientX);
    const stop = (): void => { element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', stop); element.removeEventListener('pointercancel', stop); };
    element.addEventListener('pointermove', move); element.addEventListener('pointerup', stop); element.addEventListener('pointercancel', stop);
  }
  return <div className={styles.panelResizer} role="separator" aria-label="调整 AI 助手宽度" aria-orientation="vertical" tabIndex={0} onPointerDown={resize}
    onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); useUi.getState().setAgentPanelWidth(useUi.getState().agentPanelWidth + (event.key === 'ArrowLeft' ? 20 : -20)); } }} />;
}
