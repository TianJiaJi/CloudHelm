import { useEffect, useState } from 'react';
import type { ApprovalView, InputRequestView } from '@cloudhelm/contracts';
import { capture, Icon } from './ui-helpers.js';
import { Button, Card } from './ui/index.js';
import styles from './ui.module.css';

function useExpired(expiresAt: number): boolean {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  return expiresAt <= now;
}

const MAX_APPROVAL_RENEWALS = 5;

export function ApprovalCard({ approval, host, report }: { approval: ApprovalView; host: string; report(error: string): void }): React.JSX.Element {
  const softExpired = useExpired(approval.expiresAt);
  const decidable = !useExpired(approval.hardExpiresAt ?? approval.expiresAt);
  const renewalsLeft = Math.max(0, MAX_APPROVAL_RENEWALS - (approval.renewals ?? 0));
  const [busy, setBusy] = useState(false);
  function decide(approved: boolean): void {
    setBusy(true);
    void capture(() => window.cloudhelm.decideApproval(approval.id, approved), report).finally(() => setBusy(false));
  }
  function renew(): void {
    setBusy(true);
    void capture(() => window.cloudhelm.renewApproval(approval.id), report).finally(() => setBusy(false));
  }
  return <Card as="section" tone="accent" className={styles.reviewCard} aria-label="命令审批">
    <div className={styles.cardTitle}><Icon name="shield" /><strong>{approval.title}</strong></div>
    <small>{host} · {!softExpired ? '等待你的决定' : decidable ? '已超时，请尽快决定或续期' : '请求已过期'}</small><p>{approval.explanation}</p>
    <small>执行账号：{approval.account ?? '未知'} · 工作目录：{approval.cwd ?? '未知'} · 影响：{approval.impact === 'high' ? '高' : approval.impact === 'unknown' ? '尚不明确' : '一般'}</small>
    <small>操作目标：{approval.targets?.length ? approval.targets.join('、') : '未识别到具体文件或资源路径'}</small>
    <div className={styles.reviewCommand}><small>待批准的完整操作</small><pre>{approval.preview}</pre></div>
    {approval.recovery && <p>{approval.recovery}</p>}
    {approval.hardExpiresAt !== undefined && <small>剩余续期 {renewalsLeft}/{MAX_APPROVAL_RENEWALS} 次、最晚 {new Date(approval.hardExpiresAt).toTimeString().slice(0, 5)} 截止</small>}
    <div className={styles.cardActions}><Button size="compact" disabled={!decidable || busy} onClick={() => decide(false)}>拒绝</Button><Button variant="primary" size="compact" disabled={!decidable || busy} onClick={() => decide(true)}>批准这次操作</Button>{approval.hardExpiresAt !== undefined && <Button size="compact" disabled={!decidable || busy || renewalsLeft === 0} onClick={() => renew()}>续期</Button>}</div>
  </Card>;
}

export function InputCard({ input, host, report, later }: { input: InputRequestView; host: string; report(error: string): void; later?: () => void }): React.JSX.Element {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const expired = useExpired(input.expiresAt);
  const sensitive = input.kind === 'secret' || input.kind === 'otp';
  function submit(value: string): void {
    if (expired || busy) return;
    setBusy(true); setAnswer('');
    void capture(() => window.cloudhelm.answerInput(input.id, value), report).finally(() => setBusy(false));
  }
  const body = <>
    <div className={styles.cardTitle}><Icon name={sensitive ? 'shield' : 'chat'} /><strong>{input.title}</strong></div>
    <p>{input.explanation}</p><small>目标主机：{host} · {expired ? '请求已过期' : '仅用于当前操作'}</small>
    {sensitive && <p className={styles.notice}>密码或验证码直接提交给当前认证操作，AI 不会看到，也不会保存到对话或终端日志。</p>}
    {input.choices?.length ? <div className={styles.cardActions}>{input.choices.map((choice) => <Button key={choice} size="compact" disabled={expired || busy} onClick={() => submit(choice)}>{choice}</Button>)}</div>
      : <label>{sensitive ? (input.kind === 'otp' ? '验证码' : '密码') : '你的回答'}<input autoFocus={sensitive} type={sensitive ? 'password' : 'text'}
        data-sensitive-input={sensitive ? 'true' : undefined}
        autoComplete="off" value={answer} disabled={expired || busy} onChange={(event) => setAnswer(event.target.value)} /></label>}
    <div className={styles.cardActions}>
      <Button size="compact" disabled={busy} onClick={() => { setAnswer(''); void capture(() => window.cloudhelm.cancelInput(input.id), report); }}>取消输入</Button>
      {later && <Button size="compact" onClick={() => { setAnswer(''); later(); }}>稍后填写</Button>}
      {!input.choices?.length && <Button variant="primary" size="compact" type="submit" disabled={!answer || expired || busy}>{busy ? '提交中…' : '安全提交'}</Button>}
    </div>
    <small>取消输入或关闭窗口不会自动停止远端进程。需要时可单独选择“停止命令”。</small>
  </>;
  if (later) return <form className={styles.dialog} role="dialog" aria-modal={true}
    aria-label={input.title} onSubmit={(event) => { event.preventDefault(); submit(answer); }}>{body}</form>;
  return <Card as="form" tone="accent" className={styles.reviewCard}
    aria-label={input.title} onSubmit={(event) => { event.preventDefault(); submit(answer); }}>{body}</Card>;
}
