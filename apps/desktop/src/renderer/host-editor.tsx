import { useMemo, useState } from 'react';
import { validateHostConnectionSettings, type HostCredentialsPatch, type HostDraft, type HostView } from '@cloudhelm/contracts';
import { capture, Icon } from './ui-helpers.js';
import { HostConnectionTestStatus, useHostConnectionTest } from './host-connection-test.js';
import { AlgorithmFields, AuthenticationFields, ConnectionFields, GeneralFields, ProxyFields, SessionFields, TerminalFields, X11Fields, type HostEditorFields } from './host-editor-fields.js';
import ui from './ui.module.css';
import styles from './host-editor.module.css';

const sections = [
  { id: 'general', label: '常规', component: GeneralFields }, { id: 'authentication', label: '身份验证', component: AuthenticationFields },
  { id: 'connection', label: '连接', component: ConnectionFields }, { id: 'proxy', label: '代理', component: ProxyFields },
  { id: 'terminal', label: '终端与文件', component: TerminalFields }, { id: 'x11', label: 'X11 转发', component: X11Fields },
  { id: 'algorithms', label: '算法', component: AlgorithmFields }, { id: 'session', label: '启动设置', component: SessionFields }
] as const;
type Section = typeof sections[number]['id'];

export function HostDialog({ hosts, editing, close, report }: {
  hosts: HostView[]; editing?: HostView; close(): void; report(value: string): void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<HostDraft>(() => editing ? {
    label: editing.label, address: editing.address, port: editing.port, username: editing.username, auth: editing.auth,
    privateKeyPath: editing.privateKeyPath, jumpHostId: editing.jumpHostId, group: editing.group, notes: editing.notes,
    connection: editing.connection ? structuredClone(editing.connection) : undefined
  } : { label: '', address: '', port: 22, username: '', auth: 'password' });
  const [credentials, setCredentials] = useState<HostCredentialsPatch>({});
  const patch = useMemo(() => Object.fromEntries(Object.entries(credentials).filter(([, value]) => value !== undefined)) as HostCredentialsPatch, [credentials]);
  const [section, setSection] = useState<Section>('general');
  const [saving, setSaving] = useState(false), [selectingKey, setSelectingKey] = useState(false);
  const connectionTest = useHostConnectionTest(draft, '', editing?.id, report, patch);
  const busy = saving || selectingKey || connectionTest.testing;
  const update = (change: Partial<HostDraft>) => setDraft((current) => ({ ...current, ...change }));
  async function selectKey(): Promise<void> {
    if (busy) return;
    setSelectingKey(true);
    try { await capture(async () => { const path = await window.cloudhelm.selectPrivateKey(); if (path !== null) update({ privateKeyPath: path }); }, report); }
    finally { setSelectingKey(false); }
  }
  function validate(form: HTMLFormElement): boolean {
    const invalid = form.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input:invalid, select:invalid, textarea:invalid');
    if (invalid) {
      const id = invalid.closest<HTMLElement>('[data-host-section]')?.dataset.hostSection as Section | undefined;
      if (id) setSection(id);
      requestAnimationFrame(() => { invalid.focus(); invalid.reportValidity(); }); return false;
    }
    try { validateHostConnectionSettings(draft); }
    catch (error) { if (draft.auth === 'agent' || draft.auth === 'private-key' && !draft.privateKeyPath) setSection('authentication'); report(error instanceof Error ? error.message : '主机配置无效'); return false; }
    return true;
  }
  async function save(form: HTMLFormElement): Promise<void> {
    if (busy || !validate(form)) return;
    setSaving(true);
    try { await capture(async () => {
      const changes = Object.keys(patch).length ? patch : undefined;
      if (editing) await window.cloudhelm.editHost(editing.id, draft, undefined, changes);
      else await window.cloudhelm.addHost(draft, changes);
      setCredentials({}); close();
    }, report); } finally { setSaving(false); }
  }
  const props: HostEditorFields = { draft, update, credentials, credential: (key, value) => setCredentials((current) => ({ ...current, [key]: value })),
    editing, hosts, selectingKey, selectKey: () => void selectKey() };
  return <div className={ui.scrim}><form noValidate className={`${ui.dialog} ${styles.editor}`} role="dialog" aria-modal="true" aria-labelledby="host-title"
    onSubmit={(event) => { event.preventDefault(); void save(event.currentTarget); }}>
    <header className={styles.header}><h2 id="host-title">{editing ? '编辑 SSH 主机' : '添加 SSH 主机'}</h2>
      <button type="button" aria-label="关闭" disabled={saving} onClick={close}><Icon name="close" /></button></header>
    {editing && <p className={styles.existing}>连接参数只对新连接生效；保存后关闭旧终端并重新连接。正在运行的对话仍使用原连接。</p>}
    <div className={styles.body}>
      <nav className={styles.navigation} role="tablist" aria-label="主机配置分类" aria-orientation="vertical">
        {sections.map((item, index) => <button key={item.id} type="button" role="tab" id={`host-tab-${item.id}`} aria-controls={`host-section-${item.id}`}
          aria-selected={section === item.id} tabIndex={section === item.id ? 0 : -1} onClick={() => setSection(item.id)}
          onKeyDown={(event) => {
            const next = event.key === 'ArrowDown' ? (index + 1) % sections.length : event.key === 'ArrowUp' ? (index + sections.length - 1) % sections.length
              : event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : undefined;
            if (next !== undefined) { event.preventDefault(); setSection(sections[next]!.id); document.getElementById(`host-tab-${sections[next]!.id}`)?.focus(); }
          }}>{item.label}</button>)}
      </nav>
      <div className={styles.content}><fieldset className={styles.fields} disabled={busy}>
        {sections.map(({ id, component: Fields }) => <section key={id} role="tabpanel" id={`host-section-${id}`} aria-labelledby={`host-tab-${id}`}
          className={styles.section} hidden={section !== id} data-host-section={id}><Fields {...props} /></section>)}
      </fieldset></div>
    </div>
    <div className={styles.testStatus}><HostConnectionTestStatus testing={connectionTest.testing} result={connectionTest.result}
      confirm={(id) => void connectionTest.test(id)} dismiss={connectionTest.dismiss} /></div>
    <footer className={styles.footer}>
      <button type="button" disabled={busy} onClick={(event) => { const form = event.currentTarget.form; if (form && validate(form)) void connectionTest.test(); }}>{connectionTest.testing ? '正在测试…' : '测试连接'}</button>
      <small>测试只检查 SSH 连接，不执行启动命令或开启 X11。</small>
      <button type="button" disabled={saving} onClick={close}>取消</button>
      <button className={ui.primary} disabled={busy}>{saving ? '保存中…' : '保存'}</button>
    </footer>
  </form></div>;
}
