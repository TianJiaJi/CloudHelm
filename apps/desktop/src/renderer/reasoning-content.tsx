import { useEffect, useRef, useState } from 'react';
import type { ReasoningView } from '@cloudhelm/contracts';
import { MarkdownMessage } from './markdown-message.js';
import styles from './reasoning-content.module.css';

export function ReasoningContent({ value }: { value?: ReasoningView }): React.JSX.Element | null {
  const [open, setOpen] = useState(true);
  const body = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    if (open && follow.current && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [open, value?.text]);
  if (!value) return null;
  const label = value.kind === 'summary' ? '思考摘要' : '思考内容';
  const status = value.status === 'streaming' ? value.text ? '正在接收…' : '等待返回…'
    : value.status === 'interrupted' ? '已中断' : value.status === 'unavailable' ? '未返回' : '已完成';
  return <section className={styles.card} aria-label={label}>
    <button type="button" className={styles.toggle} aria-expanded={open} onClick={() => setOpen(!open)}
      title="仅展示模型接口返回的内容，可能是摘要；不代表完整内部思维链">
      <span className={styles.chevron} aria-hidden="true">{open ? '⌄' : '›'}</span><strong>{label}</strong><span className={styles.status}>{status}</span>
    </button>
    {open && <div className={styles.body} ref={body} onScroll={() => {
      const element = body.current;
      if (element) follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
    }}>
      {value.text ? <MarkdownMessage text={value.text} /> : <p className={styles.empty}>{value.status === 'streaming' ? '等待模型接口返回思考内容…'
        : value.status === 'interrupted' ? '响应已中断，没有收到可展示的思考内容。' : '此响应未返回可展示的思考内容。'}</p>}
      {value.redacted && <p className={styles.empty}>部分内容未由模型接口公开。</p>}
    </div>}
  </section>;
}
