import { expect, it } from 'vitest';
import type { OperationView, TaskIntentState, TaskView } from '@cloudhelm/contracts';
import { encodeBusinessFacts, NEXT_INPUT_FACT_TOKENS, requestBusinessFacts } from './request-business-facts.js';
const task = { id: 'task', goal: 'Original background', localScopes: [], hostIds: ['host'] } as unknown as TaskView;
const op = (id: string, values: Partial<OperationView> = {}): OperationView => ({ id, taskId: 'task', hostId: 'host', kind: 'command',
  preview: 'UNTRUSTED_COMMAND_DO_NOT_COPY', outputTail: 'UNTRUSTED_BODY_DO_NOT_COPY', createdAt: 1,
  status: 'succeeded', readOnly: true, effects: 'none', ...values });
const intent: TaskIntentState = { version: 1, revision: 2, originalGoal: 'Original background', currentInput: 'Only inspect', origin: 'explicit', clarifications: [] };
function decode(facts: ReturnType<typeof requestBusinessFacts>) {
  const wire = JSON.parse(encodeBusinessFacts(facts));
  const { columns, rows } = wire.resultSources as { columns: string[]; rows: unknown[][] };
  return { ...wire, resultSources: rows.map((row) => Object.fromEntries(columns.map((key, i) => [key, row[i]]))) } as {
    sourceVersion: string; resultSources: Array<{ operationId: string }>;
    recentResults: string[]; inFlight: string[]; latestChanges: Array<{ operationId: string; eligibleEvidenceOperationIds: string[] }> };
}
it('keeps every unresolved and in-flight ID with current resolution state, without copying output or changing history', () => {
  const unknown = op('old-unknown', { status: 'unknown', readOnly: false, effects: 'possible' });
  const running = op('old-live-query', { status: 'running' });
  const accepted = op('accepted', { status: 'failed', readOnly: false, effects: 'possible', reconciledAt: 2,
    reconciliation: { kind: 'risk-accepted', at: 2, explanation: 'DO_NOT_COPY_ACCEPTANCE' } });
  const ops = [unknown, running, ...Array.from({ length: 80 }, (_, i) => op(`new-${i}`)), accepted];
  const original = structuredClone(ops); const facts = requestBusinessFacts(task, ops, ops, intent);
  expect(facts.authoritativeOperations.unresolvedOperationIds).toEqual(['old-unknown']);
  expect(facts.inFlight.map((item) => item.operationId)).toEqual(['old-live-query']);
  expect(facts.authoritativeOperations.references.find((item) => item.id === 'accepted')).toMatchObject({
    status: 'failed', needsVerification: false, reconciliation: { kind: 'risk-accepted' } });
  const encoded = JSON.stringify(facts);
  for (const text of ['UNTRUSTED_COMMAND_DO_NOT_COPY', 'UNTRUSTED_BODY_DO_NOT_COPY', 'DO_NOT_COPY_ACCEPTANCE']) expect(encoded).not.toContain(text);
  expect(facts.recentResults).toHaveLength(12); expect(facts.omittedOlderResults).toBe(71); expect(ops).toEqual(original);
  const wire = decode(facts);
  expect(wire.resultSources.find((source) => source.operationId === 'old-unknown')).toMatchObject({
    needsVerification: true, canReconcile: true, status: 'unknown', effects: 'possible' });
  expect(wire.resultSources.find((source) => source.operationId === 'accepted')).toMatchObject({
    needsVerification: false, canReconcile: false, reconciliation: { kind: 'risk-accepted' } });
});
it('indexes only checks after each latest change on its own host and refuses foreign-task evidence', () => {
  const ops = [op('old-check'), op('change', { readOnly: false }), op('earlier-evidence'),
    op('cleanup', { readOnly: false }), op('failed-check', { status: 'failed' }), op('latest-check'),
    op('other-task', { taskId: 'other' }), op('other-host', { hostId: 'other-host' })];
  const facts = requestBusinessFacts(task, ops, ops, intent);
  expect(facts.latestChanges).toHaveLength(1);
  expect(facts.latestChanges[0]).toMatchObject({ operationId: 'cleanup', eligibleEvidence: [{ operationId: 'latest-check' }] });
  expect(JSON.stringify(facts)).not.toContain('other-task');
});
it('discloses bounded intent excerpts and omitted clarification count while retaining full source versions', () => {
  const full: TaskIntentState = { ...intent, originalGoal: '中😀'.repeat(5000), currentInput: '\n"中😀'.repeat(6000),
    clarifications: Array.from({ length: 9 }, (_, i) => ({ id: `answer-${i}`, text: '回答'.repeat(1000) })) };
  const before = structuredClone(full); const facts = requestBusinessFacts(task, [], [], full);
  expect(facts.intentIndex.currentInput.truncated).toBe(true); expect(facts.intentIndex.originalGoalBackground.truncated).toBe(true);
  expect(facts.intentIndex.clarifications).toHaveLength(4); expect(facts.intentIndex.omittedClarifications).toBe(5);
  expect(Buffer.byteLength(JSON.stringify(facts.intentIndex), 'utf8')).toBeLessThanOrEqual(NEXT_INPUT_FACT_TOKENS * 2);
  expect(facts.intentIndex.currentInput.text).not.toContain('\ufffd'); expect(full).toEqual(before);
  const constrained = requestBusinessFacts(task, [], [], { ...intent, currentInput: `HEAD constraint. ${'background '.repeat(2000)} TAIL never restart production.` });
  expect(constrained.intentIndex.currentInput.text).toContain('HEAD constraint.');
  expect(constrained.intentIndex.currentInput.text).toContain('TAIL never restart production.');
  const changed = requestBusinessFacts(task, [], [], { ...full, currentInput: `${full.currentInput.slice(0, 15000)}changed in omitted middle${full.currentInput.slice(15000)}` });
  expect(changed.intentIndex.currentInput.text).toBe(facts.intentIndex.currentInput.text);
  expect(changed.sourceVersion).not.toBe(facts.sourceVersion);
});
it('includes output version, truncation and owned retrieval address without promising log availability', () => {
  const observation = op('log', { outputCapture: { totalChars: 100000, tailChars: 100, truncated: true } });
  const first = requestBusinessFacts(task, [observation], [], intent);
  expect(first.recentResults[0]).toMatchObject({ output: { truncated: true, totalChars: 100000,
    retrieval: { tool: 'read_operation_log', operationId: 'log', cursor: 0 }, availability: 'reauthorize-on-read; retention-not-guaranteed' } });
  const same = requestBusinessFacts(task, [structuredClone(observation)], [], structuredClone(intent));
  expect(same.sourceVersion).toBe(first.sourceVersion);
  expect(Buffer.from(first.sourceVersion, 'base64url')).toHaveLength(32); // Full SHA-256, not a shortened fingerprint.
  const updated = requestBusinessFacts(task, [{ ...observation, outputTail: 'new redacted observation' }], [], intent);
  expect(updated.recentResults[0]?.sourceVersion).not.toBe(first.recentResults[0]?.sourceVersion);
});
it('fails closed on oversized safety facts instead of dropping old unknown/live IDs', () => {
  expect(() => requestBusinessFacts(task, Array.from({ length: 65 }, (_, i) => op(`pending-${i}`, { status: 'unknown', readOnly: false })), [], intent)).toThrow('未决操作引用过多');
  expect(() => requestBusinessFacts(task, Array.from({ length: 65 }, (_, i) => op(`running-${i}`, { status: 'running' })), [], intent)).toThrow('活动操作索引过多');
});
it('encodes each result source once while preserving every evidence and in-flight pointer', () => {
  const ops = [op('change', { readOnly: false }), op('check'), op('live', { status: 'running' })];
  const facts = requestBusinessFacts(task, ops, ops, intent);
  const wire = decode(facts);
  const ids = wire.resultSources.map((source) => source.operationId);
  expect(ids).toHaveLength(3); expect(new Set(ids).size).toBe(3); expect(wire.sourceVersion).toBe(facts.sourceVersion);
  expect(wire.latestChanges).toEqual([{ operationId: 'change', hostId: 'host', eligibleEvidenceOperationIds: ['check'] }]);
  for (const id of [...wire.recentResults, ...wire.inFlight, ...wire.latestChanges.flatMap((change) => [change.operationId, ...change.eligibleEvidenceOperationIds])]) expect(ids).toContain(id);
});
it('redacts recognizable credentials even inside intent excerpts', () => {
  const facts = requestBusinessFacts(task, [], [], { ...intent, currentInput: 'password=fixture-secret-token' });
  expect(JSON.stringify(facts)).not.toContain('fixture-secret-token');
});
