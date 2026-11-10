import { describe, expect, it } from 'vitest';
import { OutputRedactor } from '../../packages/core/src/redaction.js';

function stream(chunks: string[], limit = 8192): string {
  const redactor = new OutputRedactor(limit);
  return chunks.map((chunk) => redactor.push(chunk)).join('') + redactor.finish();
}

describe('A04: redaction invariants across stream boundaries', () => {
  it.each(['password', 'authorization', 'cookie', 'verification_code'])('keeps multiline %s values private at every split', (name) => {
    const input = `${name}="SYNTHETIC_FIRST\nSYNTHETIC_LAST"\nordinary output\n`;
    const expected = stream([input]);
    for (let cut = 0; cut <= input.length; cut++) {
      const result = stream([input.slice(0, cut), input.slice(cut)]);
      expect(result).toBe(expected);
      expect(result).not.toMatch(/SYNTHETIC_FIRST|SYNTHETIC_LAST/u);
      expect(result).toContain('ordinary output');
    }
    expect(stream([...input])).toBe(expected);
  });

  it('strips split ANSI sequences before recognizing credential names and values', () => {
    const input = 'pass\x1b[0mword\x1b[31m="SYNTHETIC_ANSI_SECRET"\x1b[0m\nordinary\n';
    const expected = stream([input]);
    for (let cut = 0; cut <= input.length; cut++) {
      const result = stream([input.slice(0, cut), input.slice(cut)]);
      expect(result).toBe(expected); expect(result).not.toContain('SYNTHETIC_ANSI_SECRET');
    }
    expect(stream([...input])).toBe(expected);
  });

  it.each(['cookie', 'password'])('preserves %s quotation state after bounded-buffer overflow', (name) => {
    const input = `${name}="${'x'.repeat(160)}\nSYNTHETIC_OVERFLOW_TAIL"\nordinary output\n`;
    const expected = stream([input], 64);
    for (const chunks of [[input], [...input], [input.slice(0, 100), input.slice(100)],
      [input.slice(0, 64), input.slice(64, 170), input.slice(170)]]) {
      const result = stream(chunks, 64);
      expect(result).toBe(expected);
      expect(result).not.toContain('SYNTHETIC_OVERFLOW_TAIL');
      expect(result).toContain('REDACTED LONG'); expect(result).toContain('ordinary output');
    }
  });

  it('recognizes a later unclosed credential after an earlier closed one on the same line', () => {
    const input = 'token="first" cookie="SYNTHETIC_FIRST\nSYNTHETIC_LAST"\nordinary\n';
    for (const chunks of [[input], [...input]]) {
      const result = stream(chunks);
      expect(result).not.toMatch(/SYNTHETIC_FIRST|SYNTHETIC_LAST/u); expect(result).toContain('ordinary');
    }
  });

  it('does not expose incomplete quoted values through live snapshots', () => {
    const redactor = new OutputRedactor();
    redactor.push('password="SYNTHETIC_FIRST SYNTHETIC_LAST');
    expect(redactor.snapshotTail()).not.toMatch(/SYNTHETIC_FIRST|SYNTHETIC_LAST/u);
    expect(redactor.push('"\nordinary\n') + redactor.finish()).toContain('ordinary');
  });

  it.each([
    `password="${'x'.repeat(53)}\\"SYNTHETIC_ESCAPED\nSYNTHETIC_LAST"\nordinary\n`,
    `${'x'.repeat(70)} cookie="SYNTHETIC_FIRST\nSYNTHETIC_LAST"\nordinary\n`,
    `-----BEGIN ${'A'.repeat(140)} PRIVATE KEY-----\nSYNTHETIC_KEY_BODY\n-----END ${'A'.repeat(140)} PRIVATE KEY-----\nordinary\n`,
    `password='SYNTHETIC_FIRST\\'SYNTHETIC_LAST'\nordinary\n`,
    'pass\x1b]window-title\x07word="SYNTHETIC_OSC"\nordinary\n',
    `${'🙂'.repeat(60)}\nordinary\n`
  ])('keeps escape, marker and Unicode boundaries consistent: %#', (input) => {
    const expected = stream([input], 64);
    for (let cut = 0; cut <= input.length; cut++) {
      const result = stream([input.slice(0, cut), input.slice(cut)], 64);
      expect(result).toBe(expected); expect(result).not.toContain('SYNTHETIC_'); expect(result).toContain('ordinary');
    }
  });

  it('keeps overflow and private-key continuation bounded without leaking a later key fragment', () => {
    const redactor = new OutputRedactor(64);
    let result = redactor.push('-----BEGIN PRIVATE KEY-----\n');
    for (let index = 0; index < 128; index++) {
      result += redactor.push('x'.repeat(256));
      expect((redactor as unknown as { pending: string }).pending.length).toBeLessThanOrEqual(64);
      expect(redactor.snapshotTail()).not.toContain('xxxxx');
    }
    result += redactor.push('\nSYNTHETIC_KEY_TAIL\n-----END PRIVATE KEY-----\nordinary\n') + redactor.finish();
    expect(result).not.toContain('SYNTHETIC_KEY_TAIL'); expect(result).toContain('ordinary');
  });
});
