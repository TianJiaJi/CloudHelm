import { useEffect, useRef, useState } from 'react';
import type { ErrorPresentation } from './error-presentation.js';
import { inlineError } from './error-presentation.js';
import { errorControlAction } from './error-control-action.js';
import { useUi } from './store.js';
import { Icon } from './ui-helpers.js';
import styles from './error-dialog.module.css';

export function ErrorDialog({ notice, close, configureModel }: {
  notice: ErrorPresentation; close(): void; configureModel(): void;
}): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const [copyStatus, setCopyStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const submitting = useRef(false);
  const { snapshot, terminals } = useUi();
  const control = errorControlAction(notice, snapshot?.conversations ?? [], Object.values(terminals));
  useEffect(() => { dialog.current?.showModal(); }, []);
  async function stopExecution(): Promise<void> {
    if (!control || submitting.current) return;
    submitting.current = true; setBusy(true); setActionError('');
    try {
      const latest = await window.cloudhelm.snapshot();
      useUi.getState().setSnapshot(latest);
      const current = errorControlAction(notice, latest.conversations, latest.terminals);
      if (!current || current.method !== control.method || current.id !== control.id) {
        setActionError('执行状态已变化，请确认最新状态后再操作。');
        return;
      }
      await window.cloudhelm[current.method](current.id);
      close();
    } catch (error) { setActionError(inlineError(error)); }
    finally { submitting.current = false; setBusy(false); }
  }
  async function copyDetails(): Promise<void> {
    try { await navigator.clipboard.writeText(notice.details); setCopyStatus('已复制脱敏详情'); }
    catch { setCopyStatus('暂时无法复制，请手动选择详情文本。'); }
  }
  return <dialog ref={dialog} className={styles.dialog} role="alertdialog" aria-labelledby="error-title" aria-describedby="error-description"
    onCancel={(event) => { event.preventDefault(); if (!submitting.current) close(); }}>
    <div className={styles.heading}><span className={styles.symbol} aria-hidden="true">{notice.severity === 'warning' ? '!' : '×'}</span>
      <button type="button" aria-label="关闭错误提示" className={styles.close} disabled={busy} onClick={close}><Icon name="close" /></button></div>
    <h2 id="error-title">{notice.title}</h2><p id="error-description">{control?.description ?? notice.description}</p>
    {control && <p className={styles.target}>关联对话：{control.target}</p>}
    <details className={styles.details}><summary>查看技术详情</summary><pre>{notice.details}</pre>
      <button type="button" onClick={() => void copyDetails()}>复制脱敏详情</button><span role="status">{copyStatus}</span></details>
    {actionError && <p role="alert" className={styles.actionError}>{actionError}</p>}
    <div className={styles.actions}><button type="button" autoFocus={!notice.action && !control} disabled={busy} onClick={close}>{notice.action || control ? '稍后' : '知道了'}</button>
      {control && <button type="button" className={styles.primary} disabled={busy} autoFocus onClick={() => void stopExecution()}>{busy ? '正在停止…' : control.label}</button>}
      {notice.action === 'model-settings' && <button type="button" className={styles.primary} autoFocus onClick={() => { close(); configureModel(); }}>去配置模型</button>}</div>
  </dialog>;
}
