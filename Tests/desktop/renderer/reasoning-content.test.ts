import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ReasoningContent } from '../../../apps/desktop/src/renderer/reasoning-content.js';

it.each(['thinking', 'summary'] as const)('renders %s reasoning collapsed by default', (kind) => {
  const html = renderToStaticMarkup(createElement(ReasoningContent, {
    value: { kind, status: 'complete', text: 'private reasoning content' }
  }));
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain('private reasoning content');
  expect(html).toContain(kind === 'summary' ? '思考摘要' : '思考内容');
  expect(html).toContain('思考过程');
  expect(html).toContain(`aria-label="展开${kind === 'summary' ? '思考摘要' : '思考内容'}"`);
});

it('shows elapsed time only for a real in-flight reasoning response', () => {
  const render = (status: 'streaming' | 'complete') => renderToStaticMarkup(createElement(ReasoningContent, {
    value: { kind: 'thinking', status, text: '' }, startedAt: 1_000, now: 4_000
  }));
  expect(render('streaming')).toContain('已等待 3 秒');
  expect(render('streaming')).toContain('(3s)');
  expect(render('complete')).not.toContain('已等待');
});

it('does not invent reasoning when the backend did not return it', () => {
  expect(renderToStaticMarkup(createElement(ReasoningContent, {}))).toBe('');
});
