import type { TaskStatus } from '@cloudhelm/contracts';

export async function capture(action: () => Promise<unknown>, report: (error: string) => void): Promise<void> {
  try { await action(); report(''); } catch (error) { report(error instanceof Error ? error.message : String(error)); }
}
export const statusLabel: Record<TaskStatus, string> = {
  draft: '准备就绪', running: '正在处理', 'waiting-review': '等待确认', 'waiting-user': '等待你的回答', 'human-control': '你已接管', recovering: '核验远端状态',
  paused: '已暂停', answered: '已回答', failed: '需要处理'
};
export const reviewLabel = { ask: '重要操作询问', 'ai-review': 'AI 审核', permissive: '完全访问' };
export type IconName = 'terminal' | 'server' | 'chat' | 'plus' | 'close' | 'more' | 'settings' | 'shield' | 'folder' | 'file' | 'arrow' | 'attach' | 'pause' | 'play' | 'stop' | 'expand' | 'disconnect' | 'check' | 'chevron' | 'copy' | 'edit' | 'sparkles' | 'history' | 'plan' | 'brain';
const paths: Record<IconName, string> = {
  terminal: 'm4 6 5 6-5 6m8 0h8', server: 'M4 4h16v6H4zM4 14h16v6H4zM7 7h.01M7 17h.01',
  chat: 'M20 15a3 3 0 0 1-3 3H8l-5 3V6a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3z',
  plus: 'M12 5v14M5 12h14', close: 'm6 6 12 12M6 18 18 6', more: 'M5 12h.01M12 12h.01M19 12h.01',
  settings: 'M9 3h6l1 4 4 2v6l-4 2-1 4H9l-1-4-4-2V9l4-2zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6', folder: 'M3 6h7l2 3h9v11H3z',
  file: 'M5 3h9l5 5v13H5zM14 3v6h5M8 13h8M8 17h6', arrow: 'M12 19V5m-6 6 6-6 6 6',
  attach: 'm8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L12 3m-7 13 9-9',
  pause: 'M8 5v14M16 5v14', play: 'm8 4 12 8-12 8z', stop: 'M5 5h14v14H5z',
  expand: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5', disconnect: 'M9 7 6 4M17 15l3 3M6 10l4-4 8 8-4 4zM3 21l5-5M16 8l5-5',
  sparkles: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5zM20 3v4M18 5h4',
  history: 'M4 11a8 8 0 1 1 2 6M4 4v7h7M12 7v5l3 2',
  plan: 'M9 6h12M9 12h12M9 18h12M3 6h1M3 12h1M3 18h1',
  brain: 'M12 4v16M12 5C8 1 4 5 5 8c-4 2-2 7 0 7-1 4 4 7 7 4M12 5c4-4 8 0 7 3 4 2 2 7 0 7 1 4-4 7-7 4M5 8l3 2M19 8l-3 2M5 15l3-2M19 15l-3-2',
  check: 'm5 12 4 4L19 6', chevron: 'm9 5 7 7-7 7',
  copy: 'M9 9h12v12H9zM15 9V3H3v12h6', edit: 'm15 5 4 4M4 20l4-1L21 6l-4-4L4 15z'
};
export function Icon({ name, size = 16 }: { name: IconName; size?: number }): React.JSX.Element {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
