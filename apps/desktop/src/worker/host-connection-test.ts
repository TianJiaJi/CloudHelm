import { HostKeyError, SshTransport, type SshLoginPrompt } from '@cloudhelm/adapters';
import type { HostTestFailure } from '@cloudhelm/contracts';
import { runtimeSshCredentials } from '@cloudhelm/contracts/runtime';
import type { RuntimeHost, RuntimeHostTestResult } from '@cloudhelm/contracts/runtime';

function failureCode(error: unknown): HostTestFailure {
  const message = error instanceof Error ? error.message : '';
  if (/SSH Agent/iu.test(message)) return 'agent';
  if (/SSH password is required|Private key path is required/iu.test(message)) return 'credentials';
  if (/ENOENT|EACCES|EISDIR|EPERM/iu.test(message)) return 'key-file';
  if (/authentication|privateKey|private key|Encrypted private|passphrase/iu.test(message)) return 'auth';
  if (/timed out|timeout|ETIMEDOUT/iu.test(message)) return 'timeout';
  if (/ECONN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|forward|connect|handshake|proxy/iu.test(message)) return 'network';
  return 'unknown';
}

/** An isolated transport authenticates only; it never opens a shell or runs a command. */
export async function testHostConnection(host: RuntimeHost, jump?: RuntimeHost,
  createTransport: () => Pick<SshTransport, 'connect' | 'close'> = () => new SshTransport(),
  signal: AbortSignal = AbortSignal.timeout(45_000)): Promise<RuntimeHostTestResult> {
  const ssh = createTransport();
  const started = Date.now();
  let stage: 'host' | 'jump' = jump ? 'jump' : 'host';
  let interactive = false;
  const challenge = async (prompt: SshLoginPrompt) => { interactive ||= (prompt.attempt ?? 1) === 1; return null; };
  if (host.connection?.proxy?.enabled) { jump = undefined; stage = 'host'; }
  const credentials = runtimeSshCredentials;
  try {
    if (jump) await ssh.connect(jump, credentials(jump), undefined, challenge, signal, { onDemandAuthentication: true });
    stage = 'host';
    await ssh.connect(host, credentials(host), jump ? { host: jump, secret: credentials(jump) } : undefined, challenge, signal, { onDemandAuthentication: true });
    return { status: 'success', latencyMs: Date.now() - started };
  } catch (error) {
    if (error instanceof HostKeyError) return { status: 'trust-required', stage, fingerprint: error.fingerprint, expectedFingerprint: error.expected };
    return { status: 'failed', stage, code: interactive ? 'interactive' : failureCode(error) };
  } finally { ssh.close(); }
}
