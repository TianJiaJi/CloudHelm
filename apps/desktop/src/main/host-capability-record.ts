import { redactOutput } from '@cloudhelm/core';
import type { HostCapabilityProfile, HostView } from '@cloudhelm/contracts';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import type { SqliteStore } from '@cloudhelm/adapters';

const tools = new Set(['sh', 'env', 'bash', 'python3', 'curl', 'wget', 'apt-get', 'dnf', 'yum', 'apk', 'pacman',
  'systemctl', 'docker', 'git', 'tar']);

/** Worker observations are persisted for offline diagnosis, never for authorization.
 * Reject secret-like, oversized or differently bound data before it reaches SQLite. */
export function persistHostCapability(store: SqliteStore, host: HostView | undefined, value: HostCapabilityProfile): void {
  const fields = ['os', 'distribution', 'version', 'architecture', 'architectureFamily', 'kernel',
    'username', 'loginDirectory', 'path'] as const;
  if (!host || host.archived || !host.fingerprint || host.id !== value.hostId
    || host.fingerprint !== value.hostFingerprint || host.username !== value.loginAs
    || value.version !== 1 || !/^[a-f0-9-]{36}:[1-9][0-9]{0,9}$/u.test(value.connectionId)
    || !Number.isSafeInteger(value.observedAt) || value.observedAt < 0
    || Math.abs(Date.now() - value.observedAt) > 5 * 60_000
    || !['python', 'shell'].includes(value.data?.source)
    || value.data?.uid !== null && (!Number.isSafeInteger(value.data?.uid) || value.data.uid < 0)
    || fields.some((field) => value.data?.[field] !== null && (typeof value.data?.[field] !== 'string'
      || value.data[field].length > 4096 || /[\u0000-\u001f\u007f]/u.test(value.data[field])))
    || Object.keys(value).some((field) => !['version', 'hostId', 'hostFingerprint', 'loginAs', 'connectionId', 'observedAt', 'data'].includes(field))
    || Object.keys(value.data ?? {}).some((field) => ![...fields, 'uid', 'toolPresence', 'source'].includes(field))
    || !value.data?.toolPresence || Object.entries(value.data.toolPresence).some(([key, present]) => !tools.has(key) || typeof present !== 'boolean'))
    throw new Error('Invalid host capability observation binding');
  const encoded = JSON.stringify(value);
  if (encoded.length > 8192 || redactOutput(encoded) !== encoded || /[\u0000-\u001f\u007f]/u.test(encoded))
    throw new Error('Unsafe host capability observation');
  const prior = store.getHostCapability(value.hostId);
  if (prior?.hostFingerprint === value.hostFingerprint && prior.observedAt > value.observedAt) return;
  store.putHostCapability(value.hostId, value);
}

/** Attaches the durable capability archive for planning-time projection only.
 * Identity-scoped: an archive recorded for another login never projects, and
 * the durable record stays a planning hint, never authorization. */
export function attachArchivedCapability(host: RuntimeHost, store: SqliteStore): RuntimeHost {
  const archived = store.getHostCapability(host.id);
  return archived && archived.loginAs === host.username && archived.data
    ? { ...host, archivedCapability: { loginAs: archived.loginAs, observedAt: archived.observedAt, data: archived.data } }
    : host;
}
