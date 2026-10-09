import { useRef, useState } from 'react';
import type { ThinkingLevel, ThinkingView } from '@cloudhelm/contracts';
import { MenuSurface } from './menu-surface.js';
import { useMenuAnchor } from './composer-controls.js';
import { Icon, capture } from './ui-helpers.js';
import styles from './composer-controls.module.css';

const labels: Record<ThinkingLevel, string> = { off: '关闭', minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' };
export function ThinkingPicker({ value, disabled, choose, report }: {
  value?: ThinkingView; disabled: boolean; choose(level: ThinkingLevel): Promise<void>; report(error: string): void;
}): React.JSX.Element | null {
  const menu = useMenuAnchor();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  if (!value?.levels.length) return null;
  async function select(level: ThinkingLevel): Promise<void> {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try { await capture(() => choose(level), report); }
    finally { lock.current = false; setBusy(false); }
  }
  return <>
    <button type="button" className={styles.thinkingTrigger} aria-label={`思考强度，当前 ${labels[value.selected]}`}
      title={value.pending ? '下一次模型请求生效' : '模型支持的思考强度'} aria-haspopup="menu" aria-expanded={!!menu.anchor}
      disabled={disabled || busy} {...menu.trigger}><span>{labels[value.selected]}{value.pending ? ' · 下次' : ''}</span><Icon name="chevron" size={12} /></button>
    {menu.anchor && <MenuSurface anchor={menu.anchor} label="思考强度" placement="above" className={styles.picker} close={menu.close}>
      <div className={styles.menuIntro}>思考强度 · 运行中修改从下一次请求生效</div>
      {value.levels.map((level) => <button type="button" role="menuitem" key={level} aria-current={level === value.selected ? 'true' : undefined}
        onClick={() => void select(level)}>{labels[level]}{level === value.selected && <Icon name="check" size={15} />}</button>)}
    </MenuSurface>}
  </>;
}
