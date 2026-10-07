import { describe, expect, it } from 'vitest';
import { OutputRedactor, redactOutput } from './redaction.js';

describe('sensitive output masking', () => {
  it('masks a secret split between SSH chunks before storage', () => {
    const redactor = new OutputRedactor();
    const first = redactor.push('token=very-se');
    const second = redactor.push('cret-value\n');
    expect(first + second).toBe('token=[REDACTED]\n');
  });

  it('masks multi-line private keys and bearer tokens', () => {
    const redactor = new OutputRedactor();
    const output = redactor.push('-----BEGIN PRIVATE KEY-----\nABCD\n-----END PRIVATE KEY-----\nAuthorization: Bearer abc123\n');
    expect(output).not.toContain('ABCD');
    expect(output).not.toContain('abc123');
    expect(redactOutput('password=abc')).toBe('password=[REDACTED]');
  });
});

it('redacts quoted config, JSON, OTP, nested keys and incomplete private keys', () => {
  const output = redactOutput(`{"apiKey":"two words","nested":{"token":"escaped\\\"value"}}
ADMIN_PASSWORD_HASH='scrypt$private words'
验证码：123456
-----BEGIN OPENSSH PRIVATE KEY-----
private-material`);
  for (const secret of ['two words', 'escaped', 'scrypt', '123456', 'private-material']) expect(output).not.toContain(secret);
});

it('redacts a quoted JSON credential split across data chunks', () => {
  const redactor = new OutputRedactor();
  expect(redactor.push('{"apiKey":"split ')).toBe('');
  expect(redactor.push('secret"}\n')).not.toContain('split');
});

it('does not leak continuation lines of a quoted credential', () => {
  const redactor = new OutputRedactor();
  const output = redactor.push('SECRET="first secret line\n') + redactor.push('second secret line\n')
    + redactor.push('last secret line"\nnormal output\n') + redactor.finish();
  expect(output).not.toContain('secret line'); expect(output).toContain('normal output');
});
