import type { AppSnapshot, TerminalViewState } from '@cloudhelm/contracts';
import type { ErrorPresentation } from './error-presentation.js';

export interface ErrorControlAction {
  method: 'stopOperation'; id: string; label: string; target: string; description: string;
}

/** Always bind the action to the reported conversation, never the currently selected tab. */
export function errorControlAction(notice: ErrorPresentation, conversations: AppSnapshot['conversations'],
  terminals: TerminalViewState[]): ErrorControlAction | undefined {
  if (notice.code !== 'terminal-busy' || !notice.context) return;
  const context = notice.context;
  const taskId = 'conversationId' in context ? context.conversationId : terminals.find((item) => item.id === context.terminalId)?.taskId;
  const task = conversations.find((item) => item.id === taskId);
  if (!task || !['running', 'waiting-review', 'waiting-user', 'recovering'].includes(task.status)) return;
  return { method: 'stopOperation', id: task.id, label: '停止本轮', target: task.goal,
    description: 'AI 正在执行。停止本轮后，等待远端命令退出即可输入；不会自动发起新的 AI 对话。' };
}
