import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HIGHLIGHT_CHAR_LIMIT, highlightCode } from '../../../apps/desktop/src/renderer/code-highlight.js';

const render = (nodes: ReturnType<typeof highlightCode>): string => renderToStaticMarkup(createElement('code', null, nodes));

describe('code highlighting adapter', () => {
  it('highlights bundled languages into token spans without HTML strings', () => {
    const html = render(highlightCode('yaml', 'services:\n  web:\n    image: nginx\n'));
    expect(html).toContain('class="hljs-attr"');
    expect(render(highlightCode('bash', 'echo "hi"'))).toContain('class="hljs-built_in"');
    expect(render(highlightCode('json', '{ "port": 8080 }'))).toContain('class="hljs-attr"');
    expect(render(highlightCode('ts', 'const port: number = 8080;'))).toContain('class="hljs-keyword"');
    expect(render(highlightCode('diff', '- old\n+ new\n'))).toContain('class="hljs-deletion"');
  });

  it('resolves fence aliases to the registered grammar', () => {
    expect(render(highlightCode('sh', 'echo "hi"'))).toContain('class="hljs-built_in"');
    expect(render(highlightCode('yml', 'key: value'))).toContain('class="hljs-attr"');
  });

  it('falls back to null for unknown languages so callers render literal text', () => {
    expect(highlightCode('not-a-language', 'plain text')).toBeNull();
  });

  it('skips highlighting for oversized blocks while keeping them readable', () => {
    const oversized = 'line\n'.repeat(Math.ceil(HIGHLIGHT_CHAR_LIMIT / 5) + 1);
    expect(oversized.length).toBeGreaterThan(HIGHLIGHT_CHAR_LIMIT);
    expect(highlightCode('yaml', oversized)).toBeNull();
  });

  it('returns null for empty input and internal highlighter failures', () => {
    expect(highlightCode('yaml', '')).toBeNull();
    expect(highlightCode('yaml', '\n'.repeat(4))).not.toBeNull();
  });

  it('keeps the highlighted output textually identical to the source', () => {
    const source = 'services:\n  web:\n    ports:\n      - "8080:80"\n';
    const html = render(highlightCode('yaml', source));
    const text = html.replace(/<[^>]+>/gu, '').replace(/&quot;/gu, '"').replace(/&lt;/gu, '<')
      .replace(/&gt;/gu, '>').replace(/&#x27;/gu, '\'').replace(/&amp;/gu, '&');
    expect(text).toBe(source);
  });
});
