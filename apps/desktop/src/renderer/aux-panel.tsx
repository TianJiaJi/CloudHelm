import { useUi, type WorkspaceTab } from './store.js';
import { FilesPage, ReportPage } from './workspace-pages.js';
import { Icon } from './ui-helpers.js';
import styles from './aux-panel.module.css';

/**
 * Right-hand auxiliary panel of the agent layout. It appears when the active
 * workspace tab is a files or report tab; the tab model stays the only source.
 */
export function AuxPanel({ report, closeTab }: {
  report(error: string): void; closeTab(tab: WorkspaceTab): void;
}): React.JSX.Element | null {
  const { snapshot, tabs, activeTabId, auxPanelWidth, settingsOpen } = useUi();
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  if (!activeTab || activeTab.kind === 'terminal' || settingsOpen) return null;
  const hostName = (hostId: string): string => snapshot?.hosts.find((host) => host.id === hostId)?.label ?? hostId;
  const title = activeTab.kind === 'files' ? `${hostName(activeTab.hostId)} · 文件` : 'AI 对话详情';
  const conversation = activeTab.kind === 'report' ? snapshot?.conversations.find((item) => item.id === activeTab.conversationId) : undefined;
  function startResize(event: React.PointerEvent<HTMLDivElement>): void {
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = useUi.getState().auxPanelWidth;
    const element = event.currentTarget;
    const move = (pointer: PointerEvent): void => useUi.getState().setAuxPanelWidth(startWidth + startX - pointer.clientX);
    const stop = (): void => { element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', stop); element.removeEventListener('pointercancel', stop); };
    element.addEventListener('pointermove', move); element.addEventListener('pointerup', stop); element.addEventListener('pointercancel', stop);
  }
  return <aside className={styles.panel} style={{ width: auxPanelWidth }} aria-label={title}>
    <div className={styles.resizer} role="separator" aria-orientation="vertical" aria-label="调整辅助面板宽度" tabIndex={0}
      onPointerDown={startResize}
      onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); useUi.getState().setAuxPanelWidth(useUi.getState().auxPanelWidth + (event.key === 'ArrowLeft' ? 20 : -20)); } }} />
    <header className={styles.head}>
      <span title={title}>{title}</span>
      <button aria-label={`关闭 ${title}`} title="关闭面板" onClick={() => closeTab(activeTab)}><Icon name="close" size={13} /></button>
    </header>
    <div className={styles.body}>
      {activeTab.kind === 'files' ? <FilesPage key={activeTab.id} hostId={activeTab.hostId} host={hostName(activeTab.hostId)} report={report} />
        : conversation ? <ReportPage conversation={conversation} operations={snapshot?.operations.filter((item) => item.taskId === activeTab.conversationId) ?? []} report={report} /> : null}
    </div>
  </aside>;
}
