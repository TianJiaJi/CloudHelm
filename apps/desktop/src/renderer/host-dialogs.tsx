import { useState } from 'react';
import type { HostDraft, HostView, ReviewMode } from '@cloudhelm/contracts';
import { capture, Icon } from './ui-helpers.js';
import styles from './ui.module.css';

type DialogProps = { close(): void; report(value: string): void };
export function HostDialog({ hosts, editing, close, report }: DialogProps & { hosts: HostView[]; editing?: HostView }): React.JSX.Element {
  const [draft, setDraft] = useState<HostDraft>(editing
    ? { label: editing.label, address: editing.address, port: editing.port, username: editing.username,
      auth: editing.auth, privateKeyPath: editing.privateKeyPath, jumpHostId: editing.jumpHostId }
    : { label: '', address: '', port: 22, username: '', auth: 'agent' });
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const update = (change: Partial<HostDraft>) => setDraft({ ...draft, ...change });
  async function save(): Promise<void> {
    setSaving(true);
    await capture(async () => {
      if (editing) await window.cloudhelm.editHost(editing.id, draft, secret || undefined);
      else {
        const host = await window.cloudhelm.addHost(draft);
        if (secret) await window.cloudhelm.setHostSecret(host.id, secret);
      }
      setSecret(''); close();
    }, report);
    setSaving(false);
  }
  return <div className={styles.scrim}><form className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="host-title"
    onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <div className={styles.dialogHead}><h2 id="host-title">{editing ? '编辑 SSH 主机' : '添加 SSH 主机'}</h2><button type="button" aria-label="关闭" onClick={close}><Icon name="close" /></button></div>
    {editing && <p className={styles.notice}>连接配置只对新连接生效。保存后，请关闭原终端并重新连接；正在运行的对话仍使用原连接。</p>}
    <label>名称<input required autoFocus maxLength={80} value={draft.label} onChange={(event) => update({ label: event.target.value })} placeholder="例如：生产服务器" /></label>
    <label>服务器地址<input required value={draft.address} onChange={(event) => update({ address: event.target.value })} placeholder="192.0.2.10 或 example.com" /></label>
    <div className={styles.formRow}><label>端口<input type="number" required min="1" max="65535" value={draft.port} onChange={(event) => update({ port: Number(event.target.value) })} /></label>
      <label>账户<input required value={draft.username} onChange={(event) => update({ username: event.target.value })} placeholder="ubuntu" /></label></div>
    <label>认证方式<select value={draft.auth} onChange={(event) => update({ auth: event.target.value as HostDraft['auth'], privateKeyPath: undefined })}>
      <option value="agent">SSH Agent</option><option value="private-key">私钥</option><option value="password">密码</option>
    </select></label>
    {draft.auth === 'private-key' && <label>私钥路径<input required value={draft.privateKeyPath ?? ''} onChange={(event) => update({ privateKeyPath: event.target.value })} placeholder="/Users/you/.ssh/id_ed25519" /></label>}
    <label>跳板机<select value={draft.jumpHostId ?? ''} onChange={(event) => update({ jumpHostId: event.target.value || undefined })}>
      <option value="">直连（不使用跳板机）</option>{hosts.filter((host) => !host.jumpHostId && host.id !== editing?.id).map((host) => <option key={host.id} value={host.id}>{host.label}</option>)}
    </select></label>
    {draft.auth !== 'agent' && <label>{draft.auth === 'password' ? 'SSH 密码' : '私钥口令（如有）'}
      <input type="password" autoComplete="new-password" required={draft.auth === 'password' && (!editing || editing.auth !== 'password')}
        value={secret} onChange={(event) => setSecret(event.target.value)} placeholder={editing && editing.auth === draft.auth ? '留空保留现有凭据' : ''} /></label>}
    <div className={styles.dialogActions}><button type="button" onClick={close}>取消</button><button className={styles.primary} disabled={saving}>{saving ? '保存中…' : '保存'}</button></div>
  </form></div>;
}

export function SafetyDialog({ host, close, report }: DialogProps & { host: HostView }): React.JSX.Element {
  const [mode, setMode] = useState<ReviewMode>(host.defaultMode);
  const [paths, setPaths] = useState(host.protectedPaths.join('\n'));
  return <div className={styles.scrim}><form className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="safety-title"
    onSubmit={(event) => { event.preventDefault(); void capture(async () => {
      await window.cloudhelm.updateHostSafety(host.id, mode, paths.split('\n').map((value) => value.trim()).filter(Boolean)); close();
    }, report); }}>
    <div className={styles.dialogHead}><h2 id="safety-title">{host.label} · 安全设置</h2><button type="button" aria-label="关闭" onClick={close}><Icon name="close" /></button></div>
    <p>已识别的硬禁令在所有档位都拦截；完整满足低风险白名单的操作自动执行。</p>
    <label>其他操作如何审核<select value={mode} onChange={(event) => setMode(event.target.value as ReviewMode)}>
      <option value="ask">第一档 · 每次由我批准</option><option value="ai-review">第二档 · AI 审核（推荐）</option><option value="permissive">第三档 · 默认自动执行</option>
    </select></label>
    <p className={styles.notice}>{mode === 'ai-review' ? '优先由 Jev 审核；未配置 Jev Key 时使用当前对话模型独立审核。审核要求确认时会在助手中提示。' : mode === 'permissive' ? '不透明脚本只能尽力识别风险，无法保证拦截所有危险操作。' : '每条非白名单操作都需你批准；批准只适用于当前完整操作。'}</p>
    <label>保护路径（每行一个绝对路径）<textarea rows={5} value={paths} onChange={(event) => setPaths(event.target.value)} placeholder={'/srv/backup\n/etc/ssh'} /></label>
    <p>修改安全设置后，尚未执行的批准将失效。你手动输入的命令不受 AI 命令审核约束。</p>
    <div className={styles.dialogActions}><button type="button" onClick={close}>取消</button><button className={styles.primary}>保存</button></div>
  </form></div>;
}

export function ConfirmDialog({ title, children, confirmLabel, close, action, report }: DialogProps & {
  title: string; children: React.ReactNode; confirmLabel: string; action(): Promise<void>;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  return <div className={styles.scrim}><div className={styles.dialog} role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
    <h2 id="confirm-title">{title}</h2><p>{children}</p>
    <div className={styles.dialogActions}><button onClick={close} disabled={busy}>取消</button><button className={styles.primary} disabled={busy} onClick={() => {
      setBusy(true); void capture(async () => { await action(); close(); }, report).finally(() => setBusy(false));
    }}>{confirmLabel}</button></div>
  </div></div>;
}
