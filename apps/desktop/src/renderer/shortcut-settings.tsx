import { useEffect, useMemo, useState } from 'react';
import {
  BINDABLE_ACTIONS, SHORTCUT_ACTIONS, SHORTCUT_GROUPS, UNSET_LABEL,
  bindingConflict, bindingFromEvent, bindingLabel, isMacPlatform, type ShortcutActionId, type ShortcutGroup
} from './shortcuts.js';
import { useShortcuts } from './shortcut-store.js';
import styles from './model-settings.module.css';

const scopeLabel: Record<'global' | 'terminal' | 'fixed', string> = { global: '全局', terminal: '仅终端', fixed: '输入框' };

/**
 * Shortcut preferences: group navigation on the left, action rows on the right.
 * Every change persists immediately through the main process settings store.
 */
export function ShortcutSettings({ report }: { report(value: string): void }): React.JSX.Element {
  const bindings = useShortcuts((state) => state.bindings);
  const enabled = useShortcuts((state) => state.enabled);
  const isMac = isMacPlatform();
  const [group, setGroup] = useState<ShortcutGroup>('workspace');
  const [search, setSearch] = useState('');
  const [recording, setRecording] = useState<ShortcutActionId | null>(null);
  const [recordError, setRecordError] = useState('');

  const query = search.trim().toLowerCase();
  const visible = useMemo(() => query
    ? SHORTCUT_ACTIONS.filter((action) => `${action.label} ${action.id}`.toLowerCase().includes(query))
    : SHORTCUT_ACTIONS.filter((action) => action.group === group), [query, group]);

  async function persist(action: () => Promise<void>): Promise<void> {
    try { await action(); report(''); }
    catch (error) { report(error instanceof Error ? error.message : String(error)); }
  }

  // Recording captures the next combination; the dispatcher stays quiet meanwhile.
  useEffect(() => {
    if (!recording) return;
    useShortcuts.getState().setRecording(true);
    return () => useShortcuts.getState().setRecording(false);
  }, [recording]);

  useEffect(() => {
    if (!recording) return;
    const actionId: ShortcutActionId = recording;
    function onKeyDown(event: KeyboardEvent): void {
      event.preventDefault();
      event.stopPropagation();
      const store = useShortcuts.getState();
      if (event.key === 'Escape') { setRecording(null); setRecordError(''); return; }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        setRecording(null); setRecordError('');
        void persist(() => store.setBinding(actionId, undefined));
        return;
      }
      const captured = bindingFromEvent(event);
      if (!captured) return;
      const conflict = bindingConflict(store.bindings, actionId, captured, isMac);
      if (conflict) {
        setRecordError(conflict.kind === 'reserved' ? '这是编辑或终端保留键位（例如 Ctrl+C），请换一个组合。' : `已被“${conflict.label}”占用，请换一个组合。`);
        return;
      }
      setRecording(null); setRecordError('');
      void persist(() => store.setBinding(actionId, captured));
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [recording]);

  function bindingCell(actionId: ShortcutActionId, fixed: boolean): React.JSX.Element {
    const label = bindingLabel(actionId, bindings, isMac);
    if (recording === actionId) return <span className={styles.recordHint}>请按下新的快捷键…（Esc 取消 · Backspace 清除）</span>;
    return <span className={styles.shortcutBinding}>{label
      ? <kbd>{label}</kbd>
      : <span className={styles.unset}>{fixed ? '系统处理' : UNSET_LABEL}</span>}</span>;
  }

  return <div className={styles.apiLayout} role="tabpanel" id="model-panel-shortcuts" aria-labelledby="model-tab-shortcuts">
    <aside className={styles.providers} aria-label="快捷键分组">
      <h2>分组</h2>
      <div className={styles.providerList}>{SHORTCUT_GROUPS.map((item) =>
        <button type="button" key={item.id} className={styles.provider} aria-pressed={!query && item.id === group}
          onClick={() => { setGroup(item.id); setSearch(''); setRecordError(''); }}>
          <span className={styles.providerName}>{item.label}</span>
          <small className={styles.groupCount}>{SHORTCUT_ACTIONS.filter((action) => action.group === item.id).length}</small>
        </button>)}
      </div>
      <p className={styles.catalogHint}>菜单中会显示当前生效的键位。</p>
    </aside>

    <div className={styles.detail}>
      <div className={styles.modelHeader}>
        <div><h2>快捷键</h2><p>{query ? `“${search.trim()}” 的搜索结果（${visible.length}）` : SHORTCUT_GROUPS.find((item) => item.id === group)?.description}</p></div>
        <div className={styles.shortcutToolbar}>
          <label className={styles.search}><input type="search" value={search} aria-label="搜索快捷键动作"
            placeholder="搜索动作…" onChange={(event) => setSearch(event.target.value)} /></label>
          <label className={styles.checkbox}><input type="checkbox" checked={enabled}
            onChange={(event) => void persist(() => useShortcuts.getState().setEnabled(event.target.checked))} />启用快捷键</label>
        </div>
      </div>
      <div className={styles.shortcutList}>
        {visible.map((action) => {
          const fixed = action.scope === 'fixed';
          return <div className={styles.shortcutRow} key={action.id}>
            <span className={styles.shortcutName}>{action.label}</span>
            <small className={styles.shortcutScope}>{scopeLabel[action.scope]}</small>
            {bindingCell(action.id, fixed)}
            <span className={styles.shortcutActions}>
              {recording === action.id ? <button type="button" className={styles.button}
                onClick={() => { setRecording(null); setRecordError(''); }}>取消</button>
                : !fixed && <>
                  <button type="button" className={styles.button} onClick={() => { setRecording(action.id); setRecordError(''); }}>更改</button>
                  <button type="button" className={styles.button} onClick={() => void persist(() => useShortcuts.getState().setBinding(action.id, undefined))}>清除</button>
                  <button type="button" className={styles.button} onClick={() => void persist(() => useShortcuts.getState().resetBinding(action.id))}>重置</button>
                </>}
            </span>
          </div>;
        })}
        {!visible.length && <p className={styles.empty}>没有匹配的动作。</p>}
      </div>
      {recordError && <p className={styles.shortcutError} role="alert">{recordError}</p>}
      <div className={styles.shortcutResetRow}>
        <button type="button" className={styles.button} disabled={!!query || group === 'editing'}
          onClick={() => { for (const action of BINDABLE_ACTIONS.filter((item) => item.group === group)) {
            void persist(() => useShortcuts.getState().resetBinding(action.id));
          } }}>恢复本组默认</button>
        <button type="button" className={styles.button} onClick={() => void persist(() => useShortcuts.getState().resetAll())}>恢复全部默认</button>
      </div>
      <div className={styles.reviewExplanation}><h3>使用说明</h3>
        <p>输入框内的复制、粘贴、撤销等编辑键位由系统处理，不参与自定义；终端内只响应“仅终端”动作，避免抢占 shell 按键，Ctrl+C 继续用于中断命令或停止 AI。</p>
        <p>点击“更改”后按下新的组合键即可绑定；Backspace 清除绑定，Esc 取消。同一组合只能绑定一个动作。</p></div>
    </div>
  </div>;
}
