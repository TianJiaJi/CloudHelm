import { useState } from 'react';
import type { MessageDocument, MessagePart } from '@cloudhelm/contracts';
import { ReferencePreview } from './reference-preview.js';
import styles from './message-editor.module.css';

export function MessageContent({ document }: { document: MessageDocument }): React.JSX.Element {
  const [preview, setPreview] = useState<Extract<MessagePart, { type: 'reference' }>>();
  return <div className={styles.message}>{document.parts.map((part, index) => part.type === 'text' ? <span key={index}>{part.text}</span>
    : <button type="button" className={styles.chip} key={index} title={[part.reference.hostLabel, part.reference.command].filter(Boolean).join(' · ')} onClick={() => setPreview(part)}>
      {part.reference.kind === 'terminal' ? 'Terminal' : '粘贴文本'}{part.reference.summarized && <small>已压缩</small>}
    </button>)}{preview && <ReferencePreview part={preview} close={() => setPreview(undefined)} />}</div>;
}
