import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ReasoningContent } from './reasoning-content.js';

it.each(['thinking', 'summary'] as const)('renders %s reasoning collapsed by default', (kind) => {
  const html = renderToStaticMarkup(createElement(ReasoningContent, {
    value: { kind, status: 'complete', text: 'private reasoning content' }
  }));
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain('private reasoning content');
  expect(html).toContain(kind === 'summary' ? '思考摘要' : '思考内容');
});
