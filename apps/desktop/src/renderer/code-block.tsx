import { Children, isValidElement, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { copyEntries } from './clipboard.js';
import { highlightCode } from './code-highlight.js';
import { openContextMenu } from './context-menu.js';
import styles from './code-block.module.css';

/**
 * Fenced code with a language label, syntax highlighting, wrap and expand
 * toggles and exact-text copy. Highlighting never rewrites, truncates or
 * executes the content; unknown languages fall back to plain text.
 */
export function CodeBlock({ children }: { children?: ReactNode }): React.JSX.Element {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [wrap, setWrap] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  const child = Children.toArray(children).find(isValidElement);
  const code = child?.props as { className?: string; children?: ReactNode } | undefined;
  const language = /language-([^\s]+)/u.exec(code?.className ?? '')?.[1] ?? '';
  const text = Children.toArray(code?.children).filter((part) => typeof part === 'string' || typeof part === 'number').join('');
  const highlighted = useMemo(() => highlightCode(language, text), [language, text]);
  useEffect(() => {
    const element = pre.current;
    if (!element || expanded) return;
    setOverflows(element.scrollHeight > element.clientHeight + 1);
  }, [text, expanded, wrap, highlighted]);
  async function copy(): Promise<void> {
    try { await navigator.clipboard.writeText(text); setCopied('copied'); }
    catch { setCopied('failed'); }
  }
  return <div className={styles.codeBlock} onContextMenu={(event) => openContextMenu(event, copyEntries('复制代码', text), '代码操作')}>
    <div className={styles.codeHeader}><span>{language || '代码'}</span>
      <div className={styles.codeHeaderActions}>
        <button type="button" aria-label="切换换行" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>换行</button>
        {overflows && <button type="button" aria-label={expanded ? '收起代码' : '展开代码'} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : '展开'}</button>}
        <button type="button" aria-label="复制代码" onClick={() => void copy()}>
          {copied === 'copied' ? '已复制' : copied === 'failed' ? '复制失败，点击重试' : '复制'}</button>
      </div></div>
    <pre ref={pre} className={styles.codePre} data-expanded={expanded} data-wrapped={wrap}>
      <code className={styles.codeInline}>{highlighted ?? text}</code></pre>
    <span className={styles.copyStatus} role="status">{copied === 'copied' ? '代码已复制到剪贴板，不会执行。' : copied === 'failed' ? '无法访问剪贴板，请重试或手动选择代码。' : ''}</span>
  </div>;
}
