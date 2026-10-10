import { useRef, useState } from 'react';
import type { ContextUsageView, HostView, ModelChoice, ReviewMode, TaskView } from '@cloudhelm/contracts';
import { MenuSurface } from './menu-surface.js';
import { capture, Icon, reviewLabel } from './ui-helpers.js';
import styles from './composer-controls.module.css';

type ModelOption = ModelChoice & { name: string };
export function useMenuAnchor() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  return { anchor, close: () => setAnchor(null), trigger: {
    onPointerDown: () => { wasOpen.current = anchor !== null; },
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
      setAnchor(wasOpen.current ? null : event.currentTarget); wasOpen.current = false;
    }
  } };
}

export function ModelPicker({ models, selected, disabled, conversation, choose }: {
  models: ModelOption[]; selected: ModelChoice; disabled: boolean; conversation: boolean; choose(value: string): Promise<void>;
}): React.JSX.Element {
  const menu = useMenuAnchor();
  const [search, setSearch] = useState('');
  const key = `${selected.provider}/${selected.modelId}`;
  const option = models.find((item) => `${item.provider}/${item.modelId}` === key);
  const label = option?.name ?? selected.modelId;
  const filtered = models.filter((item) => `${item.name} ${item.provider} ${item.modelId}`.toLowerCase().includes(search.trim().toLowerCase()));
  const providers = [...new Set(filtered.map((item) => item.provider))];
  return <>
    <button type="button" className={styles.modelTrigger} aria-label={`对话模型，当前 ${label}`} title={`${label} · ${selected.provider}`}
      aria-haspopup="menu" aria-expanded={!!menu.anchor} disabled={disabled} {...menu.trigger}>
      <span>{label}</span><Icon name="chevron" size={12} />
    </button>
    {menu.anchor && <MenuSurface anchor={menu.anchor} label="对话模型" placement="above" align="start" searchFocus className={styles.picker}
      close={() => { menu.close(); setSearch(''); }}>
      <div className={styles.search}><input type="search" aria-label="搜索模型" placeholder="搜索模型或供应商…" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
      <div className={styles.modelList}>
        {!option && <p className={styles.empty}>当前模型 {selected.modelId} 不在可用列表中</p>}
        {providers.map((provider) => <section key={provider} aria-label={provider}>
          <div className={styles.groupLabel}>{provider}</div>
          {filtered.filter((item) => item.provider === provider).map((item) => {
            const value = `${item.provider}/${item.modelId}`;
            return <button key={value} type="button" role="menuitem" aria-current={key === value ? 'true' : undefined}
              title={`${item.name} · ${item.provider} / ${item.modelId}`} onClick={() => void choose(value)}>
              <span className={styles.modelText}><strong>{item.name}</strong><small>{item.provider} · {item.modelId}</small></span>
              {key === value && <Icon name="check" size={15} />}
            </button>;
          })}
        </section>)}
        {!filtered.length && <p className={styles.empty}>没有匹配的模型</p>}
      </div>
      {conversation && <div className={styles.menuFoot}><button type="button" role="menuitem" onClick={() => void choose('__reapply__')}>重新应用当前模型的 Key 和地址</button></div>}
    </MenuSurface>}
  </>;
}

const descriptions: Record<ReviewMode, string> = {
  ask: '普通读写自动执行；高影响或无法确认影响时询问。',
  'ai-review': '不确定操作由独立模型审核；高影响操作询问。',
  permissive: '自动执行不透明脚本；硬禁令和保护路径仍生效。'
};

