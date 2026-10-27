import type { OperationView, UserInterruption } from '@cloudhelm/contracts';

export function interruptionContext(interruption: UserInterruption | undefined, views: OperationView[]): string {
  if (!interruption) return '';
  const operations = interruption.operationIds.map((id) => {
    const op = views.find((candidate) => candidate.id === id);
    return { id, hostId: op?.hostId, status: op?.status ?? 'unknown', exitCode: op?.exitCode };
  });
  return `CloudHelm user interruption: the user deliberately stopped execution (${interruption.source}). This is not an autonomous tool failure. Do not automatically retry or replay the interrupted operation. First verify actual remote state; a stop request does not prove exit. Authoritative operation observations: ${JSON.stringify(operations)}`;
}
