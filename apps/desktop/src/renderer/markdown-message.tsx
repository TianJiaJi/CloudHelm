import { createContext, useContext, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './code-block.js';
import styles from './markdown-message.module.css';

const InsideLink = createContext(false);

/** Model-provided links require an explicit HTTP(S) destination; no relative or executable URLs. */
export function safeMarkdownUrl(value: string): string {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }): React.JSX.Element {
  if (!href) return <span className={styles.disabledLink}>{children}</span>;
  return <InsideLink.Provider value={true}><a href={href} target="_blank" rel="noopener noreferrer">{children}</a></InsideLink.Provider>;
}

function DeferredImage({ src, alt }: { src?: string; alt?: string }): React.JSX.Element {
  const insideLink = useContext(InsideLink);
  const label = `查看图片：${alt || '图片'}`;
  // Linked images retain the surrounding link's explicit destination without nesting anchors.
  if (insideLink || !src) return <span className={styles.imageLink}>{label}{!src ? '（地址不可用）' : ''}</span>;
  return <a className={styles.imageLink} href={src} target="_blank" rel="noopener noreferrer">{label}</a>;
}

export function MarkdownMessage({ text }: { text: string }): React.JSX.Element {
  return <div className={styles.markdown}>
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safeMarkdownUrl} components={{
      a: MarkdownLink,
      img: DeferredImage,
      pre: CodeBlock,
      code: ({ children, className }) => <code className={`${styles.inlineCode} ${className ?? ''}`}>{children}</code>,
      table: ({ children }) => <div className={styles.tableScroll}><table>{children}</table></div>
    }}>{text}</ReactMarkdown>
  </div>;
}
