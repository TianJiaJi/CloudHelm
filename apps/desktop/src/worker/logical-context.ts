import type { BusinessTool } from '@cloudhelm/core';
import type { LogicalHostContext } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import type { LogicalContextReceipt } from './operation-feedback.js';
import { Type, type Static } from 'typebox';

/** Absolute remote paths only: bounded length, no control characters. */
export function isValidRemotePath(path: string): boolean {
  return path.startsWith('/') && path.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(path);
}

/** Safe single-quoted probe: enter the directory under the current identity, report its canonical path. */
export function cdProbeCommand(path: string): string {
  return `cd -- '${path.replaceAll("'", `'\\''`)}' && pwd -P`;
}

export interface LogicalContextSyncOptions {
  /** Verifies an explicit default still resolves under the current authorized identity. */
  verify?(path: string): Promise<{ canonical: string } | { failed: true }>;
  /** Called when the default working context semantically changes (identity reset, unconfirmed default). */
  invalidate(): void;
}

/** Per-host logical working context. Login observations seed it, explicit verified
 * actions change it, rebuilds re-verify it; an unconfirmed default never silently
 * falls back to a home directory. */
export class LogicalContextTracker {
  private readonly records = new Map<string, LogicalHostContext>();
  private readonly syncedHosts = new Set<string>();

  constructor(initial: LogicalHostContext[] | undefined,
    private readonly emit: (value: LogicalHostContext) => void) {
    for (const record of initial ?? []) {
      if (record.version === 1 && record.hostId && typeof record.defaultCwd !== 'undefined')
        this.records.set(record.hostId, structuredClone(record));
    }
  }

  get(hostId: string): LogicalHostContext | undefined { return this.records.get(hostId); }

  /** undefined = no record (legacy default), null = record exists but unconfirmed. */
  defaultCwdFor(hostId: string): string | null | undefined { return this.records.get(hostId)?.defaultCwd; }

  receiptContext(hostId: string): LogicalContextReceipt | undefined {
    const record = this.records.get(hostId);
    if (!record) return undefined;
    return { defaultCwd: record.defaultCwd, revision: record.revision, rebuilt: record.restoreStatus !== undefined,
      ...(record.restoreStatus ? { restoreStatus: record.restoreStatus } : {}) };
  }

  /** Applies a verified explicit default; the caller must have confirmed the directory
   * is enterable under the current identity. Never used for silent observation refresh. */
  setExplicit(hostId: string, loginAs: string, canonical: string, invalidate: () => void): LogicalHostContext {
    const previous = this.records.get(hostId);
    const record: LogicalHostContext = { version: 1, hostId, loginAs, defaultCwd: canonical,
      revision: (previous?.revision ?? -1) + 1, source: 'explicit', updatedAt: Date.now() };
    this.records.set(hostId, record);
    // A fresh explicit default is already verified; the next terminal open is no rebuild.
    this.syncedHosts.add(hostId);
    this.emit(record);
    invalidate();
    return record;
  }

  /** One sync per host per session: the first terminal open either seeds the context
   * from the login observation or re-verifies the persisted default on rebuild. */
  async syncFromProbe(hostId: string, loginAs: string, probe: string, options: LogicalContextSyncOptions): Promise<void> {
    if (this.syncedHosts.has(hostId)) return;
    this.syncedHosts.add(hostId);
    const current = this.records.get(hostId);
    if (!current) {
      this.commit({ version: 1, hostId, loginAs, defaultCwd: probe, revision: 0, source: 'login-observed', updatedAt: Date.now() });
      return;
    }
    if (current.loginAs !== loginAs) {
      // The persisted default belongs to a different login; drop it, never reuse it.
      this.commit({ version: 1, hostId, loginAs, defaultCwd: probe, revision: current.revision + 1, source: 'login-observed', updatedAt: Date.now() });
      options.invalidate();
      return;
    }
    if (current.source === 'login-observed') {
      if (current.defaultCwd !== probe) {
        this.commit({ ...current, defaultCwd: probe, revision: current.revision + 1, restoreStatus: undefined, updatedAt: Date.now() });
        options.invalidate();
      } else if (current.restoreStatus !== undefined) this.commit({ ...current, restoreStatus: undefined, updatedAt: Date.now() });
      return;
    }
    // Explicit default: re-verify on rebuild; never fall back to a home directory silently.
    if (current.defaultCwd === null) return;
    if (!options.verify) {
      this.commit({ ...current, defaultCwd: null, revision: current.revision + 1, restoreStatus: 'unverified', updatedAt: Date.now() });
      options.invalidate();
      return;
    }
    const verified = await options.verify(current.defaultCwd);
    if ('failed' in verified) {
      this.commit({ ...current, defaultCwd: null, revision: current.revision + 1, restoreStatus: 'unverified', updatedAt: Date.now() });
      options.invalidate();
      return;
    }
    if (verified.canonical !== current.defaultCwd) {
      this.commit({ ...current, defaultCwd: verified.canonical, revision: current.revision + 1, restoreStatus: 'restored', updatedAt: Date.now() });
      options.invalidate();
      return;
    }
    this.commit({ ...current, restoreStatus: 'restored', updatedAt: Date.now() });
  }

  private commit(record: LogicalHostContext): void {
    this.records.set(record.hostId, record);
    this.emit(record);
  }
}

export interface SetDefaultCwdDependencies {
  hosts: RuntimeHost[];
  /** Probes whether the path is an enterable directory under the current authorized identity. */
  verify?(hostId: string, path: string): Promise<{ canonical: string } | { failed: true }>;
  /** Applies the verified default to the logical context. */
  apply(hostId: string, loginAs: string, canonical: string): LogicalHostContext;
  assertActive?(): void;
}

/** set_default_cwd: the only action that changes the persistent default working
 * directory. A failed or unavailable verification changes nothing. */
export function createSetDefaultCwdTool(deps: SetDefaultCwdDependencies) {
  const parameters = Type.Object({ hostId: Type.String(), path: Type.String({ minLength: 1, maxLength: 4096 }) }, { additionalProperties: false });
  const tool: BusinessTool<Static<typeof parameters>> = {
    name: 'set_default_cwd', label: 'Set the verified default working directory for one host',
    description: 'Set the default working directory for one host. The backend probes the absolute path over the current authorized connection; only a proven enterable directory becomes the default, and a failed probe changes nothing. Later remote operations without an explicit cwd run there; run_remote cwd overrides single commands and cd in commands never changes this default. Use after an unverified rebuild report, or to switch a sustained working area. Not a permission, root access, or a session change.',
    parameters, replay: 'never',
    available: () => !!deps.verify,
    execute: async (_id, params, signal) => {
      const host = deps.hosts.find((candidate) => candidate.id === params.hostId);
      if (!host) return { content: [{ type: 'text' as const, text: 'Host is outside the conversation authorization scope' }], details: { code: 'out-of-scope-host' }, isError: true };
      deps.assertActive?.();
      if (!deps.verify) return { content: [{ type: 'text' as const, text: '默认目录核验通道不可用；未做任何更改。' }], details: undefined, isError: true };
      if (!isValidRemotePath(params.path)) return { content: [{ type: 'text' as const, text: '路径必须是绝对路径（以 / 开头，不超过 4096 字符，不含控制字符）；未做任何更改。' }], details: undefined, isError: true };
      signal?.throwIfAborted();
      const verified = await deps.verify(host.id, params.path);
      signal?.throwIfAborted();
      if ('failed' in verified) return { content: [{ type: 'text' as const, text: `目录 ${params.path} 在当前授权身份下无法核验或进入（路径、权限或连接问题）；默认工作目录未改变。` }], details: undefined, isError: true };
      const record = deps.apply(host.id, host.username, verified.canonical);
      return { content: [{ type: 'text' as const, text: `默认工作目录已更新并通过核验。\nHost: ${host.label}\nDefault cwd: ${verified.canonical}\nRevision: ${record.revision}\n后续未显式指定 cwd 的远端操作将以该目录为默认工作目录；单次 cwd 仍可覆盖，cd 不会改变此默认。` }],
        details: undefined, structuredContent: { hostId: host.id, defaultCwd: verified.canonical, revision: record.revision, source: 'explicit' } };
    }
  };
  return tool;
}
