import { useEffect, useRef, useState } from 'react';
import type { AppSnapshot, HostView, LocalScope, ModelChoice, TaskView } from '@cloudhelm/contracts';
import { useUi } from './store.js';
import { ApprovalCard, InputCard } from './interaction-cards.js';
import { OperationCard, VerificationCard } from './workspace-pages.js';
import { MarkdownMessage } from './markdown-message.js';
import { ClarificationCard } from './clarification-card.js';
import { UserMessage } from './user-message.js';
import { conversationTimeline } from './conversation-timeline.js';
import { capture, Icon, reviewLabel, statusLabel } from './ui-helpers.js';
import { copyEntries, copyText } from './clipboard.js';
import { openContextMenu, type ContextMenuEntry } from './context-menu.js';
import { ComposerFooter, ModelPicker } from './composer-controls.js';
import styles from './ui.module.css';

type ModelOption = ModelChoice & { name: string };
type LocalAttachment = { token: string; scope: LocalScope };
const composerDrafts = new Map<string, { text: string; attachments: LocalAttachment[] }>();
const consumedQuotes = new Set<number>();
export interface QuotedOutput { id: number; text: string }

export function AgentPanel({ snapshot, host, conversation, quote, report, openInput, hiddenInputs }: {
  snapshot: AppSnapshot; host?: HostView; conversation?: TaskView; quote: QuotedOutput | null;
  report(error: string): void; openInput(id: string): void; hiddenInputs: string[];
}): React.JSX.Element {
  const [models, setModels] = useState<ModelOption[]>([]);
  const scroll = useRef<HTMLDivElement>(null);
  const messages = snapshot.messages.filter((message) => message.taskId === conversation?.id);
  const operations = snapshot.operations.filter((operation) => operation.taskId === conversation?.id);
  const clarifications = (snapshot.clarifications ?? []).filter((request) => request.taskId === conversation?.id);
  const timeline = conversationTimeline(messages.filter((message) => !message.text.startsWith('[需求澄清回答]')), operations.slice(-6), clarifications);
  const approvals = snapshot.approvals.filter((approval) => approval.taskId === conversation?.id);
  const inputs = snapshot.inputs.filter((input) => input.taskId === conversation?.id);
  const terminal = useUi((state) => {
    const sessions = Object.values(state.terminals).filter((item) => conversation && item.taskId === conversation.id);
    return sessions.find((item) => item.state === 'agent') ?? sessions.at(-1);
  });
  const running = conversation && ['running', 'waiting-review', 'waiting-user', 'recovering'].includes(conversation.status);
  const hasRunningOperation = operations.some((operation) => operation.status === 'running'
    || (operation.status === 'unknown' && snapshot.terminals.some((terminal) => terminal.id === operation.logRef)));
  useEffect(() => { void window.cloudhelm.availableModels().then(setModels).catch((error: unknown) => report(String(error))); }, [snapshot.profile.provider, snapshot.profile.modelId, snapshot.profile.hasKey, report]);
  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }); }, [conversation?.id, messages.length, operations.length, clarifications.length]);
  const hostName = (id: string): string => snapshot.hosts.find((item) => item.id === id)?.label ?? id;
  return <>
    <header className={styles.agentHead}><span><Icon name="chat" />AI 助手</span><div><button title="新对话" aria-label="新对话" onClick={() => useUi.getState().newConversation(host?.id ?? null)}><Icon name="plus" /></button>
      {conversation && <button title="展开对话详情" aria-label="展开对话详情" onClick={() => useUi.getState().openReport(conversation.id)}><Icon name="expand" /></button>}
      <button title="收起助手" aria-label="收起助手" onClick={useUi.getState().toggleAgentPanel}><Icon name="close" /></button></div></header>
    <div className={styles.assistantContext}><span><span className={`${styles.dot} ${host?.status === 'connected' ? styles.online : ''}`} />{host ? `${host.label} · ${host.username}` : '自由对话'}</span>
      <small>{host ? <><Icon name="shield" size={12} />{reviewLabel[host.defaultMode]}</> : '未授权远端操作'}</small></div>
    {conversation && <div className={styles.agentActions}>
      <span className={styles.status}>{statusLabel[conversation.status]}</span>
      {(running || hasRunningOperation) && <button title="停止本轮 AI，并请求终止正在运行的命令" onClick={() => void capture(() => window.cloudhelm.stopOperation(conversation.id), report)}><Icon name="stop" size={13} />停止</button>}
      {conversation.session && !running && ['paused', 'failed', 'human-control'].includes(conversation.status) && <button onClick={() => void capture(() => window.cloudhelm.resumeConversation(conversation.id), report)}><Icon name="play" size={13} />继续 AI</button>}
    </div>}
    <div className={styles.agentScroll} ref={scroll}>
      {!conversation && <div className={styles.agentWelcome}><span className={styles.welcomeIcon}><Icon name="chat" size={25} /></span><h2>{host ? '这台服务器，需要做些什么？' : '有什么想聊的？'}</h2>
        <p>{host ? '用自然语言告诉我目标。我会调查、执行并验证结果，需要你决定时会在这里说明。' : '可以直接提问。连接左侧主机后，也可以让我协助操作服务器。'}</p>
        {host && <div className={styles.suggestions}><span>你可以这样说</span><p>检查这台服务器的磁盘占用</p><p>帮我把这个服务装成 Docker 并启动</p></div>}
      </div>}
      {!!conversation?.plan?.length && <details className={styles.planCard} open onContextMenu={(event) => openContextMenu(event, copyEntries('复制执行计划',
        conversation.plan!.map((step) => `${step.status === 'done' ? '✓' : step.status === 'running' ? '•' : '○'} ${step.title}`).join('\n'), report), '执行计划')}><summary>执行计划</summary><ol>{conversation.plan.map((step) => <li key={step.id} data-state={step.status}><span>{step.status === 'done' ? '✓' : step.status === 'running' ? '•' : '○'}</span>{step.title}</li>)}</ol></details>}
      {operations.length > 6 && <button className={styles.textButton} onClick={() => conversation && useUi.getState().openReport(conversation.id)}>查看更早的操作</button>}
      {timeline.map((entry) => {
        if (entry.kind === 'clarification') return <ClarificationCard key={entry.key} request={entry.value} />;
        if (entry.kind === 'operation') return <OperationCard key={entry.key} operation={entry.value} report={report} />;
        const message = entry.value;
        if (message.role === 'user') return <UserMessage key={`${message.taskId}:${entry.key}`} message={message} canEdit={!!conversation?.session && conversation.hostIds.length <= 1} report={report} />;
        return <article key={entry.key} className={styles.message}
          onContextMenu={(event) => openContextMenu(event, copyEntries('复制文本', message.text, report), '消息操作')}>
          <strong>{message.role === 'agent' ? 'CloudHelm' : '系统'}</strong>{message.role === 'agent' ? <MarkdownMessage text={message.text} /> : <p>{message.text}</p>}
          {message.model && <small>{message.model.provider} · {message.model.modelId}</small>}
        </article>;
      })}
      {running && !hasRunningOperation && timeline.at(-1)?.kind === 'operation' && <p className={styles.note} role="status">AI 正在处理执行结果…</p>}
      {approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} host={hostName(approval.hostId)} report={report} />)}
      {inputs.filter((input) => input.kind !== 'secret' && input.kind !== 'otp').map((input) => <InputCard key={input.id} input={input} host={hostName(input.hostId)} report={report} />)}
      {inputs.filter((input) => (input.kind === 'secret' || input.kind === 'otp') && hiddenInputs.includes(input.id)).map((input) => <button className={styles.pendingInput} key={input.id} onClick={() => openInput(input.id)}><Icon name="shield" />{input.title} · 填写</button>)}
      {terminal && <button className={styles.agentTerminalLink} onClick={() => useUi.getState().openTerminal(terminal.id)}><Icon name="terminal" />打开 AI 专用终端<Icon name="chevron" size={12} /></button>}
      {conversation && ['ready-for-review', 'accepted', 'failed'].includes(conversation.status) && <VerificationCard conversation={conversation} report={report} />}
    </div>
    <Composer key={conversation?.id ?? `draft:${host?.id ?? 'chat'}`} hostId={host?.id ?? null} conversation={conversation} host={host} compaction={conversation ? snapshot.contextCompaction?.[conversation.id] : undefined} usage={conversation ? snapshot.contextUsage?.[conversation.id] : undefined} profile={snapshot.profile} models={models} quote={quote} report={report} />
  </>;
}

