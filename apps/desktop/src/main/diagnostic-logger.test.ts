import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticLogger, diagnosticSettings } from './diagnostic-logger.js';
import { eventDiagnostic } from '../worker/diagnostic-events.js';
import { safeDiagnostic } from '@cloudhelm/core';
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'cloudhelm-log-')); dirs.push(dir); return dir; }

describe('development diagnostics', () => {
  it('enables dev by default and keeps production off unless explicitly configured', () => {
    expect(diagnosticSettings(true, {}, '/data').level).toBe('debug');
    expect(diagnosticSettings(false, {}, '/data').level).toBe('off');
    expect(diagnosticSettings(false, { CLOUDHELM_LOG_LEVEL: 'info', CLOUDHELM_LOG_DIR: '/logs' }, '/data')).toEqual({ level: 'info', directory: '/logs' });
  });
  it('writes both sinks, masks secrets and rotates at most five private files', async () => {
    const dir = await directory(); const lines: string[] = [];
    const logger = new DiagnosticLogger({ level: 'debug', directory: dir }, (line) => lines.push(line), 700);
    for (let index = 0; index < 30; index++) logger.write({ event: 'chat', taskId: 'task', operationId: `op-${index}`, text: `{"apiKey":"private value"} password='two words' ${'x'.repeat(100)}` });
    const files = await readdir(dir); expect(files).toHaveLength(5);
    const text = (await Promise.all(files.map((name) => readFile(join(dir, name), 'utf8')))).join('');
    expect(text).toContain('op-29'); expect(text).not.toContain('private value'); expect(text).not.toContain('two words');
    expect(lines.join('')).not.toContain('private value');
    if (process.platform !== 'win32') {
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(dir, files[0]!))).mode & 0o777).toBe(0o600);
    }
  });
  it('uses a field allowlist and excludes auth, raw terminal and file contents', () => {
    expect(safeDiagnostic({ event: 'safe', password: 'secret', apiKey: 'secret', answer: 'secret' } as any)).toEqual({ event: 'safe', level: 'debug' });
    expect(eventDiagnostic({ event: { type: 'terminal-data', terminalId: 't', data: 'raw-secret' } })).toBeUndefined();
    const record = eventDiagnostic({ event: { type: 'operation', value: { id: 'o', hostId: 'h', taskId: 't', kind: 'write-file', preview: 'private file body', outputTail: 'private body', status: 'succeeded', createdAt: 1 } } });
    expect(JSON.stringify(record)).not.toContain('private');
    const auth = eventDiagnostic({ event: { type: 'input-open', value: { id: 'i', taskId: 't', hostId: 'h', operationId: 'o', title: 'auth', explanation: 'server prompt', kind: 'secret', expiresAt: 1 } } });
    expect(JSON.stringify(auth)).not.toContain('server prompt');
  });
  it('does not throw or repeatedly warn when the disk sink fails', async () => {
    const dir = await directory(); const file = join(dir, 'file'); await writeFile(file, 'x');
    const output = vi.fn(); const logger = new DiagnosticLogger({ level: 'debug', directory: file }, output);
    expect(() => { logger.write({ event: 'one' }); logger.write({ event: 'two' }); }).not.toThrow();
    expect(output.mock.calls.filter(([line]) => line.includes('写入失败'))).toHaveLength(1);
  });
});
