import type { OperationView } from '@cloudhelm/contracts';
const labels = {
  'authentication-required': '需要 sudo 私密认证', 'authentication-rejected': '认证被拒绝',
  'authentication-unconfirmed': '认证未完成或机制不兼容', 'authorization-denied': 'sudo 授权受限',
  'sudo-unavailable': 'sudo 程序不可用', cancelled: '认证已取消', timeout: '认证等待超时',
  'attempts-exhausted': '本次认证次数已用尽', 'transport-unavailable': '提权通道中断', unsupported: '认证或执行形式不支持'
};
/** Presentation only: never chooses an identity, retries or authorizes a command. */
export function PrivilegeFeedback({ value }: { value: OperationView['privilege'] }): React.JSX.Element | null {
  if (!value) return null;
  return <div role="status" aria-label="提权处理结果">
    <p>{value.method} · {labels[value.code]}</p>
    <small>{value.businessCommand === 'not-started' ? '后端确认业务命令未启动。' : '业务执行边界未确认，先核对结果，不重放。'}</small>
    {value.source === 'output-inference' && <p>此分类来自输出推断，不证明密码错误、业务未执行或整个账户没有 sudo 权限。</p>}
    <p>{value.recovery === 'confirm-alternative' ? '其他提权方式需要你明确确认，并重新审核操作；不会自动切换身份。'
      : value.code === 'authentication-required' ? '先核对原结果；必要时经正常审核提交不带-n的实际查询，由新操作按需私密认证，不重放变更。'
      : value.recovery === 'private-input' ? '仅在当前操作的私密认证框填写，不要发送到聊天。'
      : '请核对并处理原因后明确继续；旧凭据回答和成功操作不会自动重放。'}</p>
  </div>;
}
