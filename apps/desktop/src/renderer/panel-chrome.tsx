import type { ReactNode } from 'react';
import type { AppSnapshot, HostView, TaskView } from '@cloudhelm/contracts';
import { AgentPanelHeader } from './agent-panel-parts.js';
import { Icon, reviewLabel } from './ui-helpers.js';
import { StatusDot } from './ui/index.js';
import panelStyles from './agent-panel.module.css';

/** Assistant panel frame: header, host context line, then the stream body. */
export function PanelChrome({ snapshot, host, conversation, children }: {
  snapshot: AppSnapshot; host?: HostView; conversation?: TaskView; children: ReactNode;
}): React.JSX.Element {
  return <section className={panelStyles.panel} aria-label="AI 助手面板">
    <AgentPanelHeader snapshot={snapshot} conversation={conversation} hostId={host?.id} />
    <div className={panelStyles.assistantContext}><span><StatusDot active={host?.status === 'connected'} />{host ? `${host.label} · ${host.username}` : '自由对话'}</span>
      <small>{host ? <><Icon name="shield" size={12} />{reviewLabel[conversation?.reviewModesByHost?.[host.id] ?? host.defaultMode]}</> : '未授权远端操作'}</small></div>
    {children}
  </section>;
}
