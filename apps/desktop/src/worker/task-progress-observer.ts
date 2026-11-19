import type { BusinessTool } from '@cloudhelm/core';
import type { OperationView } from '@cloudhelm/contracts';
import type { TaskProgress } from './task-progress.js';

/** Observe only successful backend read results, never tool-call IDs, proposals
 * or plans. Log identity deliberately excludes the generated operation ID. */
export function observeProgressTools(tools: BusinessTool[], progress: TaskProgress, operations: () => OperationView[]): BusinessTool[] {
  return tools.map((tool) => ({ ...tool, execute: async (id, args, signal) => {
    const result = await tool.execute(id, args, signal);
    if (signal?.aborted || result.isError) return result;
    const input = args as Record<string, unknown>;
    if (tool.name === 'read_selected_text_file' || tool.name === 'list_selected_directory') {
      progress.observe(tool.name, JSON.stringify([input.path, result.content]));
    } else if (tool.name === 'read_operation_log' && result.details && typeof result.details === 'object') {
      const details = result.details as Record<string, unknown>;
      const source = operations().find((operation) => operation.id === details.operationId);
      if (source && details.kind === 'operation-log' && details.availability === 'available' && typeof details.sha256 === 'string') {
        const identity = source.intentKey ?? JSON.stringify([source.hostId, source.kind, source.commandSource?.cwd, source.preview]);
        progress.observe('operation-log', JSON.stringify([identity, details.cursor, details.nextCursor, details.sha256]));
      }
    }
    return result;
  } }));
}
