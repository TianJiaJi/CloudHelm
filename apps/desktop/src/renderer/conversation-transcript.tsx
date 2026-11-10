import { useEffect, useState } from 'react';
import type { AppSnapshot, TaskView } from '@cloudhelm/contracts';
import { conversationTimeline, type TimelineEntry } from './conversation-timeline.js';
import { conversationTurns, type ConversationTurn } from './conversation-turns.js';
import { AgentPlan, AssistantIdentity, OperationActivity } from './agent-panel-parts.js';
import { ClarificationCard } from './clarification-card.js';
import { ReasoningContent } from './reasoning-content.js';
import { MarkdownMessage } from './markdown-message.js';
import { UserMessage } from './user-message.js';
import { copyEntries } from './clipboard.js';
import { openContextMenu } from './context-menu.js';
import { Icon } from './ui-helpers.js';
import { useUi } from './store.js';
import styles from './agent-panel.module.css';

function Entry({ entry, conversation, report, omitReasoning = false }: {
  entry: TimelineEntry; conversation: TaskView; report(error: string): void; omitReasoning?: boolean;
}): React.JSX.Element | null {
  if (entry.kind === 'clarification') return <ClarificationCard request={entry.value} />;
  if (entry.kind === 'operation') return <OperationActivity operation={entry.value} report={report} />;
  const message = entry.value;
  if (message.role === 'user') return <UserMessage message={message} canEdit={!!conversation.session && conversation.hostIds.length <= 1} report={report} />;
  if (message.role === 'agent' && !message.text.trim() && !message.reasoning?.text.trim()) return null;
  return <article className={styles.message}
    onContextMenu={(event) => openContextMenu(event, copyEntries('复制文本', message.text, report), '消息操作')}>
    {message.role === 'agent' ? <AssistantIdentity /> : <strong>系统</strong>}
    {message.role === 'agent' ? <>{!omitReasoning && <ReasoningContent value={message.reasoning} />}
      {message.text && <MarkdownMessage text={message.text} />}</> : <p>{message.text}</p>}
    {message.model && <small>{message.model.provider} · {message.model.modelId}</small>}
  </article>;
}

function Turn({ turn, conversation, report, showInactivePlan }: {
  turn: ConversationTurn; conversation: TaskView; report(error: string): void; showInactivePlan: boolean;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { if (turn.foldable) setExpanded(false); }, [turn.foldable]);
  const plan = turn.latest && showInactivePlan && !!conversation.plan?.length
    ? <AgentPlan steps={conversation.plan} operations={turn.entries.filter((entry) => entry.kind === 'operation').map((entry) => entry.value)} /> : null;
  const process = turn.entries.filter((entry) => entry.key !== turn.answer?.key);
  const reasoning = turn.answer?.value.reasoning;
  const hasProcess = process.some((entry) => entry.kind !== 'message' || entry.value.text.trim() || entry.value.reasoning?.text.trim())
    || !!reasoning?.text.trim() || !!plan;
  return <section className={styles.turn} data-turn={turn.key}>
    {turn.input && <Entry entry={turn.input} conversation={conversation} report={report} />}
    {turn.foldable && turn.answer ? <>
      {hasProcess && <details className={styles.turnProcess} open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary><Icon name="chevron" size={12} /><span>{turn.operationCount ? '执行过程' : '思考与过程'}</span>
          {turn.operationCount > 0 && <small>· {turn.operationCount} 次操作</small>}
          {turn.messageCount > 0 && <small>· {turn.messageCount} 条过程消息</small>}
          {turn.riskCount > 0 && <small>· 含风险接管记录</small>}
        </summary>
        {expanded && <div className={styles.turnProcessBody}>
          {plan}
          {process.map((entry) => <Entry key={entry.key} entry={entry} conversation={conversation} report={report} />)}
          {!!reasoning?.text.trim() && <ReasoningContent value={reasoning} />}
          <button type="button" onClick={() => useUi.getState().openReport(conversation.id)}>查看全部操作与证据</button>
        </div>}
      </details>}
      <Entry entry={turn.answer} conversation={conversation} report={report} omitReasoning />
    </> : <>
      {plan}
      {turn.entries.map((entry) => <Entry key={entry.key} entry={entry} conversation={conversation} report={report} />)}
    </>}
  </section>;
}

export function ConversationTranscript({ snapshot, conversation, report }: {
  snapshot: AppSnapshot; conversation: TaskView; report(error: string): void;
}): React.JSX.Element {
  const entries = conversationTimeline(snapshot.messages.filter((message) => message.taskId === conversation.id),
    snapshot.operations.filter((operation) => operation.taskId === conversation.id),
    (snapshot.clarifications ?? []).filter((request) => request.taskId === conversation.id));
  const execution = snapshot.execution?.[conversation.id];
  const turns = conversationTurns(entries, { status: conversation.status, execution,
    pendingInteraction: [...snapshot.approvals, ...snapshot.inputs].some((request) => request.taskId === conversation.id),
    liveReasoning: !!snapshot.reasoningProgress?.[conversation.id] });
  const showInactivePlan = !(execution?.canStop ?? ['running', 'waiting-review', 'waiting-user', 'recovering'].includes(conversation.status));
  return <>{turns.map((turn) => <Turn key={`${conversation.id}:${turn.key}`} turn={turn} conversation={conversation}
    report={report} showInactivePlan={showInactivePlan} />)}</>;
}
