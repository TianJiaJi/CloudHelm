import { redactOutput, type OperationScope } from '@cloudhelm/core';

/** Each field keeps both ends; an explicit marker reports what the reviewer did not see. */
function bounded(text: string, limit: number) {
  const clean = redactOutput(text);
  if (clean.length <= limit) return { text: clean, truncated: false };
  const marker = '\n[…]\n';
  const headLength = Math.floor((limit - marker.length) / 3);
  let head = clean.slice(0, headLength);
  let tail = clean.slice(-(limit - marker.length - headLength));
  if (/[\uD800-\uDBFF]$/u.test(head)) head = head.slice(0, -1);
  if (/^[\uDC00-\uDFFF]/u.test(tail)) tail = tail.slice(1);
  return { text: head + marker + tail, truncated: true };
}

/** Bounded field allocation replaces the old first-2000-characters goal slice. */
export function reviewIntent(scope: Pick<OperationScope, 'goal' | 'intent'>) {
  const intent = scope.intent ?? { originalGoal: scope.goal, currentInput: scope.goal, origin: 'legacy' as const, clarifications: [] };
  const recent = intent.clarifications.slice(-4);
  const allowance = Math.floor(1200 / Math.max(1, recent.length));
  return { origin: intent.origin, originalGoal: bounded(intent.originalGoal, 800),
    currentInput: bounded(intent.currentInput, 1200),
    clarifications: recent.map((item) => ({ id: item.id, ...bounded(item.text, allowance) })),
    omittedClarifications: intent.clarifications.length - recent.length };
}