export function ComposerFooter({ host, conversation, legacy, usage, compaction, pendingModel, report }: {
  compaction?: 'running' | 'complete' | 'failed'; host?: HostView; conversation?: TaskView; legacy: boolean; usage?: ContextUsageView; pendingModel?: string; report(error: string): void;
}): React.JSX.Element {
  const permissions = useMenuAnchor();
  const context = useMenuAnchor();
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const known = usage?.usedTokens != null && usage.contextWindow != null && usage.contextWindow > 0;
  const remaining = known ? Math.max(0, Math.min(100, Math.round(100 * (1 - usage.usedTokens! / usage.contextWindow!)))) : null;
  const usageLabel = compaction === 'running' ? '正在整理上下文…' : remaining === null ? '上下文待统计' : `${usage?.source === 'estimate' ? '约剩余' : '剩余'} ${remaining}%`;
  const details = known ? `已用 ${usage.usedTokens!.toLocaleString()} / ${usage.contextWindow!.toLocaleString()} tokens\n${usage.source === 'provider' ? '模型返回的用量' : 'Pi SDK 估算（包含可用的模型统计）'}\n更新于 ${new Date(usage.updatedAt).toLocaleTimeString()}` : '发送消息后统计上下文用量';
  const selectedMode = host ? conversation?.reviewModesByHost?.[host.id] ?? host.defaultMode : undefined;
  async function choose(mode: ReviewMode): Promise<void> {
    if (!host || !conversation || savingRef.current || mode === selectedMode) return;
    savingRef.current = true; setSaving(true);
    try { await capture(() => window.cloudhelm.updateConversationReviewMode(conversation.id, host.id, mode), report); }
    finally { savingRef.current = false; setSaving(false); }
  }
  return <>
    <div className={styles.footer}>
      <button type="button" className={`${styles.permissionTrigger} ${selectedMode === 'permissive' ? styles.permissive : ''}`} aria-label={selectedMode ? `权限选择，当前 ${reviewLabel[selectedMode]}` : '未授权远端操作'}
        aria-haspopup="menu" aria-expanded={!!permissions.anchor} disabled={!host || !conversation || legacy || host.archived || saving}
        title={conversation ? '仅应用于当前对话的当前主机' : '新对话将继承主机默认档位'} {...permissions.trigger}>
        <Icon name="shield" size={13} /><span>{saving ? '更新中…' : selectedMode ? reviewLabel[selectedMode] : '未授权远端操作'}</span>
        {host && <Icon name="chevron" size={11} />}
      </button>
      <button type="button" className={styles.contextTrigger} aria-label={`上下文用量，${usageLabel}`} aria-haspopup="menu" aria-expanded={!!context.anchor}
        title={details} {...context.trigger}>
        <svg width="15" height="15" viewBox="0 0 20 20" aria-hidden="true" className={styles.ring}>
          <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="2" opacity=".2" />
          {remaining !== null && <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="2" pathLength="100"
            strokeDasharray={`${remaining} 100`} transform="rotate(-90 10 10)" />}
        </svg><span>{usageLabel}</span>
      </button>
    </div>
    {pendingModel && <p className={styles.pending}>下一次请求使用 {pendingModel}</p>}
    {permissions.anchor && host && conversation && <MenuSurface anchor={permissions.anchor} label="权限选择" placement="above" align="start" className={styles.picker} close={permissions.close}>
      <div className={styles.menuIntro}>仅当前对话 · {host.label}</div>
      {(Object.keys(descriptions) as ReviewMode[]).map((mode) => <button type="button" key={mode} role="menuitem"
        className={mode === 'permissive' ? styles.permissive : undefined}
        aria-current={selectedMode === mode ? 'true' : undefined} onClick={() => void choose(mode)}>
        <span className={styles.permissionText}><strong>{reviewLabel[mode]}</strong><small>{descriptions[mode]}</small></span>
        {selectedMode === mode && <Icon name="check" size={15} />}
      </button>)}
    </MenuSurface>}
    {context.anchor && <MenuSurface anchor={context.anchor} label="上下文用量" placement="above" className={styles.picker} close={context.close}>
      <div className={styles.contextDetails}><strong>上下文窗口</strong><p>{details}</p>
        {usage && <small>{usage.model.modelId} · 请求 #{usage.request}</small>}
        <small>当前上下文占用，不包含未发送草稿。自动整理上下文后，用量可能下降。</small>
      </div>
    </MenuSurface>}
  </>;
}
