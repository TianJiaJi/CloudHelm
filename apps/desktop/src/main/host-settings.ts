import { randomUUID } from 'node:crypto';
import { Value } from 'typebox/value';
import type { SqliteStore } from '@cloudhelm/adapters';
import { HostDraftSchema, HostCredentialsPatchSchema, validateHostConnectionSettings,
  type HostDraft, type HostView, type HostCredentials, type HostCredentialsPatch } from '@cloudhelm/contracts';

interface HostSettingsContext {
  hosts: Map<string, HostView>; store: SqliteStore;
  encrypt(value: string): string; secret(key: string): string | undefined; publish(): void;
}

export function readHostCredentials(host: HostView, secret: (key: string) => string | undefined): HostCredentials {
  const encoded = secret(`host-credentials:${host.id}`);
  if (encoded !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(encoded); } catch { throw new Error('主机凭据记录无效'); }
    if (!Value.Check(HostCredentialsPatchSchema, parsed)) throw new Error('主机凭据记录无效');
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string')) as HostCredentials;
  }
  // Compatibility is purpose-bound. Never reinterpret a key passphrase as a password.
  const legacy = host.auth === 'agent' ? undefined : secret(`host:${host.id}`);
  return legacy === undefined ? {} : host.auth === 'password' ? { password: legacy } : { passphrase: legacy };
}

function publicDraft(input: HostDraft, hosts: Map<string, HostView>, previous?: HostView): HostDraft {
  if (!Value.Check(HostDraftSchema, input)) throw new Error('Invalid host settings');
  validateHostConnectionSettings(input);
  if (input.jumpHostId) {
    const jump = hosts.get(input.jumpHostId);
    if (!jump || jump.archived || jump.jumpHostId || jump.id === previous?.id || jump.auth === 'agent') throw new Error('Choose an active direct host as the single jump host');
  }
  return { label: input.label, address: input.address, port: input.port, username: input.username,
    auth: input.auth, privateKeyPath: input.privateKeyPath, jumpHostId: input.jumpHostId,
    group: input.group, notes: input.notes, connection: input.connection ? structuredClone(input.connection) : undefined };
}

const proxyIdentity = (host: HostDraft) => {
  const proxy = host.connection?.proxy;
  return proxy ? JSON.stringify([proxy.protocol, proxy.address, proxy.port, proxy.username]) : undefined;
};

export function canReuseHostLogin(draft: HostDraft, previous?: HostView): boolean {
  return !!previous && previous.auth === draft.auth && previous.address === draft.address && previous.port === draft.port
    && previous.username === draft.username && previous.privateKeyPath === draft.privateKeyPath && previous.jumpHostId === draft.jumpHostId
    && proxyIdentity(previous) === proxyIdentity(draft) && !!previous.connection?.proxy?.enabled === !!draft.connection?.proxy?.enabled;
}

/** The same binding is used by Save and Test; a draft cannot obtain a secret for a different recipient. */
export function credentialsForDraft(draft: HostDraft, previous: HostView | undefined, saved: HostCredentials, patch: HostCredentialsPatch = {}): HostCredentials {
  if (!Value.Check(HostCredentialsPatchSchema, patch)) throw new Error('Invalid SSH credentials');
  const sameLogin = canReuseHostLogin(draft, previous);
  const credentials: HostCredentials = sameLogin ? { password: saved.password, passphrase: saved.passphrase } : {};
  if (previous && draft.connection?.proxy?.username && proxyIdentity(previous) === proxyIdentity(draft)) credentials.proxyPassword = saved.proxyPassword;
  if (previous && draft.connection?.x11?.cookie === 'manual' && JSON.stringify(previous.connection?.x11) === JSON.stringify(draft.connection?.x11)) credentials.x11Cookie = saved.x11Cookie;
  for (const key of ['password', 'passphrase', 'proxyPassword', 'x11Cookie'] as const) {
    if (patch[key] !== undefined) credentials[key] = patch[key] === null ? undefined : patch[key];
  }
  return credentials;
}

/** A duplicate configuration declares the same login target as an existing record; the
 * association keeps unresolved risk shared. DNS/IP/fingerprint aliases are never guessed. */
