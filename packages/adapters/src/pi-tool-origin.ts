import { AsyncLocalStorage } from 'node:async_hooks';

/** Backend observation identity, not an execution capability or model-provided field. */
export interface ToolOrigin { runId: string; parentCallId: string }
const origins = new AsyncLocalStorage<ToolOrigin>();
export function withToolOrigin<T>(origin: ToolOrigin, run: () => T): T { return origins.run(origin, run); }
export function currentToolOrigin(): ToolOrigin | undefined { return origins.getStore(); }
