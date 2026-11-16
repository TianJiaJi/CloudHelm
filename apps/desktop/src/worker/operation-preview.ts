import { createHash } from 'node:crypto';
import { redactOutput, type ProposedOperation } from '@cloudhelm/core';
export function operationPreview(operation: ProposedOperation): string {
  if (operation.kind === 'inspect-file') return `Inspect file ${redactOutput(operation.path)} (${operation.privilege ?? 'current'} identity${operation.recoveryDirectoryId ? ', bound recovery entry' : ''})`;
  if (operation.kind === 'command' && operation.probe) return `身份探测（后端自动预检，不计入业务完成）· ${redactOutput(operation.command)}`;
  if (operation.kind === 'command') return operation.processControl
    ? `请求停止后台任务 ${operation.processControl.jobId}（SIGINT，目标进程 ${operation.processControl.pid}；不是退出确认）` : redactOutput(operation.command);
  if (operation.kind === 'write-file') return operation.fileEdit
    ? `受控${operation.fileEdit.action === 'restore' ? '恢复' : '编辑'} ${redactOutput(operation.path)}\n身份：${operation.scope.runAs}\n源SHA256：${operation.expectedSha256}\n元数据：${operation.fileEdit.expectedMetadataDigest}\n提交SHA256：${createHash('sha256').update(operation.content).digest('hex')}\n原子交换，非跨进程CAS；竞争/断线时保留未知，不自动回放。\n${redactOutput(operation.fileEdit.diff)}`
    : `写入文件 ${operation.path} · ${Buffer.byteLength(operation.content)} 字节 · SHA-256 ${createHash('sha256').update(operation.content).digest('hex')}`;
  if (operation.kind === 'delete-path') return `删除文件 ${operation.path}`;
  if (operation.kind === 'list-recovery') return `枚举恢复材料 ${redactOutput(operation.path)}（只读元数据，${operation.privilege === 'root' ? 'root' : '当前'}身份）`;
  if (operation.kind === 'cleanup-recovery') return `清理恢复材料 ${redactOutput(operation.path)}：${operation.names.map((name) => redactOutput(name)).join('、')}`;
  return `上传 ${operation.localPath} → ${operation.remotePath}`;
}
