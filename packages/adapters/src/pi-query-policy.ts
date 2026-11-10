import { withToolOrigin, type ToolOrigin } from './pi-tool-origin.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Type } from 'typebox';
import { createCodemodeExtension, createToolSearchExtension, defineTool, type ExtensionFactory,
  type ExtensionToolContext, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { BusinessTool, SessionOptions } from '@cloudhelm/core';
import { assertStrictToolArguments, withOriginalToolInput } from './pi-tool-validation.js';

export const CODEMODE_LIMITS = { deadlineMs: 15_000, calls: 32, concurrency: 4, outputTokens: 4096, codeChars: 32768 } as const;
export const queryCodeSchema = Type.Object({ code: Type.String({ minLength: 1, maxLength: CODEMODE_LIMITS.codeChars }) }, { additionalProperties: false });
export const querySearchSchema = Type.Object({ query: Type.String({ minLength: 1, maxLength: 200 }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })) }, { additionalProperties: false });
const builtins = new Set(['ask_user', 'codemode', 'tool_search']);
const cacheKeys = new Set(['cursor', 'operation', 'job', 'terminal', 'history', 'page']);
const referenceFields = new Set(['operationId', 'jobId', 'terminalId', 'hostId']);

/** Small references/cursors only, not arbitrary script state or an authorization source. */
export function validateQueryStore(data: unknown, referenceAllowed: (id: string) => boolean): void {
  const fail = () => { throw new Error('Query cache accepts only bounded authorized references and cursors'); };
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail();
  const { set, delete: removed } = data as { set?: unknown; delete?: unknown };
  if (!set || typeof set !== 'object' || Array.isArray(set) || !Array.isArray(removed)
    || removed.length > 6 || removed.some((key) => !cacheKeys.has(key))
    || Object.keys(set).length > 6 || Buffer.byteLength(JSON.stringify(data)) > 4096) return fail();
  for (const [key, value] of Object.entries(set)) {
    if (!cacheKeys.has(key) || !value || typeof value !== 'object' || Array.isArray(value)) return fail();
    const entries = Object.entries(value);
    if (!entries.length || entries.length > 5) return fail();
    for (const [field, item] of entries) {
      if (field === 'cursor') { if (!Number.isSafeInteger(item) || Number(item) < 0) return fail(); }
      else if (!referenceFields.has(field) || typeof item !== 'string' || item.length > 128 || !referenceAllowed(item)) return fail();
    }
  }
}

/** Shared across scripts: an aborted script cannot lend its outstanding query slots to the next script. */
class QuerySlots {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit: number = CODEMODE_LIMITS.concurrency) {}
  async run<T>(signal: AbortSignal, call: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.active >= this.limit) await new Promise<void>((resolve, reject) => {
      const grant = () => { signal.removeEventListener('abort', cancel); this.active++; resolve(); };
      const cancel = () => { const index = this.waiting.indexOf(grant); if (index >= 0) this.waiting.splice(index, 1);
        signal.removeEventListener('abort', cancel); reject(new Error('Query cancelled before dispatch')); };
      if (this.waiting.length >= CODEMODE_LIMITS.calls) { reject(new Error('Query concurrency queue is full')); return; }
      this.waiting.push(grant); signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    }); else this.active++;
    try { signal.throwIfAborted(); return await call(); }
    finally { this.active--; this.waiting.shift()?.(); }
  }
}

const scripts = new QuerySlots(2); // Do not inherit an ambient PI_CODEMODE_MAX_WORKERS increase.

