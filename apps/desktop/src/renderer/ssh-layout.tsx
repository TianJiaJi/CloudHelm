import { terminalPresentation } from './execution-workspace-view.js';
import { Fragment, useState } from 'react';
import type { HostView, TaskView } from '@cloudhelm/contracts';
import { useUi, type WorkspaceTab } from './store.js';
import { TerminalView } from './terminal-view.js';
import { TerminalControl } from './terminal-control.js';
import { ModelSettingsDialog } from './model-settings.js';
import { PanelChrome } from './panel-chrome.js';
import { StreamArea } from './stream-area.js';
import { FilesPage, ReportPage } from './workspace-pages.js';
import { Icon, statusLabel } from './ui-helpers.js';
import { AnchoredMenu } from './anchored-menu.js';
import { MenuEntryList, openContextMenu, type ContextMenuEntry } from './context-menu.js';
import { LayoutSwitcher } from './layout-switcher.js';
import { conversationHostKey, hostLineage } from './host-lineage.js';
import type { LayoutProps } from './layout-props.js';
import { Badge, Button, PanelSurface, StatusDot } from './ui/index.js';
import styles from './ui.module.css';

/**
 * Terminal-first layout. Returns a fragment so sidebar, workspace, resizer and
 * the assistant rail stay direct children of `.app`, byte-identical to the
 * structure this mode has always rendered.
 */
