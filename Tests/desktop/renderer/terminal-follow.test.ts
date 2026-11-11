import { expect, it } from 'vitest';
import { atViewportTail } from '../../../apps/desktop/src/renderer/terminal-follow.js';

it('keeps following only while the reader is at the live tail', () => {
  expect(atViewportTail(120, 120)).toBe(true);
  expect(atViewportTail(119, 120)).toBe(true); // sub-row rounding after a resize
  expect(atViewportTail(80, 120)).toBe(false); // reading scrollback
  expect(atViewportTail(0, 0)).toBe(true);
});

it('treats an unusable buffer position as following rather than freezing the view', () => {
  expect(atViewportTail(Number.NaN, 10)).toBe(true);
  expect(atViewportTail(10, Number.POSITIVE_INFINITY)).toBe(true);
});
