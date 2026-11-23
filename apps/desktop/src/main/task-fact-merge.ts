import { mergeConnectionLosses, mergeLogicalContext, type AppEvent, type TaskView } from '@cloudhelm/contracts';

/** Merges one worker-originated task fact into the authoritative TaskView.
 * Returns the updated task when the fact changed persistence-relevant state,
 * or undefined when a stale or redelivered fact changed nothing. */
export function mergeTaskFact(task: TaskView, event: AppEvent): TaskView | undefined {
  switch (event.type) {
    case 'logical-context': {
      const previous = task.logicalContexts ?? [];
      const merged = mergeLogicalContext(previous, event.value);
      return merged !== previous ? { ...task, logicalContexts: merged } : undefined;
    }
    case 'connection-loss': {
      const previous = task.connectionLosses ?? [];
      const merged = mergeConnectionLosses(previous, event.value);
      return merged !== previous ? { ...task, connectionLosses: merged } : undefined;
    }
    default: return undefined;
  }
}