export function SshLayout({ connecting, hiddenInputs, appVersion, navigate, connectHost, disconnect, closeTab,
  quoteTerminal, openInput, openHostDialog, setError, reportTerminalError, reportConversationError, hostActions,
  conversationActions, tabActions, registerNavigationGuard }: LayoutProps): React.JSX.Element {
  const ui = useUi();
  const { snapshot, terminals, tabs, activeTabId, activeHostId, selectedConversationId, settingsOpen, agentPanelOpen } = ui;
  const [hostMenu, setHostMenu] = useState<{ hostId: string; anchor: HTMLButtonElement } | null>(null);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const activeTerminal = activeTab?.kind === 'terminal' ? terminals[activeTab.terminalId] : undefined;
  const conversation = snapshot?.conversations.find((item) => item.id === selectedConversationId);
  const activeHost = snapshot?.hosts.find((host) => host.id === activeHostId);
  const hostName = (hostId: string): string => snapshot?.hosts.find((host) => host.id === hostId)?.label ?? hostId;
  const pendingCount = (snapshot?.approvals.length ?? 0) + (snapshot?.inputs.length ?? 0);
  const hosts = snapshot?.hosts.filter((host) => !host.archived) ?? [];
  const groups = [...new Set(hosts.map((host) => host.group?.trim() || ''))].sort((a, b) => a && b ? a.localeCompare(b) : a ? -1 : b ? 1 : 0);

  function tabLabel(tab: WorkspaceTab): string {
    if (tab.kind === 'files') return `${hostName(tab.hostId)} · 文件`;
    if (tab.kind === 'report') return 'AI 对话详情';
    const terminal = terminals[tab.terminalId];
    return `${hostName(tab.hostId)}${terminal && snapshot ? ` · ${terminalPresentation(terminal, snapshot).label}` : ''}`;
  }

  return <>
    <PanelSurface as="aside" className={styles.sidebar}>
      <LayoutSwitcher />
      <div className={styles.sectionHead}><span>远程主机</span><button title="添加主机" aria-label="添加主机" onClick={openHostDialog}><Icon name="plus" /></button></div>
      <div className={styles.hostList}>{groups.map((group) => <Fragment key={group}>
        {(group || groups.length > 1) && <h3 className={styles.hostGroupLabel}>{group || '未分组'}</h3>}
        {hosts.filter((host) => (host.group?.trim() || '') === group).map((host) => {
        const lineage = hostLineage(host, snapshot?.hosts ?? []);
        const working = snapshot?.conversations.find((item) => item.hostIds.some((id) => lineage.includes(id)) && ['running', 'waiting-review', 'waiting-user', 'recovering', 'human-control'].includes(item.status));
        return <div className={`${styles.hostRow} ${activeHostId && lineage.includes(activeHostId) ? styles.selected : ''}`} key={host.id}
          onContextMenu={(event) => openContextMenu(event, hostActions(host), `${host.label} 主机操作`)}>
          <button className={styles.hostSelect} onClick={() => navigate(() => void connectHost(host.id))} title={`${host.username}@${host.address}:${host.port}`} disabled={connecting.includes(host.id)}>
            <Icon name="server" /><span>{host.label}<small>{connecting.includes(host.id) ? '正在连接…' : working ? statusLabel[working.status] : `${host.username}@${host.address}`}</small></span>
            <StatusDot active={host.status === 'connected'} />
          </button>
          <button className={styles.hostMore} aria-label={`${host.label} 更多操作`} title="主机操作" aria-haspopup="menu" aria-expanded={hostMenu?.hostId === host.id}
            onClick={(event) => setHostMenu(hostMenu?.hostId === host.id ? null : { hostId: host.id, anchor: event.currentTarget })}><Icon name="more" /></button>
          {hostMenu?.hostId === host.id && <AnchoredMenu anchor={hostMenu.anchor} label={`${host.label} 主机操作`} close={() => setHostMenu(null)}>
            <MenuEntryList entries={hostActions(host)} close={() => setHostMenu(null)} />
          </AnchoredMenu>}
        </div>;
      })}</Fragment>)}{!hosts.length && <button className={styles.addHostEmpty} onClick={openHostDialog}><Icon name="plus" />添加第一台主机</button>}</div>
      <div className={styles.sectionHead}><span>AI 对话历史</span><button title="新的自由对话" aria-label="新的自由对话" onClick={() => navigate(() => useUi.getState().newConversation(null))}><Icon name="plus" /></button></div>
      <div className={styles.historyList}>{snapshot && <HistoryList hosts={snapshot.hosts} select={(id) => navigate(() => useUi.getState().selectConversation(id))} menu={conversationActions} />}</div>
      <div className={styles.sidebarFoot}><button className={settingsOpen ? styles.selected : ''} onClick={() => navigate(() => useUi.getState().setSettingsOpen(!settingsOpen))}><Icon name="settings" />设置</button><small>{appVersion ? `CloudHelm · ${appVersion}` : 'CloudHelm'}</small></div>
    </PanelSurface>

    <PanelSurface as="main" className={styles.workspace}>
      <header className={styles.toolbar}><div className={styles.tabs}>{tabs.map((tab) => <div key={tab.id} className={`${styles.tab} ${!settingsOpen && activeTabId === tab.id ? styles.activeTab : ''}`}
        onContextMenu={(event) => openContextMenu(event, tabActions(tab), `${tabLabel(tab)} 标签操作`)}
        onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
        onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); event.stopPropagation(); navigate(() => closeTab(tab)); } }}>
        <button className={styles.tabSelect} title={tab.kind === 'terminal' && terminals[tab.terminalId] && snapshot ? terminalPresentation(terminals[tab.terminalId]!, snapshot).title : tabLabel(tab)} onClick={() => navigate(() => useUi.getState().selectTab(tab.id))}><Icon name={tab.kind === 'terminal' ? 'terminal' : tab.kind === 'files' ? 'folder' : 'chat'} size={14} /><span>{tabLabel(tab)}</span></button>
        <button className={styles.tabClose} aria-label={`关闭 ${tabLabel(tab)}`} title="关闭标签" onClick={() => navigate(() => closeTab(tab))}><Icon name="close" size={12} /></button>
      </div>)}</div>{activeHost && <button title="新终端" aria-label="新终端" onClick={() => navigate(() => void connectHost(activeHost.id, true))}><Icon name="plus" /></button>}
        {!agentPanelOpen && <button className={styles.panelButton} onClick={useUi.getState().toggleAgentPanel}><Icon name="chat" />AI 助手{pendingCount > 0 && <Badge>{pendingCount}</Badge>}</button>}</header>
      {settingsOpen && snapshot ? <ModelSettingsDialog current={snapshot.profile} close={() => useUi.getState().setSettingsOpen(false)} report={setError} registerNavigationGuard={registerNavigationGuard} />
        : activeTerminal ? <div className={styles.terminalArea}>
          <div className={styles.terminalToolbar}><span title={snapshot ? terminalPresentation(activeTerminal, snapshot).title : undefined}><StatusDot active />{hostName(activeTerminal.hostId)} · {snapshot ? terminalPresentation(activeTerminal, snapshot).label : 'SSH 终端'}</span>
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
              <Button variant="primary" onClick={() => activeHost ? void connectHost(activeHost.id) : openHostDialog()}>{activeHost ? '连接主机' : '添加主机'}</Button></div>}
    </PanelSurface>
    {agentPanelOpen && !settingsOpen && <><PanelResizer /><PanelSurface as="aside" className={styles.agentPanel} style={{ width: ui.agentPanelWidth }}>
      {snapshot ? <PanelChrome snapshot={snapshot} host={activeHost} conversation={conversation}>
        <StreamArea snapshot={snapshot} host={activeHost} conversation={conversation} report={reportConversationError} hiddenInputs={hiddenInputs} openInput={openInput} />
      </PanelChrome> : <div className={styles.agentWelcome}>正在加载 AI 助手…</div>}
    </PanelSurface></>}
  </>;
}

function HistoryList({ hosts, select, menu }: {
  hosts: HostView[]; select(id: string): void; menu(conversation: TaskView): ContextMenuEntry[];
}): React.JSX.Element {
  const snapshot = useUi((state) => state.snapshot);
  const selected = useUi((state) => state.selectedConversationId);
  const conversations = [...(snapshot?.conversations ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
  const groups = new Map<string, typeof conversations>();
  for (const conversation of conversations) {
    const key = conversationHostKey(conversation, hosts);
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
