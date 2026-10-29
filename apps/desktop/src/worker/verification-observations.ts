import type { GoalCheck, OperationView, VerificationFacts } from '@cloudhelm/contracts';
import { completeOutput, confirmedNotStarted, evaluateRunOutput } from './verification-output.js';

/** Recovery describes a later successful run, never changes the original attempt or releases a lock. */
export function executionSummary(operations: OperationView[]): Pick<VerificationFacts, 'execution' | 'recoveredAttemptIds'> {
  const recoveredAttemptIds = operations.flatMap((operation, index) => {
    const source = operation.verificationSource;
    if (!confirmedNotStarted(operation) || source?.kind !== 'program-run' || operation.completedAt === undefined) return [];
    return operations.slice(index + 1).some((later) => later.hostId === operation.hostId
      && later.verificationSource?.kind === 'program-run' && later.verificationSource.identity === source.identity
      && later.createdAt >= operation.completedAt! && later.status === 'succeeded' && later.exitObserved && later.exitCode === 0
      && later.reconciliation?.kind !== 'evidence') ? [operation.id] : [];
  });
  const recovered = new Set(recoveredAttemptIds);
  const execution = !operations.length ? 'none' : operations.some((op) => ['unknown', 'running', 'proposed', 'approved'].includes(op.status)
    || op.reconciliation?.kind === 'evidence' && !op.exitObserved) ? 'unknown'
    : operations.some((op) => ['failed', 'denied'].includes(op.status) && !recovered.has(op.id)) ? 'failed'
    : recovered.size ? 'succeeded-after-retry' : 'succeeded';
  return { execution, recoveredAttemptIds };
}

/** Completion observations prove an execution record, not whether its output satisfies the user's business goal. */
export function automaticRunChecks(operations: OperationView[], supplied: GoalCheck[], recoveredAttemptIds: string[]): GoalCheck[] {
  const recovered = new Set(recoveredAttemptIds);
  const declared = new Set(operations.filter((op) => op.outputExpectation).map((op) => op.id));
  const explicit = supplied.filter((check) => !(check.kind === 'run-output'
    && check.operationIds.some((id) => recovered.has(id) || declared.has(id))));
  const result: GoalCheck[] = [...explicit];
  for (const operation of operations) {
    if (operation.kind !== 'command' || recovered.has(operation.id)) continue;
    if (operation.outputExpectation) {
      result.push({ ...evaluateRunOutput(operation, { kind: 'run-output', operationId: operation.id, ...operation.outputExpectation }),
        expectationSource: 'before-execution' });
      continue;
    }
    if (explicit.some((check) => check.kind === 'run-output' && check.operationIds.includes(operation.id))) continue;
    if (confirmedNotStarted(operation) || operation.reconciliation?.kind === 'evidence') continue;
    // Old records may lack a parsed program target. Non-read-only command output is still a real observation,
    // but never infer a command/path from its display preview.
    if (operation.verificationSource?.kind !== 'program-run' && (operation.readOnly === true || !operation.outputTail?.trim())) continue;
    const output = completeOutput(operation);
    const exited = operation.exitObserved && ['succeeded', 'failed'].includes(operation.status) && Number.isInteger(operation.exitCode);
    result.push({ kind: 'run-completion', authority: 'deterministic',
      target: operation.verificationSource?.kind === 'program-run' ? operation.verificationSource.path : `命令 ${operation.id}`,
      operationIds: [operation.id], expected: '运行真实结束、退出码为0并取得完整捕获输出；不比较输出内容是否符合任务要求。',
      observed: `退出码：${exited ? operation.exitCode : '未确认'}；${output === undefined ? '输出捕获不完整或未确认。' : `已记录完整输出：\n${output.slice(0, 16384)}`}`,
      status: exited && operation.exitCode !== 0 ? 'failed' : !exited || output === undefined ? 'inconclusive' : 'passed' });
  }
  return result;
}
