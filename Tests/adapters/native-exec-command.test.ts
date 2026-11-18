import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { renderNativeExecCommand } from '../../packages/adapters/src/native-exec-command.js';

const input = { cwd: '/tmp/safe dir', envPath: '/usr/bin/env', shellPath: '/bin/sh' };

it('requires observed absolute executables and a bounded safe cwd and command', () => {
  expect(() => renderNativeExecCommand({ ...input, envPath: 'env', command: 'id -u' })).toThrow('observed absolute');
  expect(() => renderNativeExecCommand({ ...input, shellPath: '/bin/sh; id', command: 'id -u' })).toThrow('observed absolute');
  expect(() => renderNativeExecCommand({ ...input, cwd: '-x', command: 'id -u' })).toThrow('safe absolute cwd');
  expect(() => renderNativeExecCommand({ ...input, cwd: '/tmp/\nlog', command: 'id -u' })).toThrow('safe absolute cwd');
  expect(() => renderNativeExecCommand({ ...input, command: 'printf x\u0000' })).toThrow('contains NUL');
  expect(() => renderNativeExecCommand({ ...input, command: 'x'.repeat(8193) })).toThrow('exceeds the limit');
});

it('quotes nested shell data without interpreting paths or command text in the outer shell', () => {
  const rendered = renderNativeExecCommand({ ...input, cwd: "/tmp/a'b", command: "printf '%s' 'x y'" });
  expect(rendered).toContain('env -i PATH=');
  expect(rendered).toContain('LC_ALL=C /bin/sh -c ');
  if (spawnSync('sh', ['-c', 'exit 0']).status === 0)
    expect(spawnSync('sh', ['-n', '-c', rendered]).status).toBe(0);
});

(spawnSync('sh', ['-c', 'exit 0']).status === 0 ? it : it.skip)('runs a quoted command in a clean child environment', () => {
  const command = renderNativeExecCommand({ ...input, cwd: '/', command: "printf '%s\\n' \"${INJECTED-unset}\"; printf '%s\\n' \"a'b\"" });
  const result = spawnSync('sh', ['-c', command], { encoding: 'utf8', env: { ...process.env, INJECTED: 'untrusted' } });
  expect(result.status).toBe(0);
  expect(result.stdout.trim().split(/\r?\n/u)).toEqual(['unset', "a'b"]);
});
