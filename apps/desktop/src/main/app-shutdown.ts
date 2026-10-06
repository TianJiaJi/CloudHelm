import type { AppSnapshot } from '@cloudhelm/contracts';

interface Dependencies {
  snapshot(): AppSnapshot | undefined;
  confirmExit(): Promise<boolean>;
  quit(): void;
  close(): void;
}

/** before-quit can be canceled or re-entered; only will-quit may dispose shared resources. */
export class AppShutdown {
  private phase: 'open' | 'confirmed' | 'closed' = 'open';
  private prompting = false;

  constructor(private readonly deps: Dependencies) {}

  get isClosed(): boolean { return this.phase === 'closed'; }

  beforeQuit(event: { preventDefault(): void }): void {
    if (this.phase !== 'open') return;
    if (this.prompting) { event.preventDefault(); return; }
    const snapshot = this.deps.snapshot();
    const active = snapshot?.conversations.some((conversation) => ['running', 'waiting-review', 'waiting-user', 'human-control'].includes(conversation.status))
      || snapshot?.operations.some((operation) => ['running', 'unknown'].includes(operation.status)
        && snapshot.terminals.some((terminal) => terminal.id === operation.logRef));
    if (!active) return;
    event.preventDefault();
    this.prompting = true;
    void this.deps.confirmExit().then((confirmed) => {
      if (confirmed && this.phase === 'open') {
        this.phase = 'confirmed';
        this.deps.quit();
      }
    }).catch(() => {
      // A failed/canceled dialog leaves the app and its database usable.
    }).finally(() => { this.prompting = false; });
  }

  willQuit(): void {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    this.deps.close();
  }
}
