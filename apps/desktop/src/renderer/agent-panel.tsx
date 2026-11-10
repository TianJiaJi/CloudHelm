import { AgentActivity } from './agent-activity.js';
import { ConversationQueue } from './conversation-queue.js';
import workspaceStyles from './execution-workspace.module.css';
import { MessageEditor } from './message-editor.js';
import { draftFor, useMessageDrafts } from './message-drafts.js';
import { ReasoningContent } from './reasoning-content.js';
import { ThinkingPicker } from './thinking-picker.js';
import { useEffect, useRef, useState } from 'react';
import { operationNeedsVerification, type AppSnapshot, type HostView, type LocalScope, type ModelChoice, type TaskView } from '@cloudhelm/contracts';
import { useUi } from './store.js';
import { ApprovalCard, InputCard } from './interaction-cards.js';
import { VerificationCard } from './workspace-pages.js';
import { ActivityLabel, AgentPanelHeader, AgentPlan, AssistantIdentity } from './agent-panel-parts.js';
import { RecoveryCard } from './recovery-card.js';
import { RequestBudgetCard } from './request-budget-card.js';
import { ConversationTranscript } from './conversation-transcript.js';
import { presentError } from './error-presentation.js';
import { capture, Icon, reviewLabel } from './ui-helpers.js';
import { copyText } from './clipboard.js';
import { openContextMenu, type ContextMenuEntry } from './context-menu.js';
import { ComposerFooter, ModelPicker, PermissionPicker, useMenuAnchor } from './composer-controls.js';
import { MenuItem, MenuSurface } from './menu-surface.js';
import styles from './ui.module.css';
import panelStyles from './agent-panel.module.css';
import composerStyles from './agent-composer.module.css';

type ModelOption = ModelChoice & { name: string; thinkingLevels?: import('@cloudhelm/contracts').ThinkingLevel[] };
type LocalAttachment = { token: string; scope: LocalScope };
const composerDrafts = new Map<string, { attachments: LocalAttachment[]; queueMode?: 'steer' | 'followUp' }>();

