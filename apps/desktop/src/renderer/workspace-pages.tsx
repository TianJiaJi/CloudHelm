import { OperationLog } from './operation-log.js';
import { ExecutionJobStatus } from './execution-job-status.js';
import { MessageContent } from './message-content.js';
import { PrivilegeFeedback } from './privilege-feedback.js';
import { VerificationChecks } from './verification-checks.js';
import { VerificationFactsCard, VerificationHistory } from './verification-facts-card.js';
import { ReasoningContent } from './reasoning-content.js';
import { useEffect, useState } from 'react';
import type { OperationView, TaskView } from '@cloudhelm/contracts';
import { capture, Icon, statusLabel } from './ui-helpers.js';
import { useUi } from './store.js';
import { MarkdownMessage } from './markdown-message.js';
import { presentError } from './error-presentation.js';
import { copyEntries, copyText } from './clipboard.js';
import { openContextMenu, type ContextMenuEntry } from './context-menu.js';
import styles from './ui.module.css';

export function FilesPage({ hostId, host, report }: { hostId: string; host: string; report(error: string): void }): React.JSX.Element {
  const settings = useUi((state) => state.snapshot?.hosts.find((item) => item.id === hostId)?.connection);
  const visible = useUi((state) => state.activeTabId === `files:${hostId}`);
  const cwd = useUi((state) => Object.values(state.terminals).filter((terminal) => terminal.hostId === hostId && !terminal.taskId && terminal.state === 'human' && terminal.cwd)
    .sort((a, b) => (b.cwdUpdatedAt ?? 0) - (a.cwdUpdatedAt ?? 0))[0]?.cwd);
  const configured = settings?.session?.directory?.replace(/^~(?=\/|$)/u, '.') || '.';
  const initial = settings?.files?.followCwd !== false && cwd ? cwd : configured;
  const [path, setPath] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [refresh, setRefresh] = useState(0);
  const [watchFailed, setWatchFailed] = useState(false);
  const watch = settings?.files?.watch !== false;
  const follow = settings?.files?.followCwd !== false;
  useEffect(() => { if (follow && cwd) { setPath(cwd); setDraft(cwd); } }, [cwd, follow]);
  const [files, setFiles] = useState<Array<{ name: string; isDirectory: boolean; size: number }>>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!visible) return;
    let active = true, busy = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    setFiles([]); setWatchFailed(false);
    const load = async (initialLoad: boolean) => {
      if (busy || !active) return;
      busy = true; if (initialLoad) setLoading(true);
      try { const items = await window.cloudhelm.listRemote(hostId, path); if (active) setFiles(items); }
      catch (error: unknown) {
        if (active) { setWatchFailed(true); if (timer) clearInterval(timer); report(String(error)); }
      } finally { busy = false; if (active) setLoading(false); }
    };
    void load(true);
    if (watch) timer = setInterval(() => { if (document.visibilityState === 'visible') void load(false); }, 5000);
    return () => { active = false; if (timer) clearInterval(timer); };
  }, [hostId, path, report, refresh, watch, visible]);
  function navigate(next: string): void { setPath(next); setDraft(next); }
  const remotePath = (name: string): string => `${path.replace(/\/$/u, '')}/${name}`;
  /** Read-only file listing: menus copy paths or descend, never modify the host. */
  function fileMenuEntries(file: { name: string; isDirectory: boolean }): ContextMenuEntry[] {
    const full = remotePath(file.name);
    const entries: ContextMenuEntry[] = [...copyEntries('复制完整路径', full),
      { id: 'copy-name', label: '复制文件名', icon: 'copy', run: () => void copyText(file.name) }];
    if (file.isDirectory) entries.push({ id: 'd1', separator: true },
      { id: 'open', label: '进入目录', icon: 'folder', run: () => navigate(full) });
    return entries;
  }
  return <section className={styles.filesPage}
    onContextMenu={(event) => openContextMenu(event, [
      { id: 'copy-path', label: '复制当前路径', icon: 'copy', run: () => void copyText(path) },
      { id: 'up', label: '上一级', icon: 'arrow', disabled: path === '/', run: () => navigate(path === '/' ? '/' : `${path.replace(/\/$/u, '')}/..`) }
    ], '文件页操作')}>
    <div className={styles.pageHead}><div><small>{host}</small><h2>远程文件</h2></div><span className={styles.pill}>只读 SFTP</span></div>
    <form className={styles.pathRow} onSubmit={(event) => { event.preventDefault(); navigate(draft); }}>
      <button type="button" title="上一级" onClick={() => navigate(path === '/' ? '/' : `${path.replace(/\/$/u, '')}/..`)}><Icon name="arrow" /></button>
      <input aria-label="远程目录" value={draft} onChange={(event) => setDraft(event.target.value)} /><button>前往</button>
      <button type="button" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>刷新</button>
    </form>
    <p className={styles.note}>只读目录浏览 · {watchFailed ? '自动刷新已停止，请手动重试' : watch ? '可见时每 5 秒刷新' : '自动刷新已关闭'} · {follow ? '跟随人工终端目录' : '目录跟随已关闭'}。需要修改文件时，可在 AI 助手中说明，变更将经过审核。</p>
    <div className={styles.fileTable}><div className={styles.fileHeader}><span>名称</span><span>大小</span></div>
      {loading ? <p>正在读取目录…</p> : files.length ? [...files].sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name)).map((file) =>
        <button className={styles.fileRow} key={file.name} disabled={!file.isDirectory}
          onContextMenu={(event) => openContextMenu(event, fileMenuEntries(file), `${file.name} 文件操作`)}
          onClick={() => navigate(`${path.replace(/\/$/u, '')}/${file.name}`)}>
          <span><Icon name={file.isDirectory ? 'folder' : 'file'} />{file.name}</span><small>{file.isDirectory ? '文件夹' : new Intl.NumberFormat('zh-CN').format(file.size) + ' B'}</small>
        </button>) : <p>这个目录是空的。</p>}
    </div>
  </section>;
}

