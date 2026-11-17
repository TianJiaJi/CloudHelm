/** High-frequency progress events skip full-snapshot publication; the renderer
 * applies each one incrementally instead of receiving the whole snapshot. */
export const incrementalOnlyEvents: ReadonlySet<string> = new Set(['terminal-data', 'reasoning-progress', 'text-progress',
  'context-usage', 'model-request', 'task-message']);