export function AgentPanel({ snapshot, host, conversation, report, openInput, hiddenInputs }: {
  snapshot: AppSnapshot; host?: HostView; conversation?: TaskView;
  report(error: string): void; openInput(id: string): void; hiddenInputs: string[];
}): React.JSX.Element {
  const [models, setModels] = useState<ModelOption[]>([]);
  const reasoning = conversation ? snapshot.reasoningProgress?.[conversation.id] : undefined;
  const scroll = useRef<HTMLDivElement>(null);
  const scrollPinned = useRef(true);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const [now, setNow] = useState(Date.now());
  const operations = snapshot.operations.filter((operation) => operation.taskId === conversation?.id);
  const approvals = snapshot.approvals.filter((approval) => approval.taskId === conversation?.id);
  const inputs = snapshot.inputs.filter((input) => input.taskId === conversation?.id);
  const terminal = useUi((state) => {
    const sessions = Object.values(state.terminals).filter((item) => conversation && item.taskId === conversation.id);
    return sessions.find((item) => item.state === 'agent') ?? sessions.at(-1);
  });
  const running = conversation && ['running', 'waiting-review', 'waiting-user', 'recovering'].includes(conversation.status);
  const hasRunningOperation = operations.some((operation) => operation.status === 'running'
    || (operation.status === 'unknown' && !operation.reconciledAt && snapshot.terminals.some((terminal) => terminal.id === operation.logRef)));
  const currentRequest = useUi((state) => conversation ? state.currentRequests[conversation.id] : undefined);
  const elapsed = currentRequest ? Math.max(0, Math.floor((now - currentRequest.createdAt) / 1000)) : 0;
  const activity = approvals.length ? '等待你批准或拒绝当前操作；命令尚未执行'
    : conversation?.status === 'waiting-review' ? '正在准备操作审批…'
      : inputs.length ? '等待你提供当前操作所需的信息'
        : hasRunningOperation ? '远端命令正在执行；可打开 AI 终端查看输出'
          : running && currentRequest ? `模型正在生成${reasoning ? '思考内容' : '回复'} · ${elapsed} 秒${elapsed >= 90 ? '；如需中止可点击停止' : ''}`
            : running ? 'AI 正在准备下一步…' : '';
  useEffect(() => { void window.cloudhelm.availableModels().then(setModels).catch((error: unknown) => report(String(error))); }, [snapshot.profile.provider, snapshot.profile.modelId, snapshot.profile.hasKey, report]);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  useEffect(() => {
    scrollPinned.current = true;
    setAwayFromLatest(false);
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [conversation?.id]);
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (!scrollPinned.current || frame) return;
      frame = window.requestAnimationFrame(() => { frame = 0; element.scrollTop = element.scrollHeight; });
    });
    observer.observe(element, { childList: true, characterData: true, subtree: true });
    const resize = new ResizeObserver(() => {
      if (scrollPinned.current) element.scrollTop = element.scrollHeight;
    });
    resize.observe(element);
    return () => { observer.disconnect(); resize.disconnect(); if (frame) window.cancelAnimationFrame(frame); };
  }, [conversation?.id]);
  const hostName = (id: string): string => snapshot.hosts.find((item) => item.id === id)?.label ?? id;
  return <section className={panelStyles.panel} aria-label="AI 助手面板">
    <AgentPanelHeader snapshot={snapshot} conversation={conversation} hostId={host?.id} />
    <div className={panelStyles.assistantContext}><span><span className={`${styles.dot} ${host?.status === 'connected' ? styles.online : ''}`} />{host ? `${host.label} · ${host.username}` : '自由对话'}</span>
      <small>{host ? <><Icon name="shield" size={12} />{reviewLabel[conversation?.reviewModesByHost?.[host.id] ?? host.defaultMode]}</> : '未授权远端操作'}</small></div>
    {conversation && <div className={panelStyles.agentActions}>
      <ActivityLabel task={conversation} />
      {conversation.session && !running && conversation.resumeReason && conversation.resumeReason !== 'report' && (!conversation.budget || conversation.budget.roundUsed < conversation.budget.roundLimit) && ['paused', 'failed', 'human-control', 'recovering'].includes(conversation.status)
        && <button onClick={() => void capture(() => window.cloudhelm.resumeConversation(conversation.id), report)}><Icon name="play" size={13} />继续 AI</button>}
    </div>}
    {conversation && <RequestBudgetCard key={`budget:${conversation.id}`} task={conversation} execution={snapshot.execution?.[conversation.id]} report={report} />}
    {conversation?.status === 'paused' && conversation.resumeReason === 'verify' && host
      && snapshot.operations.some((item) => item.taskId === conversation.id && item.hostId === host.id && item.reconciliation?.kind === 'risk-accepted')
      && !snapshot.operations.some((item) => item.hostId === host.id && operationNeedsVerification(item))
      && <div className={styles.agentActivity} role="status">风险已接管，但 AI 不会自动运行；点击上方「继续 AI」或发送消息。原命令不会自动重放。</div>}
    {conversation?.summary && ['paused', 'recovering'].includes(conversation.status)
      && <div className={styles.agentActivity} role="alert">{presentError(conversation.summary).description}</div>}
    <div className={panelStyles.scrollStage}>
    <div className={panelStyles.agentScroll} ref={scroll}
      onWheel={(event) => { if (event.deltaY < 0) scrollPinned.current = false; }}
      onTouchMove={() => { scrollPinned.current = false; }}
      onPointerMove={(event) => { if (event.buttons === 1) scrollPinned.current = false; }}
      onKeyDown={(event) => { if (['PageUp', 'Home', 'ArrowUp'].includes(event.key)) scrollPinned.current = false; }}
      onScroll={(event) => { const element = event.currentTarget; const atBottom = element.scrollHeight - element.clientHeight - element.scrollTop < 48;
        scrollPinned.current = atBottom; setAwayFromLatest(!atBottom); }}>
      {!conversation && <div className={panelStyles.agentWelcome}><span className={panelStyles.welcomeIcon}><Icon name="sparkles" size={23} /></span>
        <small>CLOUDHELM ASSISTANT</small><h2>{host ? '这台服务器，需要做些什么？' : '有什么想聊的？'}</h2>
        <p>{host ? '用自然语言告诉我目标。我会调查、执行并验证结果，需要你决定时会在这里说明。' : '可以直接提问。连接左侧主机后，也可以让我协助操作服务器。'}</p>
        <div className={panelStyles.suggestions}><span>从一个想法开始</span>{(host ? ['检查这台服务器的磁盘占用', '帮我把这个服务装成 Docker 并启动'] : ['帮我梳理一个服务的部署步骤', '解释一下 SSH 密钥和密码登录的区别']).map((text) =>
          <button type="button" key={text} className={panelStyles.suggestion} onClick={() => useMessageDrafts.getState().set(`draft:${host?.id ?? 'chat'}`, { parts: [{ type: 'text', text }], caret: text.length })}><Icon name={host ? 'terminal' : 'chat'} size={14} />{text}<Icon name="chevron" size={11} /></button>)}</div>
      </div>}
      {conversation && <AgentActivity key={`activity:${conversation.id}`} snapshot={snapshot} conversation={conversation} report={report} />}
      {conversation && <ConversationQueue key={`queue:${conversation.id}`} inputs={(snapshot.queuedInputs ?? []).filter((input) => input.taskId === conversation.id)} report={report} />}
      {conversation && <ConversationTranscript snapshot={snapshot} conversation={conversation} report={report} />}
      {host && <RecoveryCard snapshot={snapshot} hostId={host.id} conversation={conversation} report={report} />}
      {reasoning && <article className={panelStyles.message} key={reasoning.id}><AssistantIdentity /><ReasoningContent value={reasoning.reasoning} startedAt={reasoning.createdAt} now={now} /></article>}
      {approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} host={hostName(approval.hostId)} report={report} />)}
      {inputs.filter((input) => input.kind !== 'secret' && input.kind !== 'otp').map((input) => <InputCard key={input.id} input={input} host={hostName(input.hostId)} report={report} />)}
      {inputs.filter((input) => (input.kind === 'secret' || input.kind === 'otp') && hiddenInputs.includes(input.id)).map((input) => <button className={styles.pendingInput} key={input.id} onClick={() => openInput(input.id)}><Icon name="shield" />{input.title} · 填写</button>)}
      {terminal && <button className={styles.agentTerminalLink} onClick={() => useUi.getState().openTerminal(terminal.id)}><Icon name="terminal" />打开 AI 专用终端<Icon name="chevron" size={12} /></button>}
      {conversation?.status === 'failed' && <VerificationCard conversation={conversation} report={report} compact />}
      {activity && <div className={panelStyles.agentActivity} role="status">{running && <span className={panelStyles.activityPulse} aria-hidden="true" />}<span>{activity}</span></div>}
    </div>
    {awayFromLatest && <button type="button" className={panelStyles.jumpToLatest} onClick={() => {
      scrollPinned.current = true; setAwayFromLatest(false);
      if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    }}><Icon name="arrow" size={12} />回到最新</button>}
    </div>
    <Composer key={`composer:${conversation?.id ?? `draft:${host?.id ?? 'chat'}`}`} operations={operations} execution={conversation ? snapshot.execution?.[conversation.id] : undefined} hostId={host?.id ?? null} conversation={conversation} host={host} compaction={conversation ? snapshot.contextCompaction?.[conversation.id] : undefined} usage={conversation ? snapshot.contextUsage?.[conversation.id] : undefined} profile={snapshot.profile} models={models} report={report} />
  </section>;
}

