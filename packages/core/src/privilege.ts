export type PrivilegeMethod = 'sudo' | 'ssh' | 'su';
export interface PrivilegeFeedback {
  method: PrivilegeMethod;
  stage: 'preparation' | 'authentication' | 'authorization' | 'execution';
  code: 'authentication-required' | 'authentication-rejected' | 'authentication-unconfirmed' | 'authorization-denied'
    | 'sudo-unavailable' | 'cancelled' | 'timeout' | 'attempts-exhausted' | 'transport-unavailable' | 'unsupported';
  source: 'transport' | 'output-inference';
  businessCommand: 'not-started' | 'unknown';
  recovery: 'private-input' | 'confirm-alternative' | 'user-action' | 'verify';
}
/** Safe structured failure only. Never wrap remote output or credential-bearing errors. */
export class PrivilegeError extends Error {
  constructor(readonly feedback: PrivilegeFeedback) { super(`Privilege identity/context unavailable (${feedback.method}: ${feedback.code})`); }
}
export function privilegeGuidance(feedback: PrivilegeFeedback): string {
  if (feedback.code === 'authentication-required') return '非交互sudo报告需要认证，不等于密码被拒绝。此为输出推断，不能据此证明业务未启动或清除可能副作用；先核对原结果。仅对已证明effect-free的查询，可经正常审核提交不带-n的实际命令，按需私密认证；不要探测或重放变更。';
  const reason = {
    'authentication-required': 'sudo 需要私密认证。',
    'authentication-rejected': '认证被拒绝；这不能证明具体是哪项凭据或账户策略有误。',
    'authentication-unconfirmed': '认证未完成或认证机制不兼容，无法确定是否为密码错误。',
    'authorization-denied': '观察到 sudo 授权限制；可能仅针对当前命令，不代表不在某个用户组。',
    'sudo-unavailable': '执行通道确认 sudo 程序不可用。',
    cancelled: '认证已取消或输入已失效。', timeout: '认证等待超时。',
    'attempts-exhausted': '本次操作的认证次数已用尽。',
    'transport-unavailable': '提权执行通道已中断。', unsupported: '当前认证或执行形式不受支持。'
  }[feedback.code];
  return `${reason}${feedback.source === 'output-inference' ? ' 此分类来自输出推断，不是业务未启动的证明。' : ''} `
    + (feedback.recovery === 'private-input' ? '请通过当前操作的私密通道输入，AI不可见。'
      : feedback.recovery === 'confirm-alternative' ? '其他身份方案须由用户明确确认并重新审核；不要自动换身份或重放。'
      : feedback.recovery === 'verify' ? '请先核验原操作结果，不重放。'
      : '已暂停；请处理后点击继续AI或明确发送下一步指令，不自动重试或切换身份。');
}
