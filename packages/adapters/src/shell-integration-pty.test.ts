import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { integratedShellCommand, ShellMarkerParser, type ShellCommandEvent } from './shell-integration.js';

it.skipIf(!existsSync('/bin/zsh'))('tracks real zsh commands and an entire Python interaction without changing user startup files', () => {
  const root = mkdtempSync(join(tmpdir(), 'cloudhelm-shell-test-'));
  const rc = 'PROMPT="fixture> "\nexport CLOUDHELM_STARTUP_TEST=preserved\n';
  writeFileSync(join(root, '.zshrc'), rc);
  writeFileSync(join(root, '.zprofile'), 'export CLOUDHELM_LOGIN_TEST=login-preserved\n');
  writeFileSync(join(root, '.zlogin'), 'printf \"login:%s rc:%s\\n\" \"$CLOUDHELM_LOGIN_TEST\" \"$CLOUDHELM_STARTUP_TEST\"\n');
  try {
    const helper = `import os, pty, select, sys, time, signal
pid, fd = pty.fork()
if pid == 0:
    os.environ['SHELL'] = '/bin/zsh'
    os.environ['ZDOTDIR'] = sys.argv[2]
    os.execv('/bin/sh', ['sh', '-c', sys.argv[1]])
output = b''
def read_until(needle):
    global output
    recent = b''
    end = time.time() + 8
    while needle not in recent:
        if time.time() > end: raise RuntimeError('terminal marker timeout')
        if select.select([fd], [], [], .1)[0]:
            chunk = os.read(fd, 65536)
            output += chunk
            recent += chunk
try:
    read_until(b'end;0\\x07')
    os.write(fd, b'printf "first\\\\n"; printf "second\\\\n"\\n')
    read_until(b'end;0\\x07')
    os.write(fd, b'python3 -q\\n')
    read_until(b'>>> ')
    os.write(fd, b'cloudhelm_missing_symbol\\n')
    read_until(b'NameError')
    os.write(fd, b'exit()\\n')
    read_until(b'end;0\\x07')
    sys.stdout.buffer.write(output)
    sys.stdout.buffer.flush()
finally:
    os.write(fd, b'exit\\n')
    time.sleep(.1)
    os.kill(pid, signal.SIGKILL)
    os.close(fd)
    os.waitpid(pid, 0)
`;
    const run = spawnSync('python3', ['-c', helper, integratedShellCommand('testnonce'), root], { encoding: 'utf8', timeout: 12000 });
    expect(run.status, run.stderr).toBe(0);
    let output = ''; const events: ShellCommandEvent[] = [];
    const parser = new ShellMarkerParser('testnonce', (text) => { output += text; }, (event) => events.push(event));
    parser.push(run.stdout);
    const starts = events.filter((event) => event.phase === 'start');
    expect(starts).toHaveLength(2);
    expect(starts[0]?.command).toContain('printf'); expect(starts[1]?.command).toBe('python3 -q');
    expect(output).toContain('login:login-preserved rc:preserved'); expect(output).toContain('NameError'); expect(output).not.toContain('777;cloudhelm');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20000);
