import { useRef, useState } from 'react';
import type { TerminalViewState } from '@cloudhelm/contracts';
import { capture } from './ui-helpers.js';
import { useUi } from './store.js';

export function TerminalControl({ terminal, report }: { terminal: TerminalViewState; report(error: string): void }): React.JSX.Element | null {
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const snapshot = useUi((state) => state.snapshot);
  const task = snapshot?.conversations.find((task) => task.id === terminal.taskId);
  const active = task && ['running', 'waiting-review', 'waiting-user', 'recovering'].includes(task.status);
  const pending = snapshot?.operations.some((op) => op.logRef === terminal.id && ['running', 'unknown'].includes(op.status) && !op.interruption);
  if (!terminal.taskId || terminal.state === 'closed' || (!active && !pending)) return null;
  async function stop(): Promise<void> {
    if (submitting.current || !terminal.taskId) return;
    submitting.current = true; setBusy(true);
    try { await capture(() => window.cloudhelm.stopOperation(terminal.taskId!), report); }
    finally { submitting.current = false; setBusy(false); }
  }
  return <button type="button" disabled={busy} title="停止本会话 AI，并请求停止本会话全部执行中的命令（含后台）；不会发起新对话，信号确认不代表进程退出"
    onClick={() => void stop()}>{busy ? '正在停止…' : '停止'}</button>;
}
