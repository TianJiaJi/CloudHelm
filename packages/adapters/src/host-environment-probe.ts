import type { Client, ClientChannel } from 'ssh2';
import { redactOutput, type HostEnvironmentData } from '@cloudhelm/core';

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
print(json.dumps(dict(os=platform.system(), distribution=release.get("ID"), version=release.get("VERSION_ID"), architecture=platform.machine(), kernel=platform.release(), username=username, uid=os.getuid(), directory=directory, tools={name: shutil.which(name) is not None for name in tools})))
`;
export const HOST_ENVIRONMENT_PROBE = `python3 -I -S -B -c '${program.replaceAll("'", "'\\''")}'`;
const toolNames = ['sh', 'bash', 'python3', 'curl', 'wget', 'apt-get', 'dnf', 'yum', 'apk', 'pacman', 'systemctl', 'docker', 'git', 'tar'];
export function parseHostEnvironment(output: string): HostEnvironmentData {
  if (Buffer.byteLength(output) > 16384) throw new Error('Host metadata exceeds limit');
  const value: unknown = JSON.parse(output);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid host metadata');
  const raw = value as Record<string, unknown>;
  const text = (name: string, max = 128): string | null => {
    const item = raw[name];
    return typeof item === 'string' && item.length > 0 && item.length <= max
      && !/[\u0000-\u001f\u007f]/u.test(item) && redactOutput(item) === item ? item : null;
  };
  const directory = text('directory', 4096);
  const tools = raw.tools && typeof raw.tools === 'object' && !Array.isArray(raw.tools) ? raw.tools as Record<string, unknown> : {};
  return { os: text('os'), distribution: text('distribution'), version: text('version'),
    architecture: text('architecture'), kernel: text('kernel'), username: text('username'),
    uid: typeof raw.uid === 'number' && Number.isSafeInteger(raw.uid) && raw.uid >= 0 ? raw.uid : null,
    directory: directory?.startsWith('/') ? directory : null,
    tools: Object.fromEntries(toolNames.filter((name) => typeof tools[name] === 'boolean').map((name) => [name, tools[name] as boolean])) };
}

/** Deadline starts before SSH channel allocation; late channels are closed.
 * Both stdout and stderr count toward the cap, but stderr is never returned. */
export function probeHostEnvironment(client: Pick<Client, 'exec'>, signal?: AbortSignal): Promise<HostEnvironmentData> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false, channel: ClientChannel | undefined, bytes = 0, exitCode: number | undefined;
    const chunks: Buffer[] = [];
    const finish = (error?: Error, value?: HostEnvironmentData) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      channel?.close();
      if (error) reject(error); else resolve(value!);
    };
    const abort = () => finish(new Error('Host metadata cancelled'));
    const timer = setTimeout(() => finish(new Error('Host metadata timed out')), 5000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try {
      client.exec(HOST_ENVIRONMENT_PROBE, (error, stream) => {
        if (settled) { stream?.on('error', () => {}); stream?.close(); return; }
        if (error) { stream?.on('error', () => {}); stream?.close(); finish(new Error('Host metadata unavailable')); return; }
        channel = stream;
        stream.on('error', () => finish(new Error('Host metadata unavailable')));
        const collect = (data: Buffer, stdout: boolean) => {
          if (settled) return;
          bytes += data.length;
          if (bytes > 16384) { finish(new Error('Host metadata exceeds limit')); return; }
          if (stdout) chunks.push(Buffer.from(data));
        };
        stream.on('data', (data: Buffer) => collect(data, true));
        stream.stderr.on('data', (data: Buffer) => collect(data, false));
        stream.on('exit', (code: number) => { exitCode = code; });
        stream.on('close', () => {
          if (settled) return;
          if (exitCode !== 0) { finish(new Error('Host metadata unavailable')); return; }
          try { finish(undefined, parseHostEnvironment(Buffer.concat(chunks).toString('utf8'))); }
          catch { finish(new Error('Host metadata invalid')); }
        });
      });
    } catch { finish(new Error('Host metadata unavailable')); }
  });
}
