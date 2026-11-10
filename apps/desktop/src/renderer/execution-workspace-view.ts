import type { AppSnapshot, ExecutionJobView, OperationView, RequestObservation, TerminalViewState } from '@cloudhelm/contracts';

export function jobLabel(job: ExecutionJobView): string {
  if (job.exitObserved) return `${job.status === 'failed' ? '进程失败，已观察退出' : '已观察退出'} · ${job.exitCode ?? '退出码未知'}`;
  if (job.notStarted) return '已确认未启动';
  if (job.status === 'unknown') return '结果未知 · 待核验';
  if (job.status === 'stop-requested' || job.stopRequestId) return '已请求停止 · 尚未确认退出';
  return ({ starting: '等待可信启动', running: '后台运行 · 健康未确认', unknown: '结果未知 · 待核验',
    failed: '执行失败 · 核验影响', exited: '退出未确认' } as Record<string, string>)[job.status] ?? '状态未知';
}
export function jobNeedsAttention(operation: OperationView): boolean {
  const job = operation.executionJob;
  return !!job && (!job.exitObserved && !job.notStarted || job.status === 'failed' || job.status === 'unknown');
}
export function terminalPresentation(terminal: TerminalViewState, snapshot: Pick<AppSnapshot, 'operations' | 'conversations'>): { label: string; title: string } {
  const operations = snapshot.operations.filter((operation) => operation.logRef === terminal.id || operation.executionJob?.terminalId === terminal.id);
  const occupied = operations.find((operation) => jobNeedsAttention(operation) || ['running', 'approved', 'proposed', 'unknown'].includes(operation.status));
  const owner = terminal.state === 'human' || terminal.replacementTerminalId ? '人工' : terminal.taskId ? 'AI' : '终端';
  const purpose = occupied?.executionJob ? '后台进程' : occupied ? occupied.readOnly === true ? '只读诊断' : occupied.readOnly === false ? '变更执行' : '操作' : '无已登记运行操作';
  const state = terminal.state === 'suspended' ? '已挂起' : terminal.state === 'closed' ? '已关闭' : occupied?.executionJob ? jobLabel(occupied.executionJob)
    : occupied?.status === 'unknown' ? '待核验' : occupied ? '占用中' : '已绑定';
  const task = snapshot.conversations.find((item) => item.id === terminal.taskId);
  return { label: `${owner} · ${occupied ? purpose : state}`, title: `${owner} · ${purpose} · ${state}\n终端 ${terminal.id}${task ? `\n会话 ${task.goal}` : ''}${occupied ? `\n操作 ${occupied.id}` : ''}` };
}
export function requestCost(value: RequestObservation): string {
  if (!value.cost || value.cost.source === 'unknown' || value.cost.usd === null) return '费用未知';
  return `$${value.cost.usd.toFixed(6)} · ${value.cost.source === 'provider' ? '供应商报告' : '目录估算，非账单'}`;
}
