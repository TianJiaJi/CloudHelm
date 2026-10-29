import { operationIntentKey, type CommandAnalyzer, type ProposedOperation } from '@cloudhelm/core';
import { operationNeedsVerification, type OperationView, type TaskView, type VerificationReport } from '@cloudhelm/contracts';
import { verificationSource } from '../worker/verification-source.js';
import { WorkJournal } from '../worker/work-journal.js';
import { hasJournalCredentials } from '../worker/journal-secrets.js';

/** The preview is usable only if its complete command/host/identity/cwd matches the original replay digest.
 * This grants no read-only capability, authorization, execution or outcome resolution. */
function recordedCommand(operation: OperationView): Extract<ProposedOperation, { kind: 'command' }> | undefined {
  const cwd = operation.commandSource?.cwd;
  if (operation.kind !== 'command' || operation.commandSource?.version !== 1 || !cwd?.startsWith('/')
    || !operation.runAs || !operation.loginAs || !/^[a-f0-9]{64}$/u.test(operation.intentKey ?? '')
    || !operation.preview || operation.preview.includes('[REDACTED') || hasJournalCredentials(operation.preview)) return;
  const proposed: Extract<ProposedOperation, { kind: 'command' }> = { id: operation.id, kind: 'command', command: operation.preview,
    scope: { taskId: operation.taskId, hostId: operation.hostId, cwd, runAs: operation.runAs, loginAs: operation.loginAs,
      terminalId: '', terminalGeneration: 0, policyRevision: 0, allowedWorkingRoots: [], protectedPaths: [], goal: '' } };
  return operationIntentKey(proposed) === operation.intentKey ? proposed : undefined;
}

/** Offline, explicit re-projection of an automatic report. No runtime, SSH, model or log port is accepted. */
export async function rebuildRecordedVerification(task: TaskView, operations: OperationView[], analyzer: CommandAnalyzer): Promise<VerificationReport> {
  const round = task.verificationRound;
  if (task.status !== 'answered' || task.report?.facts?.registration !== 'automatic' || !round?.closed
    || task.report.facts.roundId !== round.id) throw new Error('只能重新整理已结束且轮次完整的后端自动报告；不会启动或继续任务。');
  if (operations.some((op) => op.taskId !== task.id)) throw new Error('报告记录不属于该对话。');
  if (operations.some((op) => operationNeedsVerification(op) || ['proposed', 'approved', 'running'].includes(op.status)))
    throw new Error('仍有运行中或未决操作，请先按原安全流程处理；重新整理不能解除结果锁。');
  if (round.operationIds.length > 256) throw new Error('本轮记录过多，暂不支持自动重整；原报告保留，不会截断后判为通过。');
  const records = structuredClone(operations);
  const membership = new Set(round.operationIds);
  if (round.operationIds.some((id) => !records.some((op) => op.id === id))) throw new Error('本轮操作记录不完整，无法重新整理。');
  for (const operation of records) {
    if (!membership.has(operation.id) || operation.verificationSource) continue;
    const command = recordedCommand(operation);
    if (!command) continue;
    try { await analyzer.analyze(command.command); }
    catch { throw new Error('已有命令暂时无法解析；未修改报告，也未执行任何操作。'); }
    operation.verificationSource = await verificationSource(command, analyzer);
  }
  const journal = new WorkJournal(task.id, () => records, () => {}, async () => { throw new Error('Offline reports cannot read logs'); },
    undefined, undefined, () => round.operationIds.map((id) => records.find((op) => op.id === id)!), () => round.id, task.report);
  const report = journal.finalize(round.id);
  if (!report) throw new Error('没有可重新整理的执行记录。');
  return structuredClone(report);
}
