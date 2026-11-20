let focusSearch: (() => void) | null = null;

export function registerHostTreeSearch(focus: (() => void) | null): void {
  focusSearch = focus;
}

/** Focuses the agent-mode sidebar search when a host tree is mounted. */
export function focusHostTreeSearch(): void {
  focusSearch?.();
}
