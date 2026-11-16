import { redactOutput, type ApprovalRequest } from '@cloudhelm/core';

const reasons: Record<string, string> = {
  'privileged-file-read': '以独立认证的 root 身份读取有界文件，不修改文件',
  'privileged-file-edit': '按完整差异与源版本、身份、元数据绑定提交文件；密码走私密通道',
  'high-impact-command': '可能改变主机访问、服务可用性，或大范围删除数据',
  'high-impact-file': '目标文件涉及主机访问或安全配置',
  'privileged-recovery-listing': '以独立认证的 root 身份枚举恢复材料目录（只读元数据）',
  'recovery-cleanup': '显式删除命名的恢复材料，删除后不可恢复',
  'structured-file-read': '受控读取目标路径的元数据',
  'high-impact-script': '脚本涉及主机访问、可用性或大范围变更',
  'project-code-entry': '包管理或构建工具可能执行项目代码及生命周期脚本',
  'code-execution': '命令可能执行程序代码、钩子或安装脚本，不能仅按程序名称判断影响',
  'external-transfer': '命令可能向当前主机之外传输数据，需要核对接收方及数据范围',
  'uncertain-command': '无法可靠判断这条命令的实际影响',
  'script-uninspectable': '执行前无法安全读取脚本内容',
  'script-uncertain': '脚本包含无法可靠判断的操作',
  'ai-review-unavailable': '独立审核未完成，需要你判断',
  'ai-review-timeout': '独立审核等待超时且请求已中止，需要你判断',
  'ai-review-uncertain': '独立审核无法确定风险，需要你判断',
  'ai-denial-manual-review': '你要求对这条被独立审核拒绝的操作进行一次人工复核'
};

export function approvalPresentation(request: ApprovalRequest): { title: string; explanation: string; recovery: string } {
  const operation = request.operation;
  const label = operation.kind === 'command' ? '远程命令' : operation.kind === 'inspect-file' ? '受控文件读取' : operation.kind === 'write-file' ? '写入文件'
    : operation.kind === 'delete-path' ? '删除路径' : operation.kind === 'list-recovery' ? '恢复材料枚举'
    : operation.kind === 'cleanup-recovery' ? '恢复材料清理' : '上传文件';
  const detail = redactOutput(request.reason).replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 900);
  const summary = reasons[request.ruleId];
  const reason = summary ? `${summary}${detail && detail !== summary ? `；具体依据：${detail}` : ''}` : detail;
  return {
    title: `批准这次${label}`,
    explanation: `AI 请求执行下方的${label}。触发规则 ${request.ruleId}：${reason}。请根据显示的具体操作决定，批准仅适用于这一次。`,
    recovery: operation.kind === 'command' ? '执行后核验实际结果；若结果未知，先确认远端状态。'
      : '结构化文件操作会尝试保留恢复副本；执行后显示副本路径。'
  };
}
