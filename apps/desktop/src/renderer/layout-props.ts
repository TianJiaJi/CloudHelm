import type { HostView, TaskView } from '@cloudhelm/contracts';
import type { ContextMenuEntry } from './context-menu.js';
import type { WorkspaceTab } from './store.js';

/**
 * Everything a layout shell needs from App. Business state stays in the store;
 * only handlers, dialogs and error surfaces are owned by App and passed down.
 */
export interface LayoutProps {
  connecting: string[];
  hiddenInputs: string[];
  appVersion: string;
  navigate(action: () => void): void;
  connectHost(hostId: string, alwaysNew?: boolean): Promise<void>;
  disconnect(host: HostView): void;
  closeTab(tab: WorkspaceTab): void;
  closeTabs(targets: WorkspaceTab[]): void;
  quoteTerminal(): void;
  openInput(id: string): void;
  openHostDialog(): void;
  setError(message: string): void;
  reportTerminalError(message: string): void;
  reportConversationError(message: string): void;
  hostActions(host: HostView): ContextMenuEntry[];
  conversationActions(conversation: TaskView): ContextMenuEntry[];
  tabActions(tab: WorkspaceTab): ContextMenuEntry[];
  registerNavigationGuard(guard: ((next: () => void) => void) | null): void;
}
