import type { TaskStatus } from '@cloudhelm/contracts';

export { Icon, type IconName } from './ui/icon.js';
export async function capture(action: () => Promise<unknown>, report: (error: string) => void): Promise<void> {
  try { await action(); report(''); } catch (error) { report(error instanceof Error ? error.message : String(error)); }
}
export const statusLabel: Record<TaskStatus, string> = {
  draft: '准备就绪', running: '正在处理', 'waiting-review': '等待确认', 'waiting-user': '等待你的回答', 'human-control': '你已接管', recovering: '核验远端状态',
  paused: '已暂停', answered: '已回答', failed: '需要处理'
};
export const reviewLabel = { ask: '重要操作询问', 'ai-review': 'AI 审核', permissive: '完全访问', preauthorized: '预授权范围' };
