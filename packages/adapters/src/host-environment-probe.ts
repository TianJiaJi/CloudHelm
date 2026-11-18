import type { Client, ClientChannel } from 'ssh2';
import { architectureFamilyOf, redactOutput, type HostEnvironmentData, type HostProbeFailure } from '@cloudhelm/core';

/** The one fixed PATH used by command execution and presence resolution alike.
 * Probing against any other PATH makes "present" stop meaning "runnable". */
export const EXECUTION_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** Bounded cause without server text: stderr may carry private output. */
export class HostEnvironmentProbeError extends Error {
  constructor(readonly reason: HostProbeFailure, message: string) { super(message); }
}

const toolNames = ['sh', 'env', 'bash', 'python3', 'curl', 'wget', 'apt-get', 'dnf', 'yum', 'apk', 'pacman', 'systemctl', 'docker', 'git', 'tar'];

/** POSIX shell facts only: no Python, no sudo, no sourcing of untrusted files,
 * no environment enumeration. /etc/os-release (with the /usr/lib fallback some
 * minimal images ship instead) is read line by line with the shell builtin
 * `read`, so any POSIX host yields the full fact set without any server-side
 * runtime being required or installed. */
const shellProgram = `echo "os=$(uname -s 2>/dev/null)"
echo "architecture=$(uname -m 2>/dev/null)"
echo "kernel=$(uname -r 2>/dev/null)"
echo "username=$(id -un 2>/dev/null)"
echo "uid=$(id -u 2>/dev/null)"
echo "directory=$(pwd 2>/dev/null)"
release=''
if [ -f /etc/os-release ] && [ -r /etc/os-release ]; then
  release=/etc/os-release
elif [ -f /usr/lib/os-release ] && [ -r /usr/lib/os-release ]; then
  release=/usr/lib/os-release
fi
if [ -n "$release" ]; then
  while IFS='=' read -r key value; do
    case $key in
      ID) value=\${value#\\"}; value=\${value%\\"} ; echo "distribution=$value" ;;
      VERSION_ID) value=\${value#\\"}; value=\${value%\\"} ; echo "version=$value" ;;
    esac
  done < "$release"
fi
for tool in ${toolNames.join(' ')}; do
  if PATH='${EXECUTION_PATH}' command -v "$tool" >/dev/null 2>&1; then echo "tool.$tool=1"; else echo "tool.$tool=0"; fi
done`;

function safeField(item: string | undefined, max = 128): string | null {
  return typeof item === 'string' && item.length > 0 && item.length <= max
    && !/[\u0000-\u001f\u007f]/u.test(item) && redactOutput(item) === item ? item : null;
}

/** Line-oriented parse of the shell probe. Unobserved fields stay null. */
export function parseShellHostEnvironment(output: string): HostEnvironmentData {
  if (Buffer.byteLength(output) > 16384) throw new Error('Host metadata exceeds limit');
  const fields = new Map<string, string>();
  for (const line of output.split('\n')) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator), value = line.slice(separator + 1);
    // Keys are our fixed vocabulary, including tool names with digits and dashes.
    if (!/^[a-z][a-z0-9.-]{0,32}$/u.test(key) || value.length > 4096) continue;
    fields.set(key, value);
  }
  const loginDirectory = safeField(fields.get('directory'), 4096);
  const uidText = fields.get('uid');
  const toolPresence: Record<string, boolean> = {};
  for (const name of toolNames) {
    const value = fields.get(`tool.${name}`);
    if (value === '1' || value === '0') toolPresence[name] = value === '1';
  }
  const architecture = safeField(fields.get('architecture'));
  return { os: safeField(fields.get('os')), distribution: safeField(fields.get('distribution')),
    version: safeField(fields.get('version')), architecture, architectureFamily: architectureFamilyOf(architecture),
    kernel: safeField(fields.get('kernel')), username: safeField(fields.get('username')),
    // `id -u` is the real observed uid; anything else is explicitly unknown.
    uid: uidText && /^\d{1,10}$/u.test(uidText) ? Number(uidText) : null,
    loginDirectory: loginDirectory?.startsWith('/') ? loginDirectory : null,
    path: EXECUTION_PATH, toolPresence, source: 'shell' };
}

/** Deadline starts before SSH channel allocation; late channels are closed.
 * Both stdout and stderr count toward the cap, but stderr is never returned.
 * Every failure is classified so callers can decide between retrying and
 * reporting a permanent limitation. */
function runProbe(client: Pick<Client, 'exec'>, command: string, limit: number, parse: (output: string) => HostEnvironmentData,
  signal: AbortSignal | undefined): Promise<HostEnvironmentData> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false, channel: ClientChannel | undefined, bytes = 0, exitCode: number | undefined;
    const chunks: Buffer[] = [];
    const finish = (error?: HostEnvironmentProbeError, value?: HostEnvironmentData) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      channel?.close();
      if (error) reject(error); else resolve(value!);
    };
    const abort = () => finish(new HostEnvironmentProbeError('cancelled', 'Host metadata cancelled'));
    const timer = setTimeout(() => finish(new HostEnvironmentProbeError('timeout', 'Host metadata timed out')), 5000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try {
      client.exec(command, (error, stream) => {
        if (settled) { stream?.on('error', () => {}); stream?.close(); return; }
        if (error) { stream?.on('error', () => {}); stream?.close();
          finish(new HostEnvironmentProbeError('unavailable', 'Host metadata unavailable')); return; }
        channel = stream;
        stream.on('error', () => finish(new HostEnvironmentProbeError('unavailable', 'Host metadata unavailable')));
        const collect = (data: Buffer, stdout: boolean) => {
          if (settled) return;
          bytes += data.length;
          if (bytes > limit) { finish(new HostEnvironmentProbeError('too-large', 'Host metadata exceeds limit')); return; }
          if (stdout) chunks.push(Buffer.from(data));
        };
        stream.on('data', (data: Buffer) => collect(data, true));
        stream.stderr.on('data', (data: Buffer) => collect(data, false));
        stream.on('exit', (code: number) => { exitCode = code; });
        stream.on('close', () => {
          if (settled) return;
          if (exitCode !== 0) {
            // 127 is "command not found": this POSIX host cannot even provide
            // the shell carrier, which is a permanent limitation, not a retry hint.
            const reason = exitCode === 127 ? 'unsupported' : 'unavailable';
            finish(new HostEnvironmentProbeError(reason, 'Host metadata unavailable')); return;
          }
          try { finish(undefined, parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { finish(new HostEnvironmentProbeError('invalid', 'Host metadata invalid')); }
        });
      });
    } catch { finish(new HostEnvironmentProbeError('unavailable', 'Host metadata unavailable')); }
  });
}

export const HOST_ENVIRONMENT_SHELL_PROBE = `sh -c '${shellProgram.replaceAll("'", "'" + String.fromCharCode(92) + "'" + "'")}'`;

/** The one native carrier. A read-only POSIX shell observation; the probe never
 * installs, escalates or requires any server-side runtime. */
export function probeHostEnvironment(client: Pick<Client, 'exec'>, signal?: AbortSignal): Promise<HostEnvironmentData> {
  return runProbe(client, HOST_ENVIRONMENT_SHELL_PROBE, 16384, parseShellHostEnvironment, signal);
}
