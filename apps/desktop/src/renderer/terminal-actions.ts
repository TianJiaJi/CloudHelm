/**
 * Terminal capabilities exposed to menus and keyboard shortcuts. The xterm
 * instance lives inside a React effect, so it is registered by terminal id.
 */
export interface TerminalActions {
  getSelection(): string;
  paste(text: string): void;
  selectAll(): void;
  clear(): void;
  focus(): void;
}

const registry = new Map<string, TerminalActions>();

export function registerTerminalActions(id: string, actions: TerminalActions): () => void {
  registry.set(id, actions);
  return () => { if (registry.get(id) === actions) registry.delete(id); };
}

export function terminalActions(id: string | undefined | null): TerminalActions | undefined {
  return id ? registry.get(id) : undefined;
}
