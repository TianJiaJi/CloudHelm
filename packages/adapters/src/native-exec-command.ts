import path from 'node:path';
import { EXECUTION_PATH } from './host-environment-probe.js';

/** Build an exec request for an explicitly probed POSIX env and shell. The SSH
 * server can still invoke the account shell before this wrapper; env -i only
 * isolates the child process, not the server's shell startup. */
export function renderNativeExecCommand(input: {
  command: string; cwd: string; envPath: string; shellPath: string;
}): string {
  if (!['/usr/bin/env', '/bin/env'].includes(input.envPath)
    || !['/bin/sh', '/usr/bin/sh'].includes(input.shellPath))
    throw new Error('Native exec requires observed absolute tool paths');
  if (!path.posix.isAbsolute(input.cwd) || /[\u0000-\u001f\u007f]/u.test(input.cwd)) throw new Error('Native exec requires a safe absolute cwd');
  if (!input.command.trim() || input.command.includes('\u0000') || Buffer.byteLength(input.command, 'utf8') > 8192)
    throw new Error('Native exec command is empty, contains NUL, or exceeds the limit');
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const script = `cd ${quote(input.cwd)} || exit 125\n${input.command}`;
  return `exec ${input.envPath} -i PATH=${quote(EXECUTION_PATH)} LC_ALL=C ${input.shellPath} -c ${quote(script)}`;
}
