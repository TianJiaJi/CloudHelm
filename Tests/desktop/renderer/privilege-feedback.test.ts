import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { PrivilegeFeedback } from '../../../apps/desktop/src/renderer/privilege-feedback.js';
it('discloses inferred sudo restrictions without declaring no effects or choosing fallback', () => {
  const html = renderToStaticMarkup(createElement(PrivilegeFeedback, { value: { method: 'sudo', stage: 'authorization',
    code: 'authorization-denied', source: 'output-inference', businessCommand: 'unknown', recovery: 'confirm-alternative' } }));
  expect(html).toContain('sudo 授权受限'); expect(html).toContain('输出推断'); expect(html).toContain('需要你明确确认');
  expect(html).not.toContain('后端确认业务命令未启动');
});
it('shows transport-confirmed sudo absence and leaves legacy operations unchanged', () => {
  expect(renderToStaticMarkup(createElement(PrivilegeFeedback, { value: undefined }))).toBe('');
  const html = renderToStaticMarkup(createElement(PrivilegeFeedback, { value: { method: 'sudo', stage: 'preparation',
    code: 'sudo-unavailable', source: 'transport', businessCommand: 'not-started', recovery: 'confirm-alternative' } }));
  expect(html).toContain('sudo 程序不可用'); expect(html).toContain('后端确认业务命令未启动');
});