export function OperationCard({ operation, report }: { operation: OperationView; report(error: string): void }): React.JSX.Element {
  const terminal = useUi((state) => operation.logRef ? state.terminals[operation.logRef] : undefined);
  const [logOpen, setLogOpen] = useState(false);
  // A reused terminal's buffer can contain another operation. Read only this operation's log.
  const output = operation.outputTail;
  const statuses = { proposed: '审核中', approved: '已批准', running: '执行中', succeeded: '已完成', failed: '执行失败', denied: '已拦截', unknown: '结果待核验' };
  function menuEntries(): ContextMenuEntry[] {
    const entries: ContextMenuEntry[] = [{ id: 'copy-command', label: '复制命令', icon: 'copy', run: () => void copyText(operation.preview) }];
    if (output) entries.push({ id: 'copy-output', label: '复制输出', icon: 'copy', run: () => void copyText(output) });
    entries.push({ id: 'd1', separator: true });
    if (terminal) entries.push({ id: 'open-terminal', label: '打开 AI 终端', icon: 'terminal', run: () => useUi.getState().openTerminal(terminal.id) });
    if (operation.logRef) entries.push({ id: 'log', label: '查看日志',
      run: () => setLogOpen(true) });
    return entries;
  }
  return <section className={styles.operationCard} onContextMenu={(event) => openContextMenu(event, menuEntries(), '操作详情')}>
    <div className={styles.cardTitle}><Icon name="terminal" /><strong>{operation.kind === 'command' ? '远程命令' : '文件操作'}</strong><small>{operation.reconciliation?.kind === 'risk-accepted' ? '风险已接管' : statuses[operation.status]}</small></div>
    <pre className={styles.command}>{operation.preview}</pre>
    <small>操作 {operation.id}{operation.logRef ? ` · 终端 ${operation.logRef}` : ''}</small>
    <ExecutionJobStatus operation={operation} report={report} />
    <PrivilegeFeedback value={operation.privilege} />
    {output && <pre className={styles.outputTail}>{output.slice(-1600)}</pre>}
    {operation.manualReviewAvailable && operation.ruleId === 'ai-review-deny' && <div className={styles.cardActions}>
      <button onClick={() => void capture(() => window.cloudhelm.requestAiDenialReview(operation.taskId, operation.id), report)}>申请人工复核这次操作</button>
    </div>}
    <details><summary>操作详情{operation.exitCode !== undefined ? ` · 退出码 ${operation.exitCode}` : ''}</summary>
      {operation.interruption && <p>用户主动中断（{operation.interruption.source === 'ctrl-c' ? 'Ctrl+C' : operation.interruption.source === 'terminal-close' ? '关闭终端' : '停止按钮'}）；{operation.status === 'unknown' ? '远端结果待核验' : `实际退出码：${operation.exitCode ?? '待确认'}`}。</p>}
      {operation.reason && <p>{operation.reason}</p>}{operation.reconciliation?.kind === 'risk-accepted' && <p>用户已逐条接管未知结果风险：{operation.reconciliation.explanation}。这不是成功证据，也未执行新命令。</p>}{operation.model && <small>{operation.model.provider} · {operation.model.modelId}</small>}
      <div className={styles.cardActions}>{terminal && <button onClick={() => useUi.getState().openTerminal(terminal.id)}><Icon name="terminal" />打开 AI 终端</button>}
        {operation.logRef && <button onClick={() => setLogOpen(true)}>查看操作日志</button>}</div>
    </details>
    {operation.status === 'running' && !logOpen && <button type="button" onClick={() => setLogOpen(true)}>查看增量日志</button>}
    {logOpen && <><button type="button" onClick={() => setLogOpen(false)}>收起日志</button><OperationLog key={operation.id} taskId={operation.taskId} operationId={operation.id}
      live={operation.status === 'running'} report={report} /></>}
  </section>;
}

