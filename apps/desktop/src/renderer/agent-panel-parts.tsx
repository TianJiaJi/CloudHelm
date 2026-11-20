import { jobNeedsAttention } from './execution-workspace-view.js';
import { operationNeedsVerification, type AppSnapshot, type OperationView, type PlanStep, type TaskView } from '@cloudhelm/contracts';
import { useId, useState } from 'react';
import { MenuItem, MenuSurface, Pill } from './ui/index.js';
import { useMenuAnchor } from './composer-controls.js';
import { useUi } from './store.js';
import { Icon, statusLabel } from './ui-helpers.js';
import { OperationCard } from './workspace-pages.js';
import styles from './agent-panel.module.css';

export function AssistantIdentity(): React.JSX.Element {
  return <div className={styles.identity}><span className={styles.identityIcon}><Icon name="terminal" size={12} /></span><strong>CloudHelm</strong><span className={styles.identityHint}>AI 助手</span></div>;
}

export function AgentPanelHeader({ snapshot, conversation, hostId }: {
  snapshot: AppSnapshot; conversation?: TaskView; hostId?: string;
}): React.JSX.Element {
  const history = useMenuAnchor();
  const recent = [...snapshot.conversations].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
  return <header className={styles.agentHead}>
    <div className={styles.panelTitle}><Icon name="chat" size={15} /><span title={conversation?.goal}>{conversation?.goal || '新对话'}</span></div>
    <div className={styles.headerActions}>
      <button type="button" title="新对话" aria-label="新对话" onClick={() => useUi.getState().newConversation(hostId ?? null)}><Icon name="plus" /></button>
      <button type="button" title="历史对话" aria-label="历史对话" aria-haspopup="menu" aria-expanded={!!history.anchor} {...history.trigger}><Icon name="history" /></button>
      {conversation && <button type="button" title="展开对话详情" aria-label="展开对话详情" onClick={() => useUi.getState().openReport(conversation.id)}><Icon name="expand" size={14} /></button>}
      <button type="button" title="模型设置" aria-label="助手模型设置" onClick={() => useUi.getState().setSettingsOpen(true)}><Icon name="settings" size={14} /></button>
      <button type="button" title="收起助手" aria-label="收起助手" onClick={useUi.getState().toggleAgentPanel}><Icon name="close" size={14} /></button>
    </div>
    {history.anchor && <MenuSurface anchor={history.anchor} label="历史对话" close={history.close} className={styles.historyMenu}>
      <div className={styles.menuLabel}>最近对话</div>
      {recent.map((item) => <MenuItem key={item.id} label={item.goal} icon="chat" onSelect={() => { history.close(); useUi.getState().selectConversation(item.id); }} />)}
      {!recent.length && <p className={styles.menuEmpty}>还没有历史对话</p>}
    </MenuSurface>}
  </header>;
}

/** Only successful, ordinary operations may be visually condensed. Failures,
 * authentication feedback and uncertain outcomes keep their full existing UI. */
export function canCondenseOperation(operation: OperationView): boolean {
  return operation.status === 'succeeded' && !operation.privilege && !operation.reconciliation && !jobNeedsAttention(operation);
}

export function OperationActivity({ operation, report }: { operation: OperationView; report(error: string): void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  if (!canCondenseOperation(operation)) return <OperationCard operation={operation} report={report} />;
  const duration = operation.completedAt !== undefined ? formatElapsed(operation.createdAt, operation.completedAt) : '';
  return <div className={styles.toolActivity}>
    <button type="button" className={styles.evHead} aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(!open)}>
      <Icon name="check" size={13} /><span>{operation.kind === 'command' ? '已完成远端命令' : '已完成文件操作'}</span>
      <code title={operation.preview}>{operation.preview}</code>
      <Pill className={styles.evPill}>{operation.exitCode !== undefined ? `退出 ${operation.exitCode}` : '已完成'}</Pill>
      {duration && <small className={styles.evDuration} title="该操作从开始到退出的耗时">{duration}</small>}
      <Icon name="chevron" size={11} />
    </button>
    {open && <div id={detailsId} className={styles.toolDetails}><OperationCard operation={operation} report={report} /></div>}
  </div>;
}

/** Wall time of a finished operation; backend timestamps only, never a live clock. */
function formatElapsed(from: number, to: number): string {
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 时 ${minutes % 60} 分`;
}

/** Plan contents and completion counts are projections of backend PlanStep values. */
export function AgentPlan({ steps, operations = [] }: { steps: PlanStep[]; operations?: OperationView[] }): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  if (!steps.length) return null;
  const done = steps.filter((step) => step.status === 'done').length;
  const active = steps.find((step) => step.status === 'running');
  const blocked = steps.some((step) => step.status === 'blocked');
  const executing = operations.some((operation) => ['proposed', 'approved', 'running'].includes(operation.status));
  const uncertain = operations.some((operation) => operationNeedsVerification(operation));
  const label = executing ? '操作尚未结束' : uncertain ? '执行结果待核对' : blocked ? '计划受阻'
    : active ? '正在进行' : done === steps.length ? '步骤已处理' : '执行计划';
  return <section className={styles.planDock} aria-label="执行计划">
    <button type="button" className={styles.planToggle} aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded(!expanded)}>
      <Icon name="plan" size={14} /><span className={styles.planLabel}>{label}</span><small>{done}/{steps.length}</small>
      <span className={styles.planPreview} title={active?.title ?? steps.find((step) => step.status !== 'done')?.title ?? steps.at(-1)?.title}>{active?.title ?? steps.find((step) => step.status !== 'done')?.title ?? steps.at(-1)?.title}</span>
      <span className={styles.planChevron} data-open={expanded}><Icon name="chevron" size={12} /></span>
    </button>
    <ol id={listId} className={styles.planList} hidden={!expanded}>{steps.map((step, index) => <li key={step.id} data-state={step.status}>
      <span className={styles.stepMark} aria-label={step.status === 'done' ? '步骤已处理' : step.status === 'running' ? '进行中' : step.status === 'blocked' ? '受阻' : '待执行'}>{step.status === 'blocked' ? '!' : index + 1}</span><span className={styles.stepTitle}>{step.title}</span>
    </li>)}</ol>
  </section>;
}

export function ActivityLabel({ task }: { task: TaskView }): React.JSX.Element {
  return <span className={styles.taskStatus} data-state={task.status}>{statusLabel[task.status]}</span>;
}
