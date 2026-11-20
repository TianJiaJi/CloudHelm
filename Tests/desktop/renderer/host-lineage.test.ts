import { describe, expect, it } from 'vitest';
import type { HostView, TaskView } from '@cloudhelm/contracts';
import { conversationHostKey, hostLineage } from '../../../apps/desktop/src/renderer/host-lineage.js';

function host(id: string, extra: Partial<HostView> = {}): HostView {
  return { id, label: id, address: '192.0.2.1', port: 22, username: 'root', auth: 'agent',
    status: 'connected', protectedPaths: [], defaultMode: 'ask', policyRevision: 1, ...extra };
}
function conversation(hostIds: string[]): TaskView {
  return { id: `task-${hostIds.join('-')}`, goal: 'goal', hostIds, localScopes: [], status: 'running',
    modelId: 'test-model', provider: 'test', requestCount: 1, requestLimit: 100, createdAt: 1, updatedAt: 1 };
}

describe('host lineage', () => {
  it('returns just the host when it has no predecessor', () => {
    const current = host('a');
    expect(hostLineage(current, [current])).toEqual(['a']);
  });
  it('walks the full chain of inherited identities', () => {
    const grand = host('a');
    const parent = host('b', { previousHostId: 'a' });
    const current = host('c', { previousHostId: 'b' });
    expect(hostLineage(current, [grand, parent, current])).toEqual(['c', 'b', 'a']);
  });
  it('stops before repeating when the chain contains a cycle', () => {
    const first = host('a', { previousHostId: 'b' });
    const second = host('b', { previousHostId: 'a' });
    expect(hostLineage(first, [first, second])).toEqual(['a', 'b']);
  });
  it('keeps a dangling predecessor id that no longer resolves', () => {
    const current = host('c', { previousHostId: 'ghost' });
    expect(hostLineage(current, [current])).toEqual(['c', 'ghost']);
  });
});

describe('conversation host keys', () => {
  it('groups a conversation under the current host that inherited its identity', () => {
    const original = host('a', { archived: true });
    const current = host('b', { previousHostId: 'a' });
    expect(conversationHostKey(conversation(['a']), [original, current])).toBe('b');
  });
  it('marks multi-host conversations as legacy', () => {
    expect(conversationHostKey(conversation(['a', 'b']), [host('a'), host('b')])).toBe('legacy');
  });
  it('falls back to the original host id when the current host is archived', () => {
    const original = host('a');
    const current = host('b', { previousHostId: 'a', archived: true });
    expect(conversationHostKey(conversation(['a']), [original, current])).toBe('a');
  });
  it('falls back to the original id for hosts that disappeared entirely', () => {
    expect(conversationHostKey(conversation(['gone']), [])).toBe('gone');
  });
  it('groups free chats separately', () => {
    expect(conversationHostKey(conversation([]), [])).toBe('chat');
  });
});
