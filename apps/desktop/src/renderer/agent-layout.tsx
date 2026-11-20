import { useState } from 'react';
import { useUi } from './store.js';
import { ModelSettingsDialog } from './model-settings.js';
import { StreamArea } from './stream-area.js';
import { HostTree } from './host-tree.js';
import { TerminalDrawer } from './terminal-drawer.js';
import { AuxPanel } from './aux-panel.js';
import { Icon, reviewLabel, statusLabel } from './ui-helpers.js';
import type { LayoutProps } from './layout-props.js';
import { PanelSurface, Pill, SegmentedControl, type SegmentedOption } from './ui/index.js';
import { contextUsagePresentation } from './context-usage.js';
import type { StreamFilter } from './conversation-transcript.js';
import panelStyles from './agent-panel.module.css';
import styles from './agent-layout.module.css';

const streamFilterOptions: SegmentedOption<StreamFilter>[] = [
  { value: 'all', label: '全部' },
  { value: 'commands', label: '命令' },
  { value: 'interactions', label: '交互' },
  { value: 'notices', label: '通知' }
];

/**
 * Chat-first layout: host tree on the left, the full-width assistant stream in
 * the middle, an aux panel for files/report tabs, and the terminal drawer below.
 */
export function AgentLayout({ connecting, hiddenInputs, appVersion, navigate, connectHost, disconnect, closeTab,
  quoteTerminal, openInput, openHostDialog, setError, reportTerminalError, reportConversationError, hostActions,
  conversationActions, registerNavigationGuard }: LayoutProps): React.JSX.Element {
  const { snapshot, activeHostId, selectedConversationId, settingsOpen, drawerOpen } = useUi();
  const [streamFilter, setStreamFilter] = useState<StreamFilter>('all');
  const conversation = snapshot?.conversations.find((item) => item.id === selectedConversationId);
  const activeHost = snapshot?.hosts.find((host) => host.id === activeHostId);
  const usage = conversation && snapshot ? snapshot.contextUsage?.[conversation.id] : undefined;
  const compaction = conversation && snapshot ? snapshot.contextCompaction?.[conversation.id] : undefined;
  const contextLine = usage || compaction ? ` · ${contextUsagePresentation(usage, compaction).label}` : '';
  return <div className={styles.shell}>
    <div className={styles.row}>
      <HostTree connecting={connecting} appVersion={appVersion} navigate={navigate} connectHost={connectHost}
        openHostDialog={openHostDialog} hostActions={hostActions} conversationActions={conversationActions} />
      <PanelSurface as="main" className={styles.workspace}>
        {settingsOpen && snapshot
          ? <ModelSettingsDialog current={snapshot.profile} close={() => useUi.getState().setSettingsOpen(false)} report={setError} registerNavigationGuard={registerNavigationGuard} />
          : <>
            <header className={styles.topbar}>
              <span className={styles.crumb} title={conversation?.goal}>
                <span>{activeHost ? activeHost.label : '自由对话'}</span>
                <Icon name="chevron" size={11} />
                <strong>{conversation ? conversation.goal : '新对话'}</strong>
              </span>
              {activeHost && <Pill className={styles.topbarPill} title="当前对话的权限档位；切换请使用输入框的权限选择">{reviewLabel[conversation?.reviewModesByHost?.[activeHost.id] ?? activeHost.defaultMode]}</Pill>}
              {conversation && <small className={styles.topbarMeta}>{statusLabel[conversation.status]} · {conversation.requestCount} 次请求{contextLine}</small>}
              <span className={styles.topbarSeg}><SegmentedControl options={streamFilterOptions} value={streamFilter}
                onValueChange={(next: StreamFilter) => setStreamFilter(next)} size="compact" ariaLabel="筛选对话流" /></span>
              <button aria-pressed={drawerOpen} onClick={() => useUi.getState().toggleDrawer()}><Icon name="terminal" size={13} />终端</button>
            </header>
            <div className={`${styles.stream} ${panelStyles.panel}`}>
              {snapshot ? <StreamArea snapshot={snapshot} host={activeHost} conversation={conversation} report={reportConversationError} hiddenInputs={hiddenInputs} openInput={openInput} streamFilter={streamFilter} />
                : <div className={styles.loading}>正在加载…</div>}
            </div>
          </>}
      </PanelSurface>
      <AuxPanel report={setError} closeTab={closeTab} />
    </div>
    <TerminalDrawer quoteTerminal={quoteTerminal} disconnect={disconnect} closeTab={closeTab} connectHost={connectHost} reportTerminalError={reportTerminalError} />
  </div>;
}
