import { useEffect, useRef, useState } from 'react';
import type { ClarificationAnswer, ClarificationRequest } from '@cloudhelm/contracts';
import styles from './clarification-card.module.css';

const drafts = new Map<string, Record<string, ClarificationAnswer>>();
export function ClarificationCard({ request }: { request: ClarificationRequest }): React.JSX.Element {
  const [answers, setAnswers] = useState<Record<string, ClarificationAnswer>>(() => drafts.get(request.id) ?? {});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const pending = request.status === 'pending';
  useEffect(() => {
    if (pending) drafts.set(request.id, answers); else drafts.delete(request.id);
  }, [request.id, pending, answers]);
  function answer(id: string, value: string, custom = false): void { setAnswers((previous) => ({ ...previous, [id]: { id, value, custom } })); }
  async function submit(cancel = false): Promise<void> {
    if (submitting.current || !pending) return;
    submitting.current = true; setBusy(true); setError('');
    try {
      if (cancel) await window.cloudhelm.cancelClarification(request.taskId, request.id);
      else await window.cloudhelm.answerClarification(request.taskId, request.id, request.questions.map((q) => answers[q.id]!));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { submitting.current = false; setBusy(false); }
  }
  const complete = request.questions.every((q) => answers[q.id]?.value.trim());
  return <section className={styles.card} aria-label="需求澄清">
    <header><strong>需要你补充的信息</strong><span>{ { pending: '等待回答', answered: '已回答', cancelled: '已停止', expired: '已失效' }[request.status] }</span></header>
    {pending && <p className={styles.hint}>回答后 AI 会继续。请勿填写密码、验证码或密钥。</p>}
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {request.questions.map((question) => {
        const selected = answers[question.id];
        const saved = request.answers?.find((answer) => answer.id === question.id);
        return <fieldset key={question.id} disabled={!pending || busy}>
          <legend>{question.prompt}</legend>
          {pending ? <>
            {question.options?.map((option) => <label className={styles.option} key={option.value}>
              <input type="radio" name={`${request.id}:${question.id}`} checked={!selected?.custom && selected?.value === option.value} onChange={() => answer(question.id, option.value)} />
              <span>{option.label}{option.recommended && <em>推荐</em>}{option.description && <small>{option.description}</small>}</span>
            </label>)}
            {!!question.options?.length && <label className={styles.other}><input type="radio" name={`${request.id}:${question.id}`} checked={!!selected?.custom} onChange={() => answer(question.id, '', true)} />自定义回答</label>}
            {(!question.options?.length || selected?.custom) && <textarea aria-label={`${question.prompt}：自定义回答`} value={selected?.value ?? ''} maxLength={4000} rows={2} onChange={(event) => answer(question.id, event.target.value, true)} />}
          </> : <p>{saved ? (saved.custom ? saved.value : question.options?.find((option) => option.value === saved.value)?.label ?? saved.value) : '未提交回答，AI 未继续执行。'}</p>}
        </fieldset>;
      })}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {pending && <footer><button type="button" disabled={busy} onClick={() => void submit(true)}>停止本轮</button><button type="submit" disabled={busy || !complete}>{busy ? '提交中…' : '提交并继续'}</button></footer>}
      {request.status === 'expired' && <p className={styles.hint}>运行已结束或应用已重启，请发送新消息继续。</p>}
    </form>
  </section>;
}
