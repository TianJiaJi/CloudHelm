import type { HostView, TaskView } from '@cloudhelm/contracts';

/** Chain of host ids a host inherited its identity from (jumps, re-imports). */
export function hostLineage(host: HostView, hosts: HostView[]): string[] {
  const ids = [host.id];
  let previousId = host.previousHostId;
  while (previousId && !ids.includes(previousId)) { ids.push(previousId); previousId = hosts.find((item) => item.id === previousId)?.previousHostId; }
  return ids;
}

/** Stable grouping key for a conversation: owning host, 'chat', or 'legacy'. */
export function conversationHostKey(conversation: TaskView, hosts: HostView[]): string {
  const originalHostId = conversation.hostIds[0];
  const currentHost = originalHostId ? hosts.find((host) => !host.archived && hostLineage(host, hosts).includes(originalHostId)) : undefined;
  return conversation.hostIds.length > 1 ? 'legacy' : currentHost?.id ?? originalHostId ?? 'chat';
}
