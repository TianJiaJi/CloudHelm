import { randomUUID } from 'node:crypto';
import { OutputRedactor, redactOutput } from '@cloudhelm/core';
import type { OperationView, RemoteReadAuditEvent } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import type { RemoteToolDependencies } from './remote-tool-dependencies.js';
import type { TaskSignals } from './task-signals.js';
import { assertRemoteReadAllowed, RemoteReadPolicyError, resolveRemoteReadTarget } from './remote-read-guard.js';
import { PROMPT_VERSION } from './agent-prompt.js';

type Reader = NonNullable<RemoteToolDependencies['readRemoteFile']>;
class ReadStateChanged extends Error {
  constructor(readonly code: 'policy-changed' | 'task-inactive') {
    super('读取期间授权或策略已变化；未交付文件内容，请重新发起读取。');
  }
}
class ReadAuditUnavailable extends Error {
  constructor() { super('读取审计未获得持久化确认；未读取或未交付文件内容。'); }
}

/** Reads share Main's acknowledged operation-journal writer, not a fire-and-forget
 * activity event. Persist before touching SFTP and before handing text to Pi. */
export function createAuditedRemoteReader(taskId: string, hosts: RuntimeHost[], rawRead: Reader | undefined,
  signals: TaskSignals, assertActive: () => void, operations: Map<string, OperationView>): Reader | undefined {
  if (!rawRead) return undefined;
  return async (hostId, filePath, cwd, signal, maxBytes = 128 * 1024) => {
    const host = hosts.find((item) => item.id === hostId);
    const policyBinding = (value: RuntimeHost | undefined) => value && JSON.stringify([
      value.username, value.policyRevision, value.defaultMode, value.archived, value.protectedReadPaths ?? value.protectedPaths]);
    const binding = policyBinding(host);
    let target: string | undefined, invalidPath: unknown;
    try { target = resolveRemoteReadTarget(filePath, cwd); } catch (error) { invalidPath = error; }
    const safePath = redactOutput(target ?? filePath).replace(/[\u0000-\u001f\u007f]/gu, '?').slice(0, 4096);
    const record: OperationView = { id: randomUUID(), taskId, hostId, kind: 'read-file', preview: `Read ${safePath}`,
      status: 'proposed', readOnly: true, effects: 'none', createdAt: Date.now(), promptVersion: PROMPT_VERSION,
      ...(host ? { loginAs: host.username, runAs: host.username } : {}),
      readAudit: { version: 1, path: safePath, policyRevision: host?.policyRevision ?? 0, events: [] } };
    const persist = async (phase: RemoteReadAuditEvent['phase'], code: RemoteReadAuditEvent['code'],
      metadata: Pick<RemoteReadAuditEvent, 'bytes' | 'redacted' | 'truncated'> = {}) => {
      record.readAudit!.events.push({ phase, code, at: Date.now(), ...metadata });
      record.status = phase === 'requested' ? 'proposed' : phase === 'authorized' ? 'running'
        : phase === 'completed' ? 'succeeded' : phase === 'denied' ? 'denied' : 'failed';
      record.ruleId = `read-${code}`;
      if (!['requested', 'authorized'].includes(phase)) record.completedAt = Date.now();
      try {
        if (!signals.commitOperation) throw new ReadAuditUnavailable();
        await signals.commitOperation(structuredClone(record));
      } catch { throw new ReadAuditUnavailable(); }
      operations.set(record.id, structuredClone(record));
      signals.event({ type: 'operation', value: structuredClone(record) });
    };
    // An out-of-scope request is still a denied attempt, never an execution grant.
    if (!host) {
      await persist('denied', 'host-out-of-scope');
      throw new Error('Host is outside this conversation authorization');
    }
    const current = () => {
      signal?.throwIfAborted();
      try { assertActive(); } catch { throw new ReadStateChanged('task-inactive'); }
      const live = hosts.find((item) => item.id === hostId);
      if (!live || live !== host || live.archived || policyBinding(live) !== binding) throw new ReadStateChanged('policy-changed');
      if (invalidPath) throw invalidPath;
      assertRemoteReadAllowed(target!, live.protectedReadPaths ?? live.protectedPaths);
    };
    await persist('requested', 'requested');
    try {
      current();
      await persist('authorized', 'allowed');
      current();
      const snapshot = await rawRead(hostId, target!, '/', signal, maxBytes);
      current();
      const redactor = new OutputRedactor(1_048_576);
      const content = redactor.push(snapshot.content) + redactor.finish();
      const redacted = content !== snapshot.content;
      await persist('completed', 'completed', { bytes: snapshot.bytes, redacted, truncated: snapshot.truncated });
      current();
      return { ...snapshot, content, redacted, sha256: redacted || snapshot.truncated ? undefined : snapshot.sha256 };
    } catch (error) {
      if (error instanceof ReadAuditUnavailable) throw error;
      const policy = error instanceof RemoteReadPolicyError || error instanceof ReadStateChanged;
      await persist(policy ? 'denied' : 'failed', policy ? error.code : signal?.aborted ? 'cancelled' : 'read-failed');
      // No raw server error or file content belongs in the audit or tool error.
      throw new Error(policy ? error.message : 'Remote file read was cancelled or unavailable; no content delivered.');
    }
  };
}
