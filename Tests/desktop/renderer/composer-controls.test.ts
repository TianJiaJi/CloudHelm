import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HostView, TaskView } from '@cloudhelm/contracts';
import { ComposerFooter, PermissionPicker } from '../../../apps/desktop/src/renderer/composer-controls.js';

const host: HostView = {
  id: 'prod', label: '生产服务器', address: '192.0.2.10', port: 22, username: 'ubuntu', auth: 'agent',
  status: 'connected', defaultMode: 'ask', policyRevision: 1, protectedPaths: []
};
const conversation: TaskView = {
  id: 'chat', goal: '检查服务', hostIds: ['prod'], localScopes: [], status: 'running',
  provider: 'openai', modelId: 'test', requestCount: 1, requestLimit: 10, createdAt: 1, updatedAt: 1,
  reviewModesByHost: { prod: 'ai-review' }
};
const report = () => {};

describe('composer permission control', () => {
  it('projects the current conversation mode instead of the host default', () => {
    const html = renderToStaticMarkup(createElement(PermissionPicker, { host, conversation, legacy: false, report }));
    expect(html).toContain('权限选择，当前 AI 审核');
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain('Agent');
  });

  it('retains the host default and existing draft restriction before the first send', () => {
    const html = renderToStaticMarkup(createElement(PermissionPicker, { host, legacy: false, report }));
    expect(html).toContain('权限选择，当前 重要操作询问');
    expect(html).toContain('disabled=""');
    expect(html).toContain('发送后可切换当前对话的权限');
  });

  it('does not offer remote authorization without a host', () => {
    const html = renderToStaticMarkup(createElement(PermissionPicker, { conversation, legacy: false, report }));
    expect(html).toContain('未授权远端操作');
    expect(html).toContain('disabled=""');
  });

  it.each([
    { host, legacy: true },
    { host: { ...host, archived: true }, legacy: false }
  ])('keeps read-only and archived contexts disabled', (context) => {
    expect(renderToStaticMarkup(createElement(PermissionPicker, { ...context, conversation, report }))).toContain('disabled=""');
  });

  it('shows the actual fully accessible mode without changing its meaning', () => {
    const html = renderToStaticMarkup(createElement(PermissionPicker, {
      host, conversation: { ...conversation, reviewModesByHost: { prod: 'permissive' } }, legacy: false, report
    }));
    expect(html).toContain('权限选择，当前 完全访问');
  });

  it('leaves only context statistics and pending model information below the editor', () => {
    const html = renderToStaticMarkup(createElement(ComposerFooter, { pendingModel: 'next-model' }));
    expect(html).toContain('上下文用量');
    expect(html).toContain('下一次请求使用 next-model');
    expect(html).not.toContain('权限选择');
    expect(html).not.toContain('Agent');
  });
});
