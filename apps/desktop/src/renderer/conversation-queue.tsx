import { useRef, useState } from 'react';
import type { ConversationInputView } from '@cloudhelm/contracts';
import styles from './execution-workspace.module.css';

const status = { queued: '待投递', delivering: '已选择，正在确认', delivered: '已投递到会话', cancelled: '已取消', expired: '已过期', failed: '投递失败' };
export function ConversationQueue({ inputs, report }: { inputs: ConversationInputView[]; report(error: string): void }): React.JSX.Element | null {
  const [busy, setBusy] = useState<string[]>([]), [expanded, setExpanded] = useState(false);
  const submitting = useRef(new Set<string>());
  if (!inputs.length) return null;
  const active = inputs.filter((input) => ['queued', 'delivering', 'failed', 'expired'].includes(input.status));
  const ended = inputs.filter((input) => !active.includes(input)).slice(-16);
  async function cancel(input: ConversationInputView): Promise<void> {
    if (submitting.current.has(input.id) || input.status !== 'queued') return;
    submitting.current.add(input.id); setBusy([...submitting.current]);
    try {
      if (!window.cloudhelm.cancelQueuedInput) throw new Error('当前版本不支持取消排队消息');
      const result = await window.cloudhelm.cancelQueuedInput(input.taskId, input.id);
      if (!result.cancelled) report('消息已被选择或状态已变化；不能保证撤回，请以后台回执为准。');
    } catch (cause) { report(cause instanceof Error ? cause.message : String(cause)); }
    finally { submitting.current.delete(input.id); setBusy([...submitting.current]); }
  }
  const row = (input: ConversationInputView) => <div className={styles.row} key={input.id} data-input-status={input.status}>
    <strong>{input.kind === 'steer' ? '当前调整' : '后续排队'} · {status[input.status]}</strong>
    <p>{input.preview}</p>
    {input.reason === 'recovered' && <small>恢复后已过期，不会自动投递。</small>}
    {input.status === 'delivered' && <small>投递回执不代表模型已经处理完成。</small>}
    {input.status === 'queued' && <div className={styles.actions}><button type="button" disabled={busy.includes(input.id)} onClick={() => void cancel(input)}>{busy.includes(input.id) ? '取消确认中…' : '取消此消息'}</button></div>}
  </div>;
  return <section className={styles.panel} aria-label="消息队列">
    <strong>消息队列</strong><p className={styles.note}>入队不改变当前意图；实际投递由后端确认。发送排队消息不会停止执行；暂停／停止后未投递消息以取消回执为准。</p>
    {active.slice(-64).map(row)}
    {active.length > 64 && <p>另有 {active.length - 64} 条早期回执未显示。</p>}
    {!!ended.length && <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}><summary>已投递／取消回执 · 最近 {ended.length} 条</summary>{expanded && ended.map(row)}</details>}
  </section>;
}