export function resolveRiskPeer(hosts: Map<string, HostView>, target: Pick<HostDraft, 'address' | 'port' | 'username'>,
  excludeId?: string): string | undefined {
  let active: string | undefined, archived: string | undefined;
  for (const host of hosts.values()) {
    if (host.id === excludeId || host.address !== target.address
      || host.port !== target.port || host.username !== target.username) continue;
    if (host.archived) archived = host.id; else active = host.id;
  }
  return active ?? archived;
}

export function createHostSettings(context: HostSettingsContext, input: HostDraft, patch?: HostCredentialsPatch): HostView {
  const draft = publicDraft(input, context.hosts);
  const credentials = credentialsForDraft(draft, undefined, {}, patch);
  const riskPeerHostId = resolveRiskPeer(context.hosts, draft);
  const host: HostView = { ...draft, id: randomUUID(), status: 'disconnected', protectedPaths: [], protectedReadPaths: [],
    protectedWritePaths: [], defaultMode: 'ask', policyRevision: 1, ...(riskPeerHostId !== undefined ? { riskPeerHostId } : {}) };
  const changes: Parameters<SqliteStore['commitHostSettings']>[0] = [{ bucket: 'hosts', id: host.id, value: host }];
  if (patch !== undefined) changes.push({ bucket: 'secrets', id: `host-credentials:${host.id}`, value: context.encrypt(JSON.stringify(credentials)) });
  context.store.commitHostSettings(changes);
  context.hosts.set(host.id, host); context.publish(); return host;
}

export function editHostSettings(context: HostSettingsContext, id: string, input: HostDraft, newSecret?: string, patch?: HostCredentialsPatch): HostView {
  const previous = context.hosts.get(id);
  if (!previous) throw new Error('Host not found');
  if (previous.archived) throw new Error('An archived host revision cannot be edited');
  const draft = publicDraft(input, context.hosts, previous);
  if (patch !== undefined && !Value.Check(HostCredentialsPatchSchema, patch)) throw new Error('Invalid SSH credentials');
  if (newSecret !== undefined && (typeof newSecret !== 'string' || newSecret.length > 4096)) throw new Error('Invalid SSH credentials');
  const connectionChanged = previous.address !== draft.address || previous.port !== draft.port || previous.username !== draft.username
    || previous.auth !== draft.auth || previous.privateKeyPath !== draft.privateKeyPath || previous.jumpHostId !== draft.jumpHostId
    || JSON.stringify(previous.connection) !== JSON.stringify(draft.connection) || !!newSecret || !!patch && Object.keys(patch).length > 0;
  if (!connectionChanged) {
    const renamed = { ...previous, label: draft.label, group: draft.group, notes: draft.notes };
    context.store.commitHostSettings([{ bucket: 'hosts', id, value: renamed }]);
    context.hosts.set(id, renamed); context.publish(); return renamed;
  }
  const credentials = credentialsForDraft(draft, previous, readHostCredentials(previous, context.secret), {
    ...(newSecret ? draft.auth === 'password' ? { password: newSecret } : { passphrase: newSecret } : {}), ...patch });
  const ciphertext = context.encrypt(JSON.stringify(credentials));
  // Revisions derive their domain from the recorded lineage alone; a duplicate-target
  // association is only ever recorded for a fresh configuration, never inherited or
  // recomputed by editing, so an edit cannot move a record out of its risk domain.
  const replacement: HostView = { ...previous, ...draft, id: randomUUID(), previousHostId: id, archived: false,
    status: 'disconnected', policyRevision: 1, riskPeerHostId: undefined,
    fingerprint: previous.address === draft.address && previous.port === draft.port ? previous.fingerprint : undefined };
  const archived = { ...previous, archived: true };
  context.store.commitHostSettings([{ bucket: 'hosts', id, value: archived }, { bucket: 'hosts', id: replacement.id, value: replacement },
    { bucket: 'secrets', id: `host-credentials:${replacement.id}`, value: ciphertext }]);
  context.hosts.set(id, archived); context.hosts.set(replacement.id, replacement); context.publish(); return replacement;
}
