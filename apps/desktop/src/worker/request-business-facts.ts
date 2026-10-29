import { createHash } from 'node:crypto';
import { redactOutput } from '@cloudhelm/core';
import type { OperationView, TaskIntentState, TaskView } from '@cloudhelm/contracts';
import { mergeOperationViews, runtimeFacts } from './runtime-facts.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('base64url');
/** Encoded UTF-8 quotas include escaping; large pasted instructions remain in
 * the intent ledger/native history, never copied wholesale into every frame. */
function excerpt(text: string, maxBytes: number) {
  const redacted = redactOutput(text); const chars = [...redacted];
  const render = (count: number) => count >= chars.length ? redacted
    : `${chars.slice(0, Math.ceil(count / 2)).join('')}\n[omitted middle]\n${chars.slice(chars.length - Math.floor(count / 2)).join('')}`;
  let low = 0, high = chars.length;
  if (Buffer.byteLength(JSON.stringify(redacted), 'utf8') > maxBytes) {
    high--;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(JSON.stringify(render(mid)), 'utf8') <= maxBytes) low = mid;
      else high = mid - 1;
    }
  } else low = high;
  return { text: render(low), truncated: low < chars.length,
    sourceChars: chars.length, sourceVersion: digest(redacted) };
}
/** Also reserves growth when a genuine input changes the bounded intent index
 * after preparation. It is not additional model/request allowance. */
export const NEXT_INPUT_FACT_TOKENS = 4096;
export const withInputFactReserve = (prompt: string) => `${prompt}\n[Pending input fact-index reserve; not instructions: ${' '.repeat(NEXT_INPUT_FACT_TOKENS * 2)}]`;

export function requestBusinessFacts(task: TaskView, operations: OperationView[], round: OperationView[], intent?: TaskIntentState) {
  const current = mergeOperationViews(operations).filter((op) => op.taskId === task.id);
  const state = runtimeFacts(current);
  const index = current.filter((op) => ['proposed', 'approved', 'running'].includes(op.status));
  if (index.length > 64) throw new Error('活动操作索引过多，不能省略运行状态后继续');
  const source = (op: OperationView) => {
    const privilege = op.privilege || op.authentication === 'succeeded' ? { ...(op.privilege ? { stage: op.privilege.stage, code: op.privilege.code,
      source: op.privilege.source, businessCommand: op.privilege.businessCommand, recovery: op.privilege.recovery } : {}), method: op.privilege?.method ?? 'sudo',
      scope: 'operation-only', loginAs: op.loginAs === undefined ? null : redactOutput(op.loginAs).slice(0, 128),
      runAs: op.runAs === undefined ? null : redactOutput(op.runAs).slice(0, 128), authentication: op.authentication } : undefined;
    return { operationId: op.id, hostId: op.hostId, kind: op.kind, status: op.status,
    readOnly: op.readOnly ?? null, effects: op.effects, exitCode: op.exitCode, createdAt: op.createdAt, privilege,
    sourceVersion: digest([op.id, op.hostId, op.kind, op.status, op.createdAt, op.readOnly, op.effects, op.exitCode,
      op.reconciledAt, op.reconciliation?.kind, op.reconciliation?.outcome, op.reconciliation?.evidenceOperationIds,
      op.outputCapture, privilege, digest(redactOutput(op.outputTail ?? ''))]),
    output: { truncated: op.outputCapture?.truncated ?? null,
      totalChars: op.outputCapture?.totalChars ?? null, tailChars: op.outputCapture?.tailChars ?? null,
      retrieval: { tool: 'read_operation_log', operationId: op.id, cursor: 0 }, availability: 'reauthorize-on-read; retention-not-guaranteed' } };
  };
  const ownedRound = mergeOperationViews(round).filter((op) => op.taskId === task.id);
  const latest = new Map<string, number>();
  ownedRound.forEach((op, i) => { if (op.status === 'succeeded' && op.readOnly !== true) latest.set(op.hostId, i); });
  if (latest.size > 16) throw new Error('变更主机索引过多，请缩小工作范围');
  const changes = [...latest].map(([hostId, i]) => ({ ...source(ownedRound[i]!),
    eligibleEvidence: ownedRound.slice(i + 1).filter((op) => op.hostId === hostId && op.kind === 'command'
      && op.status === 'succeeded' && op.readOnly === true && op.reconciliation?.kind !== 'risk-accepted').slice(-5).map(source) }));
  const intentIndex = { version: 1, revision: intent?.revision ?? 0, origin: intent?.origin ?? 'legacy',
    lastInputId: intent?.lastInputId, originalGoalBackground: excerpt(intent?.originalGoal ?? task.goal, 512),
    currentInput: excerpt(intent?.currentInput ?? task.goal, 1536),
    clarifications: (intent?.clarifications ?? []).slice(-4).map((item) => ({ id: item.id, ...excerpt(item.text, 256) })),
    omittedClarifications: Math.max(0, (intent?.clarifications.length ?? 0) - 4),
    authority: 'untrusted index, not approval; full intent at SafetyGate' };
  if (Buffer.byteLength(JSON.stringify(intentIndex), 'utf8') > NEXT_INPUT_FACT_TOKENS * 2) throw new Error('意图索引超出安全上限，请缩小范围');
  const facts = { version: 1, taskId: task.id, intentIndex,
    authoritativeOperations: state, inFlight: index.map(source), latestChanges: changes,
    recentResults: current.slice(-12).map(source), omittedOlderResults: Math.max(0, current.length - 12) };
  if (Buffer.byteLength(JSON.stringify(facts), 'utf8') > 49152) throw new Error('业务事实索引超出安全上下文上限，不会省略未决状态');
  return { ...facts, sourceVersion: digest(facts) };
}

