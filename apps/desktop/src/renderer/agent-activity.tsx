import { useState } from 'react';
import type { AppSnapshot, TaskView, ToolObservation } from '@cloudhelm/contracts';
import { requestCost, jobNeedsAttention } from './execution-workspace-view.js';
import { capture } from './ui-helpers.js';
import styles from './execution-workspace.module.css';

const toolStatus = { running: '执行中', complete: '已返回', failed: '失败', interrupted: '已中断，结果未确认' };
export function AgentActivity({ snapshot, conversation, report }: { snapshot: AppSnapshot; conversation: TaskView; report(error: string): void }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false), [pausing, setPausing] = useState(false);
  const view = snapshot.agentActivity?.[conversation.id], execution = snapshot.execution?.[conversation.id];
  const requests = view?.requests ?? [], tools = view?.tools ?? [];
  const generating = requests.filter((value) => value.status === 'running' && value.purpose === 'conversation');
  const summaries = requests.filter((value) => value.status === 'running' && value.purpose !== 'conversation');
  const active = tools.filter((value) => value.status !== 'complete'), completed = tools.filter((value) => value.status === 'complete').slice(-12);
  const jobs = snapshot.operations.filter((operation) => operation.taskId === conversation.id && jobNeedsAttention(operation));
  const inputs = snapshot.inputs.filter((input) => input.taskId === conversation.id);
  const approvals = snapshot.approvals.filter((approval) => approval.taskId === conversation.id);
  const last = [...requests].reverse().find((value) => value.status !== 'running');
  const row = (tool: ToolObservation) => <div key={tool.callId} className={`${styles.row} ${tool.parentCallId ? styles.child : ''}`}>
    <strong>{tool.name} · {toolStatus[tool.status]}</strong><small> {tool.parentCallId ? '子查询' : '模型工具'}{tool.durationMs !== undefined ? ` · ${tool.durationMs} ms` : ''}{tool.updates ? ` · ${tool.updates} 次进度更新` : ''}</small>
  </div>;
  return <section className={styles.panel} aria-label="独立执行状态">
    <div className={styles.heading}><strong>执行工作区</strong>{execution?.model === 'running' && <button type="button" disabled={pausing} onClick={async () => {
      if (pausing) return; setPausing(true);
      try { await capture(() => window.cloudhelm.pauseConversation(conversation.id), report); } finally { setPausing(false); }
    }}>{pausing ? '暂停中…' : '暂停模型（后台继续）'}</button>}</div>
    <div className={styles.states} role="status">
      <span className={styles.state}>模型：{generating.length ? '请求进行中' : execution?.model === 'running' ? '循环处理中' : execution?.model === 'idle' ? '空闲' : '状态未知'}</span>
      <span className={styles.state}>工具：{view ? `${tools.filter((tool) => tool.status === 'running').length} 个执行中` : '暂无观察'}</span>
      <span className={styles.state}>等待批准：{approvals.length}</span><span className={styles.state}>等待输入：{inputs.length}</span>
      <span className={styles.state}>后台待关注：{jobs.length}</span>{summaries.length > 0 && <span className={styles.state}>辅助模型请求：{summaries.length}</span>}
    </div>
    {view?.run?.status === 'settled' && <p className={styles.note}>已观察到模型轮次结束 · {view.run.aborted === true ? '已中断' : view.run.aborted === false ? '自然结束' : '中断标记未知'} · {view.run.durationMs !== undefined ? `${view.run.durationMs} ms` : '耗时未知'}；不代表远端退出。</p>}
    {view?.runtimeLost && <p role="alert">模型运行通道已中断；未完成工具／请求结果未知。后台进程状态以操作记录为准。</p>}
    {active.map(row)}
    {!!completed.length && <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}><summary>已完成工具 · 最近 {completed.length} 条</summary>{expanded && completed.map(row)}</details>}
    {last && <p className={styles.note}>最近已观测请求：{last.provider} / {last.modelId} · {last.purpose === 'conversation' ? '对话' : '辅助请求'} · {requestCost(last)}{last.tokens ? ` · 报告 token：输入 ${last.tokens.input}、输出 ${last.tokens.output}、缓存读 ${last.tokens.cacheRead}／写 ${last.tokens.cacheWrite}` : ' · token 用量未知'}</p>}
    {!!(view?.omittedTools || view?.omittedRequests) && <p className={styles.note}>早期活动已限量省略（工具 {view?.omittedTools}、请求 {view?.omittedRequests}），不是完整历史或费用总账。</p>}
    <p className={styles.note}>模型停止、工具返回或信号送达，都不证明远端进程退出或服务健康。</p>
  </section>;
}
