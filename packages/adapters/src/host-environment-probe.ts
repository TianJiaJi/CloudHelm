import type { Client, ClientChannel } from 'ssh2';
import { architectureFamilyOf, redactOutput, type HostEnvironmentData, type HostProbeFailure } from '@cloudhelm/core';

/** The one fixed PATH used by command execution and presence resolution alike.
 * Probing against any other PATH makes "present" stop meaning "runnable". */
export const EXECUTION_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** Bounded cause without server text: stderr may carry private output. */
export class HostEnvironmentProbeError extends Error {
  constructor(readonly reason: HostProbeFailure, message: string) { super(message); }
}

/** Fixed allowlisted metadata only. Never source os-release, inherit user Python
 * modules, enumerate environment variables, run discovered tools or escalate. */
const program = `import os, platform, pwd, json, shutil, stat
release = {}
try:
    candidate = os.path.realpath("/etc/os-release")
    if candidate in ("/etc/os-release", "/usr/lib/os-release"):
        fd = os.open(candidate, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if stat.S_ISREG(info.st_mode) and info.st_size <= 16384:
                for line in stream.read(16385).decode("utf-8", "replace").splitlines():
                    key, sep, value = line.partition("=")
                    if sep and key in ("ID", "VERSION_ID"):
                        release[key] = value.strip().strip("\\\"'")
except (OSError, ValueError):
    pass
try:
    username = pwd.getpwuid(os.getuid()).pw_name
except (KeyError, OSError):
    username = None
try:
    directory = os.getcwd()
except OSError:
    directory = None
tools = ("sh", "bash", "python3", "curl", "wget", "apt-get", "dnf", "yum", "apk", "pacman", "systemctl", "docker", "git", "tar")
print(json.dumps(dict(os=platform.system(), distribution=release.get("ID"), version=release.get("VERSION_ID"), architecture=platform.machine(), kernel=platform.release(), username=username, uid=os.getuid(), directory=directory, tools={name: shutil.which(name, path='${EXECUTION_PATH}') is not None for name in tools})))
`;
export const HOST_ENVIRONMENT_PROBE = `python3 -I -S -B -c '${program.replaceAll("'", "'\\''")}'`;
const toolNames = ['sh', 'bash', 'python3', 'curl', 'wget', 'apt-get', 'dnf', 'yum', 'apk', 'pacman', 'systemctl', 'docker', 'git', 'tar'];
export function parseHostEnvironment(output: string, source: HostEnvironmentData['source'] = 'python'): HostEnvironmentData {
  if (Buffer.byteLength(output) > 16384) throw new Error('Host metadata exceeds limit');
  const value: unknown = JSON.parse(output);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid host metadata');
  const raw = value as Record<string, unknown>;
  const text = (name: string, max = 128): string | null => {
    const item = raw[name];
    return typeof item === 'string' && item.length > 0 && item.length <= max
      && !/[\u0000-\u001f\u007f]/u.test(item) && redactOutput(item) === item ? item : null;
  };
  const loginDirectory = text('directory', 4096);
  const toolRaw = raw.tools && typeof raw.tools === 'object' && !Array.isArray(raw.tools) ? raw.tools as Record<string, unknown> : {};
  const architecture = text('architecture');
  return { os: text('os'), distribution: text('distribution'), version: text('version'),
    architecture, architectureFamily: architectureFamilyOf(architecture), kernel: text('kernel'), username: text('username'),
    uid: typeof raw.uid === 'number' && Number.isSafeInteger(raw.uid) && raw.uid >= 0 ? raw.uid : null,
    loginDirectory: loginDirectory?.startsWith('/') ? loginDirectory : null,
    path: EXECUTION_PATH,
    toolPresence: Object.fromEntries(toolNames.filter((name) => typeof toolRaw[name] === 'boolean').map((name) => [name, toolRaw[name] as boolean])), source };
}

