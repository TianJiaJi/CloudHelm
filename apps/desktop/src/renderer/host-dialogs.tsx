import { useState } from 'react';
import type { HostView, ReviewMode } from '@cloudhelm/contracts';
import { capture, Icon } from './ui-helpers.js';
import { Button } from './ui/index.js';
export { HostDialog } from './host-editor.js';
import styles from './ui.module.css';

type DialogProps = { close(): void; report(value: string): void };
export function SafetyDialog({ host, close, report }: DialogProps & { host: HostView }): React.JSX.Element {
  const [mode, setMode] = useState<ReviewMode>(host.defaultMode);
  const [readPaths, setReadPaths] = useState((host.protectedReadPaths ?? host.protectedPaths).join('\n'));
  const [writePaths, setWritePaths] = useState((host.protectedWritePaths ?? host.protectedPaths).join('\n'));
  return <div className={styles.scrim}><form className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="safety-title"
    onSubmit={(event) => { event.preventDefault(); void capture(async () => {
      await window.cloudhelm.updateHostSafety(host.id, mode,
        readPaths.split('\n').map((value) => value.trim()).filter(Boolean),
        writePaths.split('\n').map((value) => value.trim()).filter(Boolean)); close();
    }, report); }}>
    <div className={styles.dialogHead}><h2 id="safety-title">{host.label} · 安全设置</h2><button type="button" aria-label="关闭" onClick={close}><Icon name="close" /></button></div>
    <p>这里设置新对话的默认档位；当前对话可在输入框旁单独切换。</p>
    <label>新对话默认档位<select value={mode} onChange={(event) => setMode(event.target.value as ReviewMode)}>
      <option value="ask">第一档 · 重要操作询问</option><option value="ai-review">第二档 · AI 审核不确定操作</option><option value="permissive">第三档 · 默认自动执行</option>
    </select></label>
    <p className={styles.notice}>{mode === 'ai-review' ? '不确定操作由设置中显式选择的模型独立审核；高影响操作仍需你确认。' : mode === 'permissive' ? 'SSH 黑名单和路径扫描只能尽力识别，无法保证拦截脚本内部的危险操作。' : '普通写入自动执行，只询问高影响或无法确认影响的操作。'}</p>
    <label>禁止 AI 读取的路径（每行一个绝对路径）<textarea rows={4} value={readPaths} onChange={(event) => setReadPaths(event.target.value)} placeholder={'/srv/private\n/home/user/.ssh'} /></label>
    <label>禁止 AI 写入的路径（每行一个绝对路径）<textarea rows={4} value={writePaths} onChange={(event) => setWritePaths(event.target.value)} placeholder={'/srv/backup\n/etc/ssh'} /></label>
    <p>修改安全设置后，尚未执行的批准将失效。你手动输入的命令不受 AI 命令审核约束。</p>
    <div className={styles.dialogActions}><Button onClick={close}>取消</Button><Button variant="primary" type="submit">保存</Button></div>
  </form></div>;
}

export function ConfirmDialog({ title, children, confirmLabel, close, action, report }: DialogProps & {
  title: string; children: React.ReactNode; confirmLabel: string; action(): Promise<void>;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  return <div className={styles.scrim}><div className={styles.dialog} role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
    <h2 id="confirm-title">{title}</h2><p>{children}</p>
    <div className={styles.dialogActions}><Button onClick={close} disabled={busy}>取消</Button><Button variant="primary" disabled={busy} onClick={() => {
      setBusy(true); void capture(async () => { await action(); close(); }, report).finally(() => setBusy(false));
    }}>{confirmLabel}</Button></div>
  </div></div>;
}
