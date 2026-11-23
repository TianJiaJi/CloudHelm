import { useEffect, useState } from 'react';
import type { DebugReplayAction, DebugReplayView } from '@cloudhelm/contracts';
import { Button } from './ui/index.js';

export function DebugReplaySettings({ report }: { report(error: string): void }): React.JSX.Element {
  const [view, setView] = useState<DebugReplayView>();
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  useEffect(() => {
    let active = true;
    void window.cloudhelm.debugReplay('status').then((value) => { if (active) setView(value); },
      (error: unknown) => { if (active) report(String(error)); });
    return () => { active = false; };
  }, [report]);
  const act = async (action: DebugReplayAction) => {
    setBusy(true);
    try { setView(await window.cloudhelm.debugReplay(action)); }
    catch (error) { report(String(error)); }
    finally { setBusy(false); }
  };
  const text = view?.text;
  const query = filter.trim();
  const shown = query && text ? text.split('\n').filter((line) => {
    try { const row = JSON.parse(line); return row?.taskId === query || row?.operationId === query || row?.toolCallId === query || row?.requestId === query; }
    catch { return false; }
  }).join('\n') : text;
  return <section aria-label="调试与离线回放">
    <h3>调试与离线回放</h3>
    <p>默认关闭，重启后不会自动开启。开启后，可见聊天正文和操作记录会写入本地文件，不上传。请不要在聊天中粘贴秘密。</p>
    {view && <><p>文件：<code>{view.file}</code></p>
      <p role="status">{view.enabled ? '正在记录' : '未在记录'}{view.error && ` · ${view.error}`}</p>
      <Button disabled={busy} onClick={() => void act(view.enabled ? 'disable' : 'enable')}>{view.enabled ? '关闭详细记录' : '开启详细记录'}</Button>
      <Button disabled={busy} onClick={() => void act('read')}>读取本地回放</Button>
      <Button disabled={busy} onClick={() => {
        if (window.confirm('停止记录并删除本地详细日志？此操作不会删除会话历史。')) void act('clear');
      }}>清除详细日志</Button></>}
    {text !== undefined && <div>
      <p>只读事件流；不重新请求模型或执行命令。记录可能不完整。</p>
      <label>按会话、操作或调用 ID 筛选 <input value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
      <textarea aria-label="本地回放记录" readOnly rows={12} value={shown ?? ''} />
      {!shown?.trim() && <p>没有匹配的记录。</p>}
    </div>}
  </section>;
}
