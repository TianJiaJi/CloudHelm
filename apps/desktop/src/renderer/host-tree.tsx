import { useEffect, useRef, useState } from 'react';
import type { HostView, TaskView } from '@cloudhelm/contracts';
import { useUi } from './store.js';
import { Icon, statusLabel } from './ui-helpers.js';
import { openContextMenu, type ContextMenuEntry } from './context-menu.js';
import { LayoutSwitcher } from './layout-switcher.js';
import { conversationHostKey, hostLineage } from './host-lineage.js';
import { registerHostTreeSearch } from './host-tree-actions.js';
import { SegmentedControl, type SegmentedOption } from './ui/index.js';
import { StatusDot } from './ui/status-dot.js';
import { isMacPlatform } from './shortcuts.js';
import styles from './host-tree.module.css';

const WORKING_STATUSES = new Set(['running', 'waiting-review', 'waiting-user', 'recovering', 'human-control']);
type TreeView = 'all' | 'running' | 'pending';
const viewOptions: SegmentedOption<TreeView>[] = [{ value: 'all', label: '全部' }, { value: 'running', label: '进行中' }, { value: 'pending', label: '待处理' }];

/**
 * Agent-mode sidebar: the layout switcher at the exact SSH coordinates,
 * search, a status filter, and the host/conversation tree.
 */
export function HostTree({ connecting, appVersion, navigate, connectHost, openHostDialog, hostActions, conversationActions }: {
  connecting: string[]; appVersion: string; navigate(action: () => void): void;
  connectHost(hostId: string, alwaysNew?: boolean): Promise<void>; openHostDialog(): void;
  hostActions(host: HostView): ContextMenuEntry[]; conversationActions(conversation: TaskView): ContextMenuEntry[];
}): React.JSX.Element {
  const snapshot = useUi((state) => state.snapshot);
  const selected = useUi((state) => state.selectedConversationId);
  const activeHostId = useUi((state) => state.activeHostId);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<TreeView>('all');
  const [expandedHosts, setExpandedHosts] = useState<string[]>([]);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    registerHostTreeSearch(() => search.current?.focus());
    return () => registerHostTreeSearch(null);
  }, []);
  const hosts = snapshot?.hosts.filter((host) => !host.archived) ?? [];
  const needle = query.trim().toLowerCase();
  const matches = (...texts: string[]): boolean => !needle || texts.some((text) => text.toLowerCase().includes(needle));
  const conversations = [...(snapshot?.conversations ?? [])].sort((a, b) => b.updatedAt - a.updatedAt).filter((conversation) => {
    if (!matches(conversation.goal)) return false;
    if (view === 'running') return WORKING_STATUSES.has(conversation.status);
    if (view === 'pending') return !!(snapshot?.approvals.some((item) => item.taskId === conversation.id)
      || snapshot?.inputs.some((item) => item.taskId === conversation.id));
    return true;
  });
  const grouped = new Map<string, TaskView[]>();
  for (const conversation of conversations) {
    const key = conversationHostKey(conversation, snapshot?.hosts ?? []);
    grouped.set(key, [...(grouped.get(key) ?? []), conversation]);
  }
  const sections = [
    ...hosts.map((host) => ({ key: host.id, host, label: host.label, conversations: grouped.get(host.id) ?? [] })),
    ...[...grouped.keys()].filter((key) => key !== 'chat' && !hosts.some((host) => host.id === key))
      .map((key) => ({ key, host: undefined as HostView | undefined, label: key === 'legacy' ? '旧版多主机记录' : '历史主机', conversations: grouped.get(key) ?? [] })),
    { key: 'chat', host: undefined as HostView | undefined, label: '自由对话', conversations: grouped.get('chat') ?? [] }
  ].filter((section) => view !== 'all'
    ? section.conversations.length > 0
    : section.host
      ? matches(section.host.label, section.host.address, section.host.username) || section.conversations.length > 0
      : section.conversations.length > 0);
  return <aside className={styles.sidebar} aria-label="主机与对话树">
    <LayoutSwitcher />
    <input ref={search} className={styles.search} placeholder={`搜索主机与对话 ${isMacPlatform() ? '⌘K' : 'Ctrl+K'}`}
      aria-label="搜索主机与对话" value={query} onChange={(event) => setQuery(event.target.value)} />
    <div className={styles.filter}>
      <SegmentedControl ariaLabel="过滤视图" size="compact" value={view} onValueChange={(next) => setView(next)} options={viewOptions} />
    </div>
    <div className={styles.treeHead}><span>主机</span><button title="添加主机" aria-label="添加主机" onClick={openHostDialog}><Icon name="plus" size={13} /></button></div>
    <div className={styles.tree}>
      {sections.map((section) => {
        const lineage = section.host ? hostLineage(section.host, snapshot?.hosts ?? []) : [];
        const working = snapshot?.conversations.find((item) => item.hostIds.some((id) => lineage.includes(id)) && WORKING_STATUSES.has(item.status));
        const open = section.host ? expandedHosts.includes(section.key) : true;
        return <div key={section.key} className={styles.node}>
          {section.host
            ? <div className={`${styles.row} ${activeHostId && lineage.includes(activeHostId) ? styles.selected : ''}`}
              onContextMenu={(event) => openContextMenu(event, hostActions(section.host!), `${section.host!.label} 主机操作`)}>
              <button className={styles.caret} data-open={open} aria-label={open ? `折叠 ${section.host!.label}` : `展开 ${section.host!.label}`}
                aria-expanded={open} onClick={() => setExpandedHosts((ids) => ids.includes(section.key) ? ids.filter((id) => id !== section.key) : [...ids, section.key])}><Icon name="chevron" size={11} /></button>
              <button className={styles.rowSelect} onClick={() => navigate(() => void connectHost(section.host!.id))}
                title={`${section.host!.username}@${section.host!.address}:${section.host!.port}`} disabled={connecting.includes(section.host!.id)}>
                <Icon name="server" /><span>{section.host!.label}<small>{connecting.includes(section.host!.id) ? '正在连接…' : working ? statusLabel[working.status] : `${section.host!.username}@${section.host!.address}`}</small></span>
                <StatusDot active={section.host!.status === 'connected'} />
              </button>
            </div>
            : <div className={styles.sectionLabel}>{section.label}</div>}
          {open && section.conversations.map((item) => <button key={item.id} className={`${styles.leaf} ${selected === item.id ? styles.selected : ''}`}
            onContextMenu={(event) => openContextMenu(event, conversationActions(item), `${item.goal} 对话操作`)}
            onClick={() => navigate(() => useUi.getState().selectConversation(item.id))}>
            <StatusDot active={WORKING_STATUSES.has(item.status)} />
            <span>{item.goal}<small>{statusLabel[item.status]}</small></span>
          </button>)}
        </div>;
      })}
      {!hosts.length && <button className={styles.addHostEmpty} onClick={openHostDialog}><Icon name="plus" />添加第一台主机</button>}
      {!sections.length && hosts.length > 0 && <p className={styles.empty}>没有匹配的主机或对话。</p>}
    </div>
    <div className={styles.foot}>
      <button onClick={() => navigate(() => useUi.getState().newConversation(useUi.getState().activeHostId))}><Icon name="plus" size={13} />新任务</button>
      <button onClick={() => navigate(() => useUi.getState().setSettingsOpen(true))}><Icon name="settings" size={13} />设置</button>
      <small>{appVersion ? `CloudHelm · ${appVersion}` : 'CloudHelm'}</small>
    </div>
  </aside>;
}