function Composer({ hostId, host, usage, compaction, conversation, profile, models, quote, report }: {
  hostId: string | null; host?: HostView; compaction?: 'running' | 'complete' | 'failed'; usage?: import('@cloudhelm/contracts').ContextUsageView; conversation?: TaskView; profile: AppSnapshot['profile']; models: ModelOption[]; quote: QuotedOutput | null; report(error: string): void;
}): React.JSX.Element {
  const draftKey = conversation?.id ?? `draft:${hostId ?? 'chat'}`;
  const [text, setText] = useState(() => composerDrafts.get(draftKey)?.text ?? '');
  const [attachments, setAttachments] = useState<LocalAttachment[]>(() => composerDrafts.get(draftKey)?.attachments ?? []);
  const [attachmentMenu, setAttachmentMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [model, setModel] = useState<ModelChoice>({ provider: conversation?.provider ?? profile.provider, modelId: conversation?.modelId ?? profile.modelId });
  const currentRequest = useUi((state) => conversation ? state.currentRequests[conversation.id] : undefined);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const waiting = conversation?.status === 'waiting-user';
  const legacy = !!conversation && (!conversation.session || conversation.hostIds.length > 1);
  const pendingModel = conversation?.status === 'running' && currentRequest && (currentRequest.model.provider !== model.provider || currentRequest.model.modelId !== model.modelId);
  useEffect(() => {
    if (quote && !consumedQuotes.has(quote.id)) {
      consumedQuotes.add(quote.id);
      if (consumedQuotes.size > 32) consumedQuotes.delete(consumedQuotes.values().next().value!);
      setText((value) => [value, quote.text].filter(Boolean).join('\n\n')); textarea.current?.focus();
    }
  }, [quote]);
  useEffect(() => { composerDrafts.set(draftKey, { text, attachments }); }, [draftKey, text, attachments]);
  useEffect(() => { if (!conversation) setModel({ provider: profile.provider, modelId: profile.modelId }); }, [conversation, profile.provider, profile.modelId]);
  async function attach(kind: LocalScope['kind']): Promise<void> {
    setAttachmentMenu(false);
    await capture(async () => { const selected = await window.cloudhelm.selectLocalPath(kind); if (selected) setAttachments((items) => [...items, selected]); }, report);
  }
  async function chooseModel(value: string): Promise<void> {
    const selected = models.find((item) => `${item.provider}/${item.modelId}` === (value === '__reapply__' ? `${model.provider}/${model.modelId}` : value));
    if (!selected) return;
    setSwitching(true);
    await capture(async () => {
      if (conversation) await window.cloudhelm.setConversationModel(conversation.id, selected);
      setModel({ provider: selected.provider, modelId: selected.modelId });
    }, report);
    setSwitching(false);
  }
  async function send(): Promise<void> {
    const message = text.trim();
    if (!message || busy || switching || legacy || waiting) return;
    setBusy(true);
    await capture(async () => {
      if (conversation) await window.cloudhelm.sendMessage(conversation.id, message, attachments.map((item) => item.token));
      else {
        const started = await window.cloudhelm.startConversation({ hostId, message, model, localSelectionTokens: attachments.map((item) => item.token) });
        const snapshot = await window.cloudhelm.snapshot();
        composerDrafts.delete(draftKey);
        useUi.getState().setSnapshot(snapshot); useUi.getState().selectConversation(started.id);
      }
      setText(''); setAttachments([]);
    }, report);
    setBusy(false);
  }
  function attachmentMenuEntries(item: LocalAttachment): ContextMenuEntry[] {
    return [
      { id: 'copy-path', label: '复制完整路径', icon: 'copy', run: () => void copyText(item.scope.path) },
      { id: 'd1', separator: true },
      { id: 'remove', label: '移除附件', icon: 'close', danger: true,
        run: () => setAttachments((items) => items.filter((attachment) => attachment.token !== item.token)) }
    ];
  }
  return <div className={styles.composerWrap}>
    {legacy && <p className={styles.notice}>此旧对话仅供查看，无法恢复模型上下文。请开始新对话。</p>}
    <form className={styles.composer} onSubmit={(event) => { event.preventDefault(); void send(); }}>
      {!!attachments.length && <div className={styles.attachments}>{attachments.map((item) => <span key={item.token}
        onContextMenu={(event) => openContextMenu(event, attachmentMenuEntries(item), '附件操作')}>
        <Icon name={item.scope.kind === 'directory' ? 'folder' : 'file'} size={12} />{item.scope.path.split(/[\\/]/u).at(-1)}<button type="button" aria-label={`移除 ${item.scope.path}`} onClick={() => setAttachments((items) => items.filter((attachment) => attachment.token !== item.token))}><Icon name="close" size={11} /></button></span>)}</div>}
      <textarea ref={textarea} rows={3} aria-label="给 AI 的消息" placeholder={waiting ? '请先回答上方问题，或停止本轮对话' : hostId ? '描述你的目标，或补充下一步…' : '问点什么…'} value={text} disabled={legacy || waiting}
        onChange={(event) => { setText(event.target.value); event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`; }}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
      <div className={styles.composerTools}><div className={styles.attachControl}>
        <button type="button" aria-label="添加本地资料" title="添加本地资料" disabled={legacy || waiting} onClick={() => setAttachmentMenu(!attachmentMenu)}><Icon name="plus" size={18} /></button>
        {attachmentMenu && <div className={styles.attachMenu}><button type="button" onClick={() => void attach('file')}><Icon name="file" />选择文件</button><button type="button" onClick={() => void attach('directory')}><Icon name="folder" />选择目录</button></div>}
      </div>
        {models.length ? <ModelPicker models={models} selected={model} disabled={switching || legacy} conversation={!!conversation} choose={chooseModel} />
          : <button type="button" className={styles.configureModel} onClick={() => useUi.getState().setSettingsOpen(true)}>配置模型</button>}
        <button type="submit" className={styles.sendButton} aria-label="发送消息" title="Enter 发送 · Shift + Enter 换行" disabled={!text.trim() || busy || switching || !models.length || legacy || waiting}><Icon name="arrow" size={16} /></button>
      </div>
    </form>
    <ComposerFooter compaction={compaction} host={host} legacy={legacy} usage={usage} pendingModel={pendingModel ? model.modelId : undefined} report={report} />
  </div>;
}
