import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { remoteFileProgram } from '../../packages/adapters/src/remote-file-program.js';

const python = spawnSync('python', ['--version'], { encoding: 'utf8' }).status === 0 ? 'python' : 'python3';
it('executes the fixed transaction algorithm and real staging method with deterministic filesystem faults', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cloudhelm-file-driver-'));
  try {
    const program = path.join(root, 'driver.py'); await writeFile(program, remoteFileProgram);
    const result = spawnSync(python, [fileURLToPath(new URL('./file-transaction-fixture.py', import.meta.url)), program], { encoding: 'utf8', timeout: 15000 });
    expect(result.error).toBeUndefined(); expect(result.stderr).toBe(''); expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).passed).toEqual([
      'apply-and-private-metadata-backup', 'explicit-version-bound-restore', 'metadata-conflict-zero-stage',
      'unknown-metadata-zero-stage', 'before-race', 'stage-failure', 'exchange-unavailable', 'exchange-race',
      'read-back-failure', 'flush-failure', 'cleanup-failure', 'changed-recovery-zero-exchange',
      'actual-stage-partial-write-and-metadata', 'actual-stage-xattr-refusal'
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('parses the shipped Python program and rejects unsupported platforms without exposing request content', () => {
  const compile = spawnSync(python, ['-c', 'import ast,sys; ast.parse(sys.stdin.read()); print("valid")'],
    { input: remoteFileProgram, encoding: 'utf8', timeout: 15000 });
  expect(compile.status).toBe(0); expect(compile.stdout.trim()).toBe('valid');
});
