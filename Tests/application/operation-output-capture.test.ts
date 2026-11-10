import { expect, it } from 'vitest';
import { OperationOutputCapture } from '../../packages/application/src/operation-output-capture.js';

it('counts redacted observations, never raw credential bytes', () => {
  const capture = new OperationOutputCapture();
  capture.push('password=fixture-'); capture.push('private-value\nvisible\n'); capture.finish();
  const safe = 'password=[REDACTED]\nvisible\n';
  expect(capture.snapshot()).toEqual({ stdoutTail: safe, outputCapture: { totalChars: safe.length, tailChars: safe.length, truncated: false } });
  expect(capture.text).not.toContain('fixture-private-value');
});
it('preserves conservative masking of long unterminated output rather than widening the privacy boundary', () => {
  const capture = new OperationOutputCapture();
  capture.push('sensitive-unbroken-value'.repeat(1000)); capture.finish();
  const safe = '[REDACTED LONG UNTERMINATED OUTPUT]\n';
  expect(capture.snapshot()).toEqual({ stdoutTail: safe, outputCapture: { totalChars: safe.length, tailChars: safe.length, truncated: false } });
});
it('applies the same long-line guard even when a newline arrives in the same chunk', () => {
  const input = 'x'.repeat(80000) + '\n';
  const whole = new OperationOutputCapture(), split = new OperationOutputCapture();
  whole.push(input); whole.finish();
  for (let start = 0; start < input.length; start += 1000) split.push(input.slice(start, start + 1000));
  split.finish();
  expect(whole.snapshot()).toEqual(split.snapshot());
  expect(whole.text).toBe('[REDACTED LONG UNTERMINATED OUTPUT]\n');
});
it('returns immutable observation snapshots while later output continues to be counted', () => {
  const capture = new OperationOutputCapture();
  // Many bounded lines exercise capture-tail truncation, not the redactor's long-line guard.
  const first = `${'🙂'.repeat(4000)}\n`.repeat(10);
  capture.push(first);
  const before = capture.snapshot();
  capture.push('late\n'); capture.finish();
  const after = capture.snapshot();
  expect(before.outputCapture.totalChars).toBe(first.length);
  expect(after.outputCapture.totalChars).toBe(first.length + 5);
  expect(after.stdoutTail).toContain('late\n');
  expect(after.outputCapture.truncated).toBe(true);
  expect(after.stdoutTail.length).toBeLessThanOrEqual(16384);
  expect(Buffer.from(after.stdoutTail).toString()).toBe(after.stdoutTail);
  expect(before.stdoutTail).not.toContain('late');
});
