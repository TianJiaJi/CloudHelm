import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { HOST_ENVIRONMENT_PROBE } from '../../packages/adapters/src/host-environment-probe.js';
import { remoteCommandProgram } from '../../packages/adapters/src/remote-command-program.js';
import { suRootProgram, suSessionProgram } from '../../packages/adapters/src/su-session-program.js';

const python = process.platform === 'win32' ? 'python' : 'python3';
const available = spawnSync(python, ['--version'], { timeout: 5000 }).status === 0;
// Compile only: never execute the program, create a PTY, elevate or connect to SSH.
it.skipIf(!available).each([['command', remoteCommandProgram], ['su-root', suRootProgram], ['su-auth', suSessionProgram],
  ['host-environment', HOST_ENVIRONMENT_PROBE.slice("python3 -I -S -B -c '".length, -1).replaceAll("'\\''", "'")]])(
  'compiles the fixed %s Python program without executing it', (_label, source) => {
    const result = spawnSync(python, ['-I', '-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: source, encoding: 'utf8', timeout: 5000 });
    expect(result.status, result.stderr).toBe(0);
  });
