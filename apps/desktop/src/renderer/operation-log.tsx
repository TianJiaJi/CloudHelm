import { useCallback, useEffect, useRef, useState } from 'react';
import type { OperationLogPage } from '@cloudhelm/contracts';
import styles from './execution-workspace.module.css';

export function appendLogPage(previous: string, cursor: number, page: OperationLogPage): { text: string; cursor: number; clipped: boolean } {
  if (typeof page.text !== 'string' || typeof page.more !== 'boolean' || !Number.isSafeInteger(page.nextCursor)
    || page.nextCursor < cursor || (page.text.length > 0 || page.more) && page.nextCursor === cursor
    || new TextEncoder().encode(page.text).length > 48 * 1024) throw new Error('操作日志分页无效；未跳过内容，也不会重放命令');
  const joined = previous + page.text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, '');
  let start = Math.max(0, joined.length - 32768);
  if (start && joined.charCodeAt(start) >= 0xdc00 && joined.charCodeAt(start) <= 0xdfff) start++;
  return { text: joined.slice(start), cursor: page.nextCursor, clipped: start > 0 };
}

export function OperationLog({ taskId, operationId, live, report }: {
  taskId: string; operationId: string; live: boolean; report(error: string): void;
}): React.JSX.Element {
  const [text, setText] = useState(''), [more, setMore] = useState(false), [busy, setBusy] = useState(false);
  const [clipped, setClipped] = useState(false), [error, setError] = useState('');
  const state = useRef({ generation: 0, cursor: 0, text: '', busy: false, failed: false });
  const load = useCallback(async (notify = true) => {
    const current = state.current; if (current.busy) return;
    current.busy = true; current.failed = false; setBusy(true); setError('');
    try {
      if (!window.cloudhelm.readOperationLog) throw new Error('当前版本不提供按操作分页的日志');
      const page = await window.cloudhelm.readOperationLog(taskId, operationId, current.cursor);
      if (state.current !== current) return;
      const next = appendLogPage(current.text, current.cursor, page);
      current.cursor = next.cursor; current.text = next.text;
      setText(next.text); setMore(page.more); if (next.clipped) setClipped(true);
    } catch (cause) {
      if (state.current !== current) return;
      current.failed = true;
      const message = cause instanceof Error ? cause.message : String(cause); setError(message); if (notify) report(message);
    } finally { if (state.current === current) { current.busy = false; setBusy(false); } }
  }, [taskId, operationId, report]);
  useEffect(() => {
    state.current = { generation: state.current.generation + 1, cursor: 0, text: '', busy: false, failed: false };
    setText(''); setClipped(false); setMore(false); void load();
    return () => { state.current = { ...state.current, generation: state.current.generation + 1 }; };
  }, [load]);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => { if (document.visibilityState === 'visible' && !state.current.failed) void load(false); }, 2000);
    return () => clearInterval(timer);
  }, [live, load]);
  return <section className={styles.panel} aria-label="操作增量日志">
    <p className={styles.note}>仅此操作的留存日志；{live ? '可见时每 2 秒读取增量。' : '可手动读取后续留存内容。'}日志结尾不证明完整捕获或进程退出。</p>
    {clipped && <p role="status">显示已裁剪为最近 32768 字符；早期内容未继续保留在此视图。</p>}
    {error && <p role="alert">{error}</p>}
    <pre className={styles.log} aria-live="off">{text || (busy ? '正在读取…' : '暂无留存输出；不代表命令没有输出。')}</pre>
    <button type="button" disabled={busy} onClick={() => void load()}>{busy ? '读取中…' : more ? '读取下一页' : '刷新留存日志'}</button>
  </section>;
}