/** POSIX shell facts only: no Python, no sudo, no sourcing of untrusted files,
 * no environment enumeration. /etc/os-release is read line by line with the shell
 * builtin `read`, so a host without Python still yields useful basic facts. */
const shellProgram = `echo "os=$(uname -s 2>/dev/null)"
echo "architecture=$(uname -m 2>/dev/null)"
echo "kernel=$(uname -r 2>/dev/null)"
echo "username=$(id -un 2>/dev/null)"
echo "uid=$(id -u 2>/dev/null)"
echo "directory=$(pwd 2>/dev/null)"
if [ -f /etc/os-release ] && [ -r /etc/os-release ]; then
  while IFS='=' read -r key value; do
    case $key in
      ID) value=\${value#"}; value=\${value%"} ; echo "distribution=$value" ;;
      VERSION_ID) value=\${value#"}; value=\${value%"} ; echo "version=$value" ;;
    esac
  done < /etc/os-release
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
 * Every failure is classified so callers can decide between retrying, degrading
 * to the shell probe, or reporting a permanent limitation. */
function runProbe(client: Pick<Client, 'exec'>, command: string, limit: number, parse: (output: string) => HostEnvironmentData,
  signal: AbortSignal | undefined, missingOn?: (exitCode: number) => boolean): Promise<HostEnvironmentData> {
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
            // 127 is "command not found"; the Python probe uses it to say "no Python",
            // never as evidence about the host's capabilities in general.
            const reason = exitCode !== undefined && missingOn?.(exitCode) ? 'python-missing'
              : exitCode === 127 ? 'unsupported' : 'unavailable';
            finish(new HostEnvironmentProbeError(reason, 'Host metadata unavailable')); return;
          }
          try { finish(undefined, parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { finish(new HostEnvironmentProbeError('invalid', 'Host metadata invalid')); }
        });
      });
    } catch { finish(new HostEnvironmentProbeError('unavailable', 'Host metadata unavailable')); }
  });
}

export function probeHostEnvironment(client: Pick<Client, 'exec'>, signal?: AbortSignal): Promise<HostEnvironmentData> {
  return runProbe(client, HOST_ENVIRONMENT_PROBE, 16384, (output) => parseHostEnvironment(output, 'python'),
    signal, (code) => code === 127);
}

/** Basic facts without Python. Anything the shell cannot observe stays null instead
 * of being guessed; `source: 'shell'` marks the observation as degraded. */
export const HOST_ENVIRONMENT_SHELL_PROBE = `sh -c '${shellProgram.replaceAll("'", "'" + String.fromCharCode(92) + "'" + "'")}'`;

export function probeHostEnvironmentViaShell(client: Pick<Client, 'exec'>, signal?: AbortSignal): Promise<HostEnvironmentData> {
  return runProbe(client, HOST_ENVIRONMENT_SHELL_PROBE, 16384, parseShellHostEnvironment, signal);
}

/** Base facts first, extended abilities later: Python is an enhancer, not a
 * bootstrap requirement. The shell fallback never installs or escalates. */
export async function readHostEnvironment(client: Pick<Client, 'exec'>, signal?: AbortSignal): Promise<HostEnvironmentData> {
  try { return await probeHostEnvironment(client, signal); }
  catch (error) {
    if (error instanceof HostEnvironmentProbeError && error.reason === 'cancelled') throw error;
    if (signal?.aborted) throw new HostEnvironmentProbeError('cancelled', 'Host metadata cancelled');
    try { return await probeHostEnvironmentViaShell(client, signal); }
    catch (fallback) {
      if (fallback instanceof HostEnvironmentProbeError && fallback.reason !== 'cancelled'
        && error instanceof HostEnvironmentProbeError) {
        throw new HostEnvironmentProbeError(fallback.reason,
          `${fallback.message} (python ${error.reason}, shell ${fallback.reason})`);
      }
      throw fallback;
    }
  }
}
