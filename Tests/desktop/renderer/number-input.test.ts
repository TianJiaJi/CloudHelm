import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { NumberInput } from '../../../apps/desktop/src/renderer/number-input.js';

it.each([Number.NaN, Infinity, -Infinity])('renders an invalid numeric draft as empty, not zero (%s)', (value) => {
  const html = renderToStaticMarkup(createElement(NumberInput, { value, required: true, min: 1, max: 65535, onValueChange: () => {} }));
  expect(html).toContain('value=""');
  expect(html).toContain('required=""');
  expect(html).toContain('type="number"');
  expect(html).not.toContain('value="0"');
});

it.each([0, 22, 2222, 65535])('preserves an explicitly entered number (%s)', (value) => {
  expect(renderToStaticMarkup(createElement(NumberInput, { value, onValueChange: () => {} })))
    .toContain(`value="${value}"`);
});