function Composer({ execution, operations, hostId, host, usage, compaction, conversation, profile, models, report }: {
  operations: AppSnapshot['operations']; execution?: import('@cloudhelm/contracts').ExecutionView; hostId: string | null; host?: HostView; compaction?: 'running' | 'complete' | 'failed'; usage?: import('@cloudhelm/contracts').ContextUsageView; conversation?: TaskView; profile: AppSnapshot['profile']; models: ModelOption[]; report(error: string): void;
}): React.JSX.Element {
  const draftKey = conversation?.id ?? `draft:${hostId ?? 'chat'}`;
  const draftState = useMessageDrafts((state) => state.drafts[draftKey]);
  const parts = draftState?.parts;
  const locked = !!draftState?.locked;
  const hasContent = !!parts?.some((part) => part.type === 'reference' || part.text.trim());
  const request = useRef<{ id: string; revision: string } | undefined>(draftFor(draftKey).request);
  const [preparing, setPreparing] = useState(false);
  const [compressing, setCompressing] = useState(false);
  const sendLock = useRef(false);
  const [attachments, setAttachments] = useState<LocalAttachment[]>(() => composerDrafts.get(draftKey)?.attachments ?? []);
  const [queueMode, setQueueMode] = useState<'steer' | 'followUp'>(() => composerDrafts.get(draftKey)?.queueMode ?? 'steer');
  const queuing = execution?.model === 'running';
  const attachmentMenu = useMenuAnchor();
  const [stopPending, setStopPending] = useState(false);
  const stopLock = useRef(false);
  const canStop = execution?.canStop ?? (!!conversation && ['running', 'waiting-review', 'waiting-user'].includes(conversation.status));
  const stopping = stopPending || execution?.stopping;
  async function stop(): Promise<void> {
    if (!conversation || stopLock.current || stopping) return;
    stopLock.current = true; setStopPending(true);
    try { await capture(() => window.cloudhelm.stopOperation(conversation.id), report); }
    finally { stopLock.current = false; setStopPending(false); }
  }
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [model, setModel] = useState<ModelChoice>({ provider: conversation?.provider ?? profile.provider, modelId: conversation?.modelId ?? profile.modelId });
  const [draftThinking, setDraftThinking] = useState<import('@cloudhelm/contracts').ThinkingLevel>();
  const levels = models.find((item) => item.provider === model.provider && item.modelId === model.modelId)?.thinkingLevels ?? [];
  const draftLevel = draftThinking && levels.includes(draftThinking) ? draftThinking : levels[0] ?? 'off';
  const thinking = conversation?.thinking ?? (!conversation ? { levels, selected: draftLevel, effective: draftLevel, pending: false } : undefined);
  const currentRequest = useUi((state) => conversation ? state.currentRequests[conversation.id] : undefined);
  const waiting = conversation?.status === 'waiting-user';
  const legacy = !!conversation && (!conversation.session || conversation.hostIds.length > 1);
  const pendingModel = conversation?.status === 'running' && currentRequest && (currentRequest.model.provider !== model.provider || currentRequest.model.modelId !== model.modelId);
  useEffect(() => { composerDrafts.set(draftKey, { attachments, queueMode }); }, [draftKey, attachments, queueMode]);
  useEffect(() => { if (!conversation) setModel({ provider: profile.provider, modelId: profile.modelId }); }, [conversation, profile.provider, profile.modelId]);
  async function attach(kind: LocalScope['kind']): Promise<void> {
    attachmentMenu.close();
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
    if (!hasContent || locked || sendLock.current || busy || switching || legacy || waiting || stopping) return;
    sendLock.current = true; setBusy(true); setPreparing(true); setCompressing(false);
    const parts = draftFor(draftKey).parts;
    const deliveryMode = queuing ? queueMode : undefined;
    const revision = JSON.stringify([parts, model, draftLevel, attachments, deliveryMode]);
    if (request.current?.revision !== revision) request.current = { id: crypto.randomUUID(), revision };
    useMessageDrafts.getState().set(draftKey, { locked: true, request: request.current, compressing: false, compressingReference: undefined, preparationContext: undefined });
    try {
      const result = await window.cloudhelm.sendStructured({ document: { requestId: request.current!.id, parts },
        conversationId: conversation?.id, hostId, model, thinkingLevel: levels.length ? draftLevel : undefined,
        localSelectionTokens: attachments.map((item) => item.token), queueMode: deliveryMode });
      useMessageDrafts.getState().clear(draftKey); composerDrafts.delete(draftKey); setAttachments([]); request.current = undefined;
      const current = useUi.getState();
      if ((current.selectedConversationId ?? `draft:${current.activeHostId ?? 'chat'}`) === draftKey) {
        current.setSnapshot(await window.cloudhelm.snapshot());
        if (!conversation) useUi.getState().selectConversation(result.conversationId);
      }
    } catch (cause) { report(cause instanceof Error ? cause.message : String(cause)); }
    finally { sendLock.current = false; setBusy(false); setPreparing(false); setCompressing(false); useMessageDrafts.getState().set(draftKey, { locked: false, compressing: false, compressingReference: undefined, preparationContext: undefined }); }
  }
  function attachmentMenuEntries(item: LocalAttachment): ContextMenuEntry[] {
    return [
      { id: 'copy-path', label: '复制完整路径', icon: 'copy', run: () => void copyText(item.scope.path) },
      { id: 'd1', separator: true },
      { id: 'remove', label: '移除附件', icon: 'close', danger: true,
        run: () => setAttachments((items) => items.filter((attachment) => attachment.token !== item.token)) }
    ];
  }
  return <div className={composerStyles.composerWrap}>
    {legacy && <p className={styles.notice}>此旧对话仅供查看，无法恢复模型上下文。请开始新对话。</p>}
    <form className={composerStyles.composer} onSubmit={(event) => { event.preventDefault(); void send(); }}>
      {conversation && canStop && <AgentPlan key={conversation.id} steps={conversation.plan ?? []} operations={operations} />}
      {!!attachments.length && <div className={composerStyles.attachments}>{attachments.map((item) => <span key={item.token}
        onContextMenu={(event) => openContextMenu(event, attachmentMenuEntries(item), '附件操作')}>
        <Icon name={item.scope.kind === 'directory' ? 'folder' : 'file'} size={12} />{item.scope.path.split(/[\\/]/u).at(-1)}<button type="button" aria-label={`移除 ${item.scope.path}`} onClick={() => setAttachments((items) => items.filter((attachment) => attachment.token !== item.token))}><Icon name="close" size={11} /></button></span>)}</div>}
      {queuing && <label className={workspaceStyles.mode}>消息投递方式<select aria-label="消息投递方式" value={queueMode} disabled={busy || locked || legacy || waiting || !!stopping}
        onChange={(event) => setQueueMode(event.target.value === 'followUp' ? 'followUp' : 'steer')}>
        <option value="steer">当前调整（安全边界投递）</option><option value="followUp">后续排队（当前轮结束后）</option></select></label>}
      <MessageEditor draftKey={draftKey} disabled={legacy || waiting || busy || locked} placeholder={waiting ? '请先回答上方问题，或停止本轮对话' : hostId ? '描述你的目标，或补充下一步…' : '问点什么…'} send={() => void send()} />
      {(preparing || locked) && <p className={styles.note} role="status">{(compressing || draftState?.compressing) ? '正在压缩超出上下文容量的内容…' : '正在准备发送…'} {draftState?.summaryRequests && `摘要请求 ${draftState.summaryRequests.used}/${draftState.summaryRequests.limit} `}<button type="button" onClick={() => { const id = draftFor(draftKey).request?.id; if (id) void capture(() => window.cloudhelm.cancelMessage(id), report); }}>取消发送</button></p>}
      <div className={composerStyles.composerTools}>
        <div className={composerStyles.attachControl}>
          <button type="button" aria-label="添加本地资料" title="添加本地资料" disabled={legacy || waiting || busy || locked}
            aria-haspopup="menu" aria-expanded={!!attachmentMenu.anchor} {...attachmentMenu.trigger}><Icon name="plus" size={18} /></button>
          {attachmentMenu.anchor && <MenuSurface anchor={attachmentMenu.anchor} positionAnchor={attachmentMenu.anchor.closest('form')}
            label="添加本地资料" placement="above" align="start" close={attachmentMenu.close}>
            <MenuItem label="选择文件" icon="file" onSelect={() => void attach('file')} />
            <MenuItem label="选择目录" icon="folder" onSelect={() => void attach('directory')} />
          </MenuSurface>}
        </div>
        <PermissionPicker host={host} conversation={conversation} legacy={legacy} report={report} />
        <div className={composerStyles.modelControls}>
        {models.length ? <ModelPicker models={models} selected={model} disabled={switching || legacy || busy || locked} conversation={!!conversation} choose={chooseModel} />
          : <button type="button" className={composerStyles.configureModel} onClick={() => useUi.getState().setSettingsOpen(true)}>配置模型</button>}
        <ThinkingPicker value={thinking} disabled={switching || legacy || busy || locked} report={report} choose={async (level) => {
          if (conversation) await window.cloudhelm.setConversationThinking(conversation.id, level);
          else setDraftThinking(level);
        }} />
        </div>
        {canStop || stopping ? <button type="button" className={composerStyles.sendButton} aria-label={stopping ? '正在停止' : '停止执行'} title="停止本会话 AI，并请求停止全部执行中的命令（含后台）；Enter 仅发送补充消息" disabled={!!stopping} onClick={() => void stop()}><Icon name="stop" size={16} /></button> : <button type="submit" className={composerStyles.sendButton} aria-label="发送消息" title="Enter 发送 · Shift + Enter 换行" disabled={!hasContent || locked || busy || switching || !models.length || legacy || waiting}><Icon name="arrow" size={16} /></button>}
      </div>
    </form>
    {execution && <p className={styles.note} role="status">{stopping ? `正在停止…${execution.model === 'idle' ? '模型已停；' : ''}${execution.remote === 'running' ? '等待远端命令退出' : ''}` : execution.remote === 'unknown' ? `${execution.model === 'idle' ? '模型已停；' : ''}远端结果待核验，请勿重复执行` : canStop ? 'Enter 发送补充消息 · 点击 ■ 停止执行' : ''}</p>}
    <ComposerFooter compaction={compaction} usage={locked ? draftState?.preparationContext ?? usage : usage} pendingModel={pendingModel ? model.modelId : undefined} />
  </div>;
}