export function VerificationCard({ conversation, report, compact = false }: { conversation: TaskView; report(error: string): void; compact?: boolean }): React.JSX.Element | null {
  // The answer is the result. Evidence is opt-in; pending recovery has its own
  // backend-driven controls and must not become a second generic verdict.
  if (compact && conversation.status !== 'failed') return null;
  if (conversation.report?.facts && conversation.status !== 'failed') return <VerificationFactsCard conversation={conversation} value={conversation.report} report={report} />;
  const failure = conversation.status === 'failed' ? presentError(conversation.summary) : null;
  const conclusion = failure?.description ?? conversation.report?.summary ?? conversation.summary ?? '';
  return <section className={`${styles.reviewCard} ${styles.verificationCard} ${failure ? styles.verificationWarning : ''}`}
    role={failure ? 'alert' : undefined}
    onContextMenu={(event) => openContextMenu(event, copyEntries('复制结论', conclusion, report), '验证结论')}>
    <div className={styles.cardTitle}><Icon name="shield" /><strong>{failure?.title ?? (conversation.report ? '历史报告 · 模型判断' : '历史操作记录')}</strong></div>
    <p>{conclusion || '此历史记录未保存结果说明。'}</p>
    <VerificationChecks value={conversation.report} />
    {failure && conversation.report?.facts && <VerificationFactsCard conversation={conversation} value={conversation.report} report={report} />}
    {failure ? <details><summary>查看错误详情</summary><pre className={styles.outputTail}>{failure.details}</pre></details>
      : conversation.report?.access.map((address) => <code className={styles.access} key={address}>{address}</code>)}
    <div className={styles.cardActions}>
      <button onClick={() => useUi.getState().openReport(conversation.id)}>{failure ? '查看对话记录' : '查看完整报告'}</button>
    </div>
  </section>;
}

export function ReportPage({ conversation, operations, report }: { conversation: TaskView; operations: OperationView[]; report(error: string): void }): React.JSX.Element {
  const snapshot = useUi((state) => state.snapshot);
  const messages = snapshot?.messages.filter((message) => message.taskId === conversation.id) ?? [];
  return <section className={styles.reportPage}>
    <div className={styles.pageHead}><div><small>AI 对话详情</small><h2>{conversation.goal}</h2></div><span className={styles.pill}>{statusLabel[conversation.status]}</span></div>
    {!conversation.report && (conversation.status === 'failed' || conversation.status === 'answered' && conversation.verificationState?.status === 'unverified') && <VerificationCard conversation={conversation} report={report} />}
    {conversation.report && <>
      <VerificationCard conversation={conversation} report={report} />
      <h3>变更</h3><ul>{conversation.report.changes.map((item) => <li key={item}>{item}</li>)}</ul>
      <h3>恢复说明</h3><ul>{conversation.report.recovery.map((item) => <li key={item}>{item}</li>)}</ul>
      <h3>验证证据</h3>{operations.filter((operation) => conversation.report?.evidenceOperationIds.includes(operation.id)).map((operation) => <OperationCard key={operation.id} operation={operation} report={report} />)}
    </>}
    <VerificationHistory values={conversation.verificationHistory} />
    <h3>对话记录</h3>{messages.map((message, index) => <article className={styles.message} key={`${message.createdAt}:${index}`}
      onContextMenu={(event) => openContextMenu(event, copyEntries('复制文本', message.text, report), '消息操作')}>
      <strong>{message.role === 'user' ? '你' : message.role === 'agent' ? 'CloudHelm' : '系统'}</strong>{message.role === 'agent' ? <><ReasoningContent value={message.reasoning} />{message.text && <MarkdownMessage text={message.text} />}</> : message.document ? <MessageContent document={message.document} /> : <p>{message.text}</p>}</article>)}
    {!!operations.length && <details><summary>全部操作（{operations.length}）</summary>{operations.map((operation) => <OperationCard key={operation.id} operation={operation} report={report} />)}</details>}
  </section>;
}
