import { useState } from 'react';
import type { HostView } from '@cloudhelm/contracts';
import { useUi, type TerminalTab, type WorkspaceTab } from './store.js';
import { TerminalView } from './terminal-view.js';
import { TerminalControl } from './terminal-control.js';
import { terminalPresentation } from './execution-workspace-view.js';
import { Icon } from './ui-helpers.js';
import { StatusDot } from './ui/status-dot.js';
import styles from './terminal-drawer.module.css';

/**
 * Bottom terminal drawer of the agent layout. Its tabs are the terminal-kind
 * workspace tabs, so drawer and tab model stay one source of truth.
 */
export function TerminalDrawer({ quoteTerminal, disconnect, closeTab, connectHost, reportTerminalError }: {
  quoteTerminal(): void; disconnect(host: HostView): void; closeTab(tab: WorkspaceTab): void;
  connectHost(hostId: string, alwaysNew?: boolean): Promise<void>; reportTerminalError(message: string): void;
}): React.JSX.Element | null {
  const { snapshot, terminals, tabs, activeTabId, drawerOpen, drawerHeight } = useUi();
  const [fullscreen, setFullscreen] = useState(false);
  if (!drawerOpen) return null;
  const terminalTabs = tabs.filter((tab) => tab.kind === 'terminal');
  const activeDrawerTab = activeTabId && terminalTabs.some((tab) => tab.id === activeTabId)
    ? terminalTabs.find((tab) => tab.id === activeTabId) : terminalTabs.at(-1);
  const activeTerminal = activeDrawerTab?.kind === 'terminal' ? terminals[activeDrawerTab.terminalId] : undefined;
  const activeHost = activeTerminal ? snapshot?.hosts.find((host) => host.id === activeTerminal.hostId) : undefined;
  const labelFor = (terminal: TerminalTab): string => snapshot ? terminalPresentation(terminal, snapshot).label : 'SSH 终端';
  const titleFor = (terminal: TerminalTab): string => snapshot ? terminalPresentation(terminal, snapshot).title : 'SSH 终端';
  function startResize(event: React.PointerEvent<HTMLDivElement>): void {
    if (fullscreen) setFullscreen(false);
    event.currentTarget.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = useUi.getState().drawerHeight;
    const element = event.currentTarget;
    const move = (pointer: PointerEvent): void => {
      const max = window.innerHeight - 34;
      useUi.getState().setDrawerHeight(Math.min(max, startHeight + startY - pointer.clientY));
    };
    const stop = (): void => { element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', stop); element.removeEventListener('pointercancel', stop); };
    element.addEventListener('pointermove', move); element.addEventListener('pointerup', stop); element.addEventListener('pointercancel', stop);
  }
  return <section className={styles.drawer} style={{ height: fullscreen ? 'calc(100vh - 34px)' : `${drawerHeight}px` }} aria-label="终端抽屉">
    <div className={styles.handle} role="separator" aria-orientation="horizontal" aria-label="调整终端抽屉高度" tabIndex={0}
      onPointerDown={startResize} onDoubleClick={() => setFullscreen((value) => !value)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp') { event.preventDefault(); useUi.getState().setDrawerHeight(useUi.getState().drawerHeight + 20); }
        else if (event.key === 'ArrowDown') { event.preventDefault(); useUi.getState().setDrawerHeight(useUi.getState().drawerHeight - 20); }
        else if (event.key === 'Enter') { event.preventDefault(); setFullscreen((value) => !value); }
      }} />
    <div className={styles.bar}>
      <div className={styles.tabs}>
        {terminalTabs.map((tab) => tab.kind === 'terminal' && terminals[tab.terminalId] && (
          <div key={tab.id} className={`${styles.tab} ${activeDrawerTab?.id === tab.id ? styles.activeTab : ''}`}>
            <button className={styles.tabSelect} title={titleFor(terminals[tab.terminalId]!)} onClick={() => useUi.getState().selectTab(tab.id)}>
              <StatusDot active={terminals[tab.terminalId]!.state === 'agent'} /><span>{labelFor(terminals[tab.terminalId]!)}</span>
            </button>
            <button className={styles.tabClose} aria-label={`关闭 ${labelFor(terminals[tab.terminalId]!)}`} title="关闭标签" onClick={() => closeTab(tab)}><Icon name="close" size={11} /></button>
          </div>))}
        <button className={styles.newTab} title="新终端" aria-label="新终端"
          onClick={() => { const hostId = activeTerminal?.hostId ?? useUi.getState().activeHostId; if (hostId) void connectHost(hostId, true); }}><Icon name="plus" size={13} /></button>
      </div>
      {activeTerminal && <div className={styles.actions}>
        <TerminalControl key={activeTerminal.id} terminal={activeTerminal} report={reportTerminalError} />
        <button title="引用选区，或最后一条命令及其全部输出" onClick={quoteTerminal}>引用输出</button>
        {activeHost && <button title="断开 SSH" aria-label="断开 SSH" onClick={() => disconnect(activeHost)}><Icon name="disconnect" size={13} /></button>}
      </div>}
      <div className={styles.actions}>
        <button title={fullscreen ? '退出全屏' : '全屏'} aria-label={fullscreen ? '退出全屏' : '全屏'} onClick={() => setFullscreen((value) => !value)}><Icon name="expand" size={13} /></button>
        <button className={styles.collapse} title="收起终端抽屉" aria-label="收起终端抽屉" onClick={() => useUi.getState().toggleDrawer()}><Icon name="chevron" size={13} /></button>
      </div>
    </div>
    <div className={styles.body}>
      {activeTerminal ? <>
        {activeTerminal.taskId && <div className={styles.notice}>{activeTerminal.replacementTerminalId ? 'AI 已切换到新的专用终端。此终端保留供你查看输出或继续人工操作。' : activeTerminal.state === 'human' ? '可以直接输入命令；只有发送消息或点击“继续 AI”才会启动 AI。' : 'AI 执行期间禁止输入。按 Ctrl+C 或点击“停止”，待命令退出后即可输入；停止不会启动新对话。'}</div>}
        <TerminalView terminalId={activeTerminal.id} report={reportTerminalError} onQuote={quoteTerminal}
          onNewTerminal={activeHost ? () => void connectHost(activeHost.id, true) : undefined} />
      </> : <div className={styles.empty}>暂无终端。点击左侧主机连接，或按上方 + 新建。</div>}
    </div>
  </section>;
}