/** One wire dictionary for repeated result sources; statuses/IDs remain intact. */
export function encodeBusinessFacts(facts: ReturnType<typeof requestBusinessFacts>): string {
  const sources = new Map(facts.recentResults.map((source) => [source.operationId, source]));
  for (const source of facts.inFlight) sources.set(source.operationId, source);
  for (const { eligibleEvidence, ...source } of facts.latestChanges) {
    sources.set(source.operationId, source);
    for (const evidence of eligibleEvidence) sources.set(evidence.operationId, evidence);
  }
  const status = new Map(facts.authoritativeOperations.references.map(({ id, ...reference }) => [id,
    { ...reference, operationId: id, sourceVersion: digest(reference) }]));
  const ids = new Set([...status.keys(), ...sources.keys()]);
  const resultSources = [...ids].map((id) => {
    const source = sources.get(id);
    // One common log protocol, not a repeated tool declaration/operation ID
    // in each row. All status flags survive the dictionary merge.
    const output = source ? { truncated: source.output.truncated, totalChars: source.output.totalChars, tailChars: source.output.tailChars } : undefined;
    return { ...status.get(id), ...source, output };
  });
  const columns = [...new Set(resultSources.flatMap((source) => Object.keys(source)))].sort()
    .filter((key) => resultSources.some((source) => (source as Record<string, unknown>)[key] !== undefined));
  const { authority: _authority, ...intentIndex } = facts.intentIndex;
  const intent = { ...intentIndex, originalGoalBackground: intentIndex.originalGoalBackground.sourceVersion === intentIndex.currentInput.sourceVersion
    ? { sameAs: 'currentInput' } : intentIndex.originalGoalBackground };
  return JSON.stringify({ ...facts, intentIndex: intent, authoritativeOperations: { ...facts.authoritativeOperations,
      references: 'resultSources' },
    recentResults: facts.recentResults.map((source) => source.operationId),
    inFlight: facts.inFlight.map((source) => source.operationId),
    latestChanges: facts.latestChanges.map((source) => ({ operationId: source.operationId, hostId: source.hostId,
      eligibleEvidenceOperationIds: source.eligibleEvidence.map((evidence) => evidence.operationId) })),
    ...(ids.size ? { logRetrieval: { tool: 'read_operation_log', operationIdColumn: 'operationId', cursor: 0,
      reauthorize: true, retention: 'not-guaranteed' } } : {}),
    resultSources: { columns, rows: resultSources.map((source) => columns.map((key) => (source as Record<string, unknown>)[key] ?? null)) } });
}