/** Trusted SDK factories with application-owned policy, not a second JS evaluator. */
export class PiQueryPolicy {
  private readonly tools: Map<string, BusinessTool>;
  private agent?: { toolExecution: 'parallel' | 'sequential' };
  private callOrigin?: (id: string) => ToolOrigin | undefined;
  bindCallOrigin(resolve: (id: string) => ToolOrigin | undefined): void { this.callOrigin = resolve; }
  private readonly slots = new QuerySlots();
  private readonly cacheWrites = new AsyncLocalStorage<Array<() => void>>();
  constructor(private readonly options: SessionOptions) {
    this.tools = new Map(options.tools.map((tool) => [tool.name, tool]));
    if (this.tools.size !== options.tools.length || [...this.tools.keys()].some((name) => builtins.has(name)))
      throw new Error('Invalid business tool registry');
  }
  bindAgent(agent: { toolExecution: 'parallel' | 'sequential' }): void {
    if (this.agent && this.agent !== agent) throw new Error('Query agent binding changed');
    this.agent = agent;
  }
  allowed(name: string): boolean {
    if (builtins.has(name)) return true;
    const tool = this.tools.get(name);
    try { return !!tool && (!tool.available || tool.available() === true); } catch { return false; }
  }
  queryAllowed(name: string): boolean { return this.tools.get(name)?.access === 'query' && this.allowed(name); }
  activeNames(current: string[] = []): string[] {
    return [...new Set([...current.filter((name) => this.allowed(name)),
      ...this.options.tools.filter((tool) => !tool.deferred && this.allowed(tool.name)).map((tool) => tool.name), ...builtins])];
  }
  factories(): Array<{ name: string; factory: ExtensionFactory }> {
    return [
      { name: '@cloudhelm/query-codemode', factory: (pi) => createCodemodeExtension({ mode: 'on', models: false, inlineBudget: 0 })({
        ...pi, getAllTools: () => pi.getAllTools().filter((tool) => this.queryAllowed(tool.name)),
        appendEntry: (kind, data) => {
          if (kind !== 'codemode-store') throw new Error('Unsupported query cache entry');
          validateQueryStore(data, (id) => this.options.queryReferenceAllowed?.(id) === true);
          const writes = this.cacheWrites.getStore();
          if (!writes || writes.length) throw new Error('Query cache transaction unavailable');
          const copy = structuredClone(data);
          writes.push(() => {
            validateQueryStore(copy, (id) => this.options.queryReferenceAllowed?.(id) === true);
            pi.appendEntry(kind, copy);
          });
        },
        registerTool: (tool) => pi.registerTool(this.codeTool(defineTool(tool)))
      }) },
      { name: '@cloudhelm/query-search', factory: (pi) => createToolSearchExtension()({
        ...pi, getAllTools: () => pi.getAllTools().filter((tool) => this.allowed(tool.name)),
        setActiveTools: (names) => pi.setActiveTools(names.filter((name) => this.allowed(name))),
        registerTool: (tool) => pi.registerTool(this.searchTool(defineTool(tool)))
      }) }
    ];
  }
  private searchTool(native: ToolDefinition): ToolDefinition {
    if (native.name !== 'tool_search') throw new Error('Unexpected discovery tool');
    return { ...native, parameters: querySearchSchema,
      description: 'Search and load only currently authorized deferred CloudHelm queries. Discovery is not an execution grant; recipient and policy are checked again on every call. No external MCP or local shell.',
      execute: async (id, args, signal, update, context) => {
        this.options.assertActive(); signal?.throwIfAborted(); assertStrictToolArguments(querySearchSchema, args);
        return native.execute(id, args, signal, update, context);
      } };
  }
  private codeTool(native: ToolDefinition): ToolDefinition {
    if (native.name !== 'codemode') throw new Error('Unexpected script tool');
    return { ...native, parameters: queryCodeSchema, executionMode: 'sequential',
      prepareLoadout: (loadout) => {
        const safe = { ...loadout, callable: loadout.callable.filter((tool) => this.queryAllowed(tool.name)) };
        const prepared = native.prepareLoadout?.(safe);
        return prepared && { ...prepared, descriptions: { ...prepared.descriptions,
          codemode: `${prepared.descriptions?.codemode ?? native.description}\nCloudHelm: queries only; models disabled. Fixed 15-second deadline, 32 calls, 4 concurrent queries, 4096 output tokens. Do not supply an @options line. Cache slots cursor/operation/job/terminal/history/page accept only owned reference IDs and nonnegative cursors; cached data grants no authority.` } };
      },
      execute: async (id, args, signal, update, context) => {
        this.options.assertActive(); signal?.throwIfAborted(); assertStrictToolArguments(queryCodeSchema, args);
        if (!context || typeof id !== 'string' || !id || id.length > 200) throw new Error('Query execution context unavailable');
        const origin = this.callOrigin?.(id);
        if (!origin) throw new Error('Query observation binding unavailable');
        const code = (args as { code: string }).code;
        if (/^\s*\/\/\s*@options:/mu.test(code)) throw new Error('Codemode limits are backend-owned; omit the options line');
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(new Error('Query script deadline exceeded')), CODEMODE_LIMITS.deadlineMs);
        const bound = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
        const generation = this.options.requestGeneration?.(); let calls = 0;
        const assertCurrent = () => { bound.throwIfAborted(); this.options.assertActive();
          if (this.options.requestGeneration?.() !== generation) throw new Error('Query authorization changed during script'); };
        const safeContext: ExtensionToolContext = { ...context,
          tools: context.tools.filter((tool) => this.queryAllowed(tool.name)),
          sessionManager: this.cacheReader(context.sessionManager),
          executeTool: async (name, input, callOptions) => {
            const number = ++calls;
            try {
              assertCurrent();
              if (number > CODEMODE_LIMITS.calls || !this.queryAllowed(name)) throw new Error('Query capability or call limit denied');
              assertStrictToolArguments(this.tools.get(name)!.parameters, input);
              const childSignal = AbortSignal.any([bound, ...(callOptions?.signal ? [callOptions.signal] : [])]);
              return await this.slots.run(childSignal, async () => {
                assertCurrent(); if (!this.queryAllowed(name)) throw new Error('Query authorization changed before dispatch');
                const result = await withToolOrigin(origin, () => withOriginalToolInput(name, input,
                  () => context.executeTool(name, input, { ...callOptions, signal: childSignal })));
                assertCurrent(); childSignal.throwIfAborted();
                if (!this.queryAllowed(name)) throw new Error('Query authorization revoked; result withheld');
                return result;
              });
            } catch (error) {
              this.options.event({ type: 'tool-end', id: `${id}/policy-denied-${number}`, name, isError: true,
                parentToolCallId: id, durationMs: 0 });
              throw error;
            }
          }
        };
        const agent = this.agent;
        if (!agent || agent.toolExecution !== 'sequential') {
          clearTimeout(deadline); controller.abort(); throw new Error('Sequential outer tool policy unavailable');
        }
        try {
          assertCurrent();
          // The pinned Core run captured sequential outer execution before this call. The script itself
          // is also sequential; only the SDK nested runner reads this live mode. All mutations remain model-only.
          agent.toolExecution = 'parallel';
          const writes: Array<() => void> = [];
          const result = await this.cacheWrites.run(writes, () => scripts.run(bound, () => native.execute(id,
            { code: `// @options: {"timeout_ms":15000,"max_output_tokens":4096}\n${code}` }, bound, update, safeContext)));
          assertCurrent();
          if (!result.isError) for (const commit of writes) { assertCurrent(); commit(); }
          return result;
        } finally { agent.toolExecution = 'sequential'; clearTimeout(deadline); controller.abort(new Error('Query script ended')); }
      }
    };
  }
  private cacheReader(manager: ExtensionToolContext['sessionManager']): ExtensionToolContext['sessionManager'] {
    return new Proxy(manager, { get: (target, property) => {
      if (property === 'getBranch') return () => target.getBranch().filter((entry) => {
        if (entry.type !== 'custom' || entry.customType !== 'codemode-store') return true;
        try { validateQueryStore(entry.data, (id) => this.options.queryReferenceAllowed?.(id) === true); return true; } catch { return false; }
      });
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
}
