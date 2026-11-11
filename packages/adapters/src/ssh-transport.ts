import { openSshControlPipe } from './ssh-control-pipe.js';
import { withSftpSession } from './ssh-sftp-session.js';
import { readBoundedSftpFile } from './sftp-read.js';
import { runFixedSshCommand } from './ssh-fixed-exec.js';
import { probeHostEnvironment } from './host-environment-probe.js';
import { onDemandAuthHandler, type SshLoginChallenge } from './ssh-authentication.js';
export { SshAuthenticationError } from './ssh-authentication.js';
export type { SshLoginPrompt, SshLoginChallenge } from './ssh-authentication.js';
import { openSshProxy } from './ssh-proxy.js';
import type { Socket } from 'node:net';
import type { SshConnectionSettings, SshCredentials } from '@cloudhelm/core';
import { startManualKeepalive } from './manual-session.js';
import { openIntegratedShell, type ManualShellOptions } from './shell-integration.js';
import { redactOutput } from '@cloudhelm/core';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client, type ClientChannel, type ConnectConfig, type FileEntryWithStats, type SFTPWrapper } from 'ssh2';

export class HostKeyError extends Error {
  constructor(readonly fingerprint: string, readonly expected?: string) {
    super(expected ? 'SSH host key changed' : 'SSH host key is not trusted yet');
  }
}

/** A preflight failure is distinguishable from any attempted remote write. */
export class RemoteFileError extends Error {
  constructor(readonly effects: 'none' | 'possible', readonly permissionDenied: boolean, detail?: string) {
    super(permissionDenied ? 'Remote filesystem permission denied' : redactOutput(detail ?? 'Remote file operation failed; verify if effects are possible'));
  }
}

export interface SshHost {
  id: string;
  label: string;
  address: string;
  port: number;
  username: string;
  auth: 'agent' | 'private-key' | 'password';
  privateKeyPath?: string;
  jumpHostId?: string;
  fingerprint?: string;
  connection?: SshConnectionSettings;
}

export type AuthMaterial = SshCredentials;

export interface SshConnectOptions { onDemandAuthentication?: boolean }

async function connectClient(host: SshHost, secret: AuthMaterial, socket?: ClientChannel, challenge?: SshLoginChallenge, signal?: AbortSignal, onDemand = false): Promise<Client> {
  signal?.throwIfAborted();
  if (host.auth === 'agent') throw new Error('SSH Agent 已停用；请选择密码或私钥认证并重新保存主机');
  onDemand ||= !!host.connection?.authOrder;
  let observed: string | undefined;
  const config: ConnectConfig = {
    host: host.address, port: host.port, username: host.username, sock: socket,
    // A keyboard-interactive challenge can remain open while the user reads the
    // server prompt and enters an OTP. Its UI request expires after two minutes.
    readyTimeout: host.connection?.timeoutMs ?? (challenge ? 150_000 : 20_000),
    keepaliveInterval: host.connection?.keepaliveIntervalMs ?? 15_000,
    keepaliveCountMax: host.connection?.keepaliveCountMax ?? 3, tryKeyboard: !!challenge,
    algorithms: host.connection?.algorithms ? {
      serverHostKey: host.connection.algorithms.hostKey,
      cipher: host.connection.algorithms.cipher,
      kex: host.connection.algorithms.kex
    } as ConnectConfig['algorithms'] : undefined,
    hostVerifier(key: Buffer) {
      observed = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`;
      return observed === host.fingerprint;
    }
  };
  if (!onDemand && host.auth === 'private-key') {
    if (!host.privateKeyPath) throw new Error('Private key path is required');
    config.privateKey = await readFile(host.privateKeyPath);
    if (secret.passphrase) config.passphrase = secret.passphrase;
  } else if (!onDemand) {
    if (!secret.password) throw new Error('SSH password is required');
    config.password = secret.password;
  }
  const proxySocket: Socket | undefined = !socket && host.connection?.proxy?.enabled
    ? await openSshProxy(host.connection.proxy, host.address, host.port, secret.proxyPassword, host.connection.timeoutMs, signal) : undefined;
  if (proxySocket) config.sock = proxySocket;
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    if (challenge && !onDemand) client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      void (async () => {
        const answers: string[] = [];
        for (const prompt of prompts) {
          const answer = await challenge({ hostId: host.id, username: host.username, text: prompt.prompt, echo: !!prompt.echo });
          if (answer === null) { finish([]); return; }
          answers.push(answer);
        }
        finish(answers);
      })().catch(() => finish([]));
    });
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      client.on('error', () => {});
      client.end();
      proxySocket?.destroy();
      reject(observed && observed !== host.fingerprint ? new HostKeyError(observed, host.fingerprint) : error);
    };
    const abort = () => fail(new Error('SSH connection timed out'));
    if (onDemand) config.authHandler = onDemandAuthHandler({ host, material: secret, challenge, fail,
      assertActive: () => { signal?.throwIfAborted(); if (settled) throw new Error('SSH authentication ended'); } });
    client.once('ready', () => {
      if (settled) { client.end(); return; }
      settled = true;
      signal?.removeEventListener('abort', abort);
      client.removeListener('error', fail);
      client.on('error', () => client.end());
      resolve(client);
    });
    client.once('error', fail);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try { client.connect(config); }
    catch (error) { fail(error instanceof Error ? error : new Error('SSH connection failed')); }
  });
}

async function forwardSocket(client: Client, host: SshHost, signal?: AbortSignal): Promise<ClientChannel> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => { settled = true; reject(new Error('SSH connection timed out')); };
    signal?.addEventListener('abort', abort, { once: true });
    client.forwardOut('127.0.0.1', 0, host.address, host.port, (error, channel) => {
      signal?.removeEventListener('abort', abort);
      if (settled) { channel?.end(); return; }
      settled = true;
      if (error) reject(error); else resolve(channel);
    });
  });
}

export class SshTransport {
  private readonly connections = new Map<string, Client>();
  private readonly identities = new Map<string, string>();
  private readonly instanceId = randomUUID();
  private readonly generations = new Map<string, number>();

  constructor(private readonly onDisconnected: (hostId: string) => void = () => {}) {}

  async connect(host: SshHost, secret: AuthMaterial, jump?: { host: SshHost; secret: AuthMaterial }, challenge?: SshLoginChallenge, signal?: AbortSignal, options?: SshConnectOptions): Promise<void> {
    signal?.throwIfAborted();
    this.disconnect(host.id);
    let socket: ClientChannel | undefined;
    if (jump && !host.connection?.proxy?.enabled) {
      let jumpClient = this.connections.get(jump.host.id);
      if (!jumpClient) {
        jumpClient = await connectClient(jump.host, jump.secret, undefined, challenge, signal, options?.onDemandAuthentication);
        if (signal?.aborted) { jumpClient.end(); signal.throwIfAborted(); }
        this.registerConnection(jump.host.id, jumpClient, jump.host.username);
      }
      socket = await forwardSocket(jumpClient, host, signal);
    }
    let client: Client;
    try { client = await connectClient(host, secret, socket, challenge, signal, options?.onDemandAuthentication); }
    catch (error) { socket?.end(); throw error; }
    if (signal?.aborted) { client.end(); signal.throwIfAborted(); }
    this.registerConnection(host.id, client, host.username);
  }

  private registerConnection(hostId: string, client: Client, loginAs: string): void {
    if (this.connections.has(hostId)) this.disconnect(hostId);
    this.connections.set(hostId, client);
    this.identities.set(hostId, loginAs);
    this.generations.set(hostId, (this.generations.get(hostId) ?? 0) + 1);
    client.once('close', () => {
      if (this.connections.get(hostId) !== client) return;
      this.connections.delete(hostId);
      this.identities.delete(hostId);
      this.generations.set(hostId, (this.generations.get(hostId) ?? 0) + 1);
      this.onDisconnected(hostId);
    });
  }

  isConnected(hostId: string): boolean { return this.connections.has(hostId); }
  connectionId(hostId: string): string | null {
    return this.isConnected(hostId) ? `${this.instanceId}:${this.connectionGeneration(hostId)}` : null;
  }
  matchesConnection(hostId: string, loginAs: string, connectionId: string): boolean {
    return this.connectionId(hostId) === connectionId && this.identities.get(hostId) === loginAs;
  }
  async readEnvironment(hostId: string, loginAs: string, signal?: AbortSignal) {
    const client = this.connections.get(hostId), generation = this.connectionGeneration(hostId);
    if (!client || this.identities.get(hostId) !== loginAs) throw new Error('Host metadata identity unavailable');
    const data = await probeHostEnvironment(client, signal);
    if (this.connections.get(hostId) !== client || this.connectionGeneration(hostId) !== generation)
      throw new Error('Host metadata connection changed');
    return data;
  }
  private readonly commandPreflights = new Map<string, { generation: number; promise: Promise<void> }>();

  private async checkCommandEnvironment(hostId: string): Promise<void> {
    const generation = this.connectionGeneration(hostId);
    const previous = this.commandPreflights.get(hostId);
    if (previous?.generation === generation) return previous.promise;
    const promise = this.execFixed(hostId, `python3 -I -c 'import pty, fcntl, termios, socket, subprocess, shutil'`).then((result) => {
      if (result.exitCode !== 0) {
        const detail = redactOutput(result.output).trim().slice(-300);
        throw new Error(`远端环境检查未通过（exit ${result.exitCode}）：需要可用的 POSIX Python 3${detail ? `；远端输出：${detail}` : ''}`);
      }
    }).catch((error: unknown) => {
      if (this.commandPreflights.get(hostId)?.promise === promise) this.commandPreflights.delete(hostId);
      throw error;
    });
    this.commandPreflights.set(hostId, { generation, promise });
    return promise;
  }

  connectionGeneration(hostId: string): number { return this.generations.get(hostId) ?? 0; }

  async execFixed(hostId: string, command: string): Promise<{ exitCode: number; output: string }> {
    const client = this.connections.get(hostId);
    if (!client) throw new Error('Host is not connected');
    const generation = this.connectionGeneration(hostId);
    return runFixedSshCommand(client, command, () => this.connections.get(hostId) === client && this.connectionGeneration(hostId) === generation);
  }

  async openPipe(hostId: string, command: string): Promise<ClientChannel> {
    const client = this.connections.get(hostId);
    if (!client) throw new Error('Host is not connected');
    const generation = this.connectionGeneration(hostId);
    return openSshControlPipe(client, command, () => this.connections.get(hostId) === client && this.connectionGeneration(hostId) === generation);
  }

  /** Installs only the fixed process transport, never model-authored scripts or secrets. */
  async prepareCommandProgram(hostId: string, source: string, assertAuthorized: () => void): Promise<string> {
    assertAuthorized();
    await this.checkCommandEnvironment(hostId);
    assertAuthorized();
    const result = await this.execFixed(hostId, 'command -v python3 && mktemp -d /tmp/cloudhelm-run.XXXXXXXX');
    const lines = result.output.trim().split(/\r?\n/u);
    const directory = lines[1];
    if (result.exitCode !== 0 || lines.length !== 2 || !lines[0]?.startsWith('/')
      || !directory || !/^\/tmp\/cloudhelm-run\.[A-Za-z0-9]+$/u.test(directory)) {
      const detail = redactOutput(result.output).trim().slice(-300);
      throw new Error(`远端命令通道准备失败（exit ${result.exitCode}）：需要可解析的 python3 且 /tmp 可写${detail ? `；远端输出：${detail}` : ''}`);
    }
    const script = `${directory}/process.py`;
    try {
      await this.withSftp(hostId, (sftp) => this.writeSftpFile(sftp, script, Buffer.from(source), 0o700, assertAuthorized));
      return script;
    } catch (error) {
      await this.removeCommandProgram(hostId, script).catch(() => {});
      throw error;
    }
  }

  async removeCommandProgram(hostId: string, script: string): Promise<void> {
    if (!/^\/tmp\/cloudhelm-run\.[A-Za-z0-9]+\/process\.py$/u.test(script)) throw new Error('Invalid command transport path');
    await this.execFixed(hostId, `rm -f -- ${script}; rmdir -- ${path.posix.dirname(script)}`);
  }

  startManualKeepalive(hostId: string, options: ManualShellOptions, canRun: () => boolean, notice: (message: string) => void): () => void {
    const client = this.connections.get(hostId);
    if (!client) throw new Error('Host is not connected');
    options.assertAuthorized();
    return startManualKeepalive(client, options.settings.session, options.assertAuthorized, canRun, notice);
  }

  async integratedShell(hostId: string, cols = 100, rows = 30, options?: ManualShellOptions) {
    const client = this.connections.get(hostId);
    if (!client) throw new Error('Host is not connected');
    return openIntegratedShell(client, cols, rows, options);
  }

  async shell(hostId: string, cols = 100, rows = 30): Promise<ClientChannel> {
    const client = this.connections.get(hostId);
    if (!client) throw new Error('Host is not connected');
    return new Promise((resolve, reject) => {
      client.shell({ term: 'xterm-256color', cols, rows }, (error, channel) => error ? reject(error) : resolve(channel));
    });
  }

  async list(hostId: string, directory: string): Promise<Array<{ name: string; isDirectory: boolean; size: number }>> {
    return this.withSftp(hostId, async (sftp) => {
      const files = await new Promise<FileEntryWithStats[]>((resolve, reject) => {
        sftp.readdir(directory, (error, entries) => error ? reject(error) : resolve(entries));
      });
      return files.map((file) => ({ name: file.filename, isDirectory: file.attrs.isDirectory(), size: file.attrs.size }));
    });
  }

  /** Read a small regular script for policy analysis; reject known links and never expose its source to the model. */
  async inspectScript(hostId: string, absolutePath: string, signal?: AbortSignal): Promise<{ source: string; sha256: string }> {
    return this.withSftp(hostId, async (sftp, assertActive) => {
      await this.checkSafeParent(sftp, absolutePath);
      const stat = await this.lstatOptional(sftp, absolutePath);
      if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) throw new Error('Script is not a small regular file');
      const bytes = await readBoundedSftpFile(sftp, absolutePath, 65_536, assertActive);
      if (bytes.length > 65_536 || bytes.includes(0)) throw new Error('Script content is not inspectable text');
      const source = bytes.toString('utf8');
      if (!Buffer.from(source, 'utf8').equals(bytes)) throw new Error('Script encoding is not valid UTF-8');
      return { source, sha256: createHash('sha256').update(bytes).digest('hex') };
    }, signal);
  }

  /** Writes through a private temporary file and retains a private backup of an overwritten file. */
  async writeFile(hostId: string, absolutePath: string, content: Buffer, assertAuthorized: () => void = () => {}, signal?: AbortSignal): Promise<string | undefined> {
    if (content.length > 1_048_576) throw new Error('Structured writes are limited to 1 MiB');
    let effects: 'none' | 'possible' = 'none';
    try { return await this.withSftp(hostId, async (sftp, assertActive) => {
      const check = () => { assertActive(); assertAuthorized(); };
      check();
      await this.checkSafeParent(sftp, absolutePath);
      const existing = await this.lstatOptional(sftp, absolutePath);
      if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('Target must be a regular file, not a symlink or directory');
      if (existing && existing.size > 1_048_576) throw new Error('Existing file is too large for a managed backup');
      const backup = existing ? `${absolutePath}.cloudhelm-backup-${randomUUID()}` : undefined;
      if (backup) {
        const original = await readBoundedSftpFile(sftp, absolutePath, 1_048_576, check);
        check(); effects = 'possible';
        await this.writeSftpFile(sftp, backup, original, 0o600, check);
      }
      const temporary = `${absolutePath}.cloudhelm-new-${randomUUID()}`;
      try {
        check(); effects = 'possible';
        await this.writeSftpFile(sftp, temporary, content, existing ? existing.mode : 0o600, check);
        if (existing) {
          // Preserve owner/group and full mode including setuid/setgid/sticky. SFTP rename
          // does not carry ACL/xattr; document that limitation rather than silently dropping.
          await new Promise<void>((resolve, reject) => {
            check();
            sftp.setstat(temporary, { uid: existing.uid, gid: existing.gid, mode: existing.mode },
              (error) => error ? reject(error) : resolve());
          });
        }
        await new Promise<void>((resolve, reject) => {
          check();
          sftp.ext_openssh_rename(temporary, absolutePath, (error) => error ? reject(error) : resolve());
        });
      } catch (error) {
        await this.unlinkOptional(sftp, temporary, check).catch(() => undefined);
        throw error;
      }
      return backup;
    }, signal); } catch (error) {
      throw new RemoteFileError(effects, !!error && typeof error === 'object' && 'code' in error && (error.code === 3 || error.code === 'EACCES' || error.code === 'EPERM'), error instanceof Error ? error.message : undefined);
    }
  }

  /** Deletes regular files only, preserving a separate recovery copy. */
  async deleteFile(hostId: string, absolutePath: string, assertAuthorized: () => void = () => {}, signal?: AbortSignal): Promise<string> {
    let effects: 'none' | 'possible' = 'none';
    try { return await this.withSftp(hostId, async (sftp, assertActive) => {
      const check = () => { assertActive(); assertAuthorized(); };
      check();
      await this.checkSafeParent(sftp, absolutePath);
      const existing = await this.lstatOptional(sftp, absolutePath);
      if (!existing || !existing.isFile() || existing.isSymbolicLink()) throw new Error('Only an existing regular file can be deleted');
      if (existing.size > 1_048_576) throw new Error('File is too large for a managed backup');
      const backup = `${absolutePath}.cloudhelm-backup-${randomUUID()}`;
      const original = await readBoundedSftpFile(sftp, absolutePath, 1_048_576, check);
      check(); effects = 'possible';
      await this.writeSftpFile(sftp, backup, original, 0o600, check);
      await new Promise<void>((resolve, reject) => {
        check();
        sftp.unlink(absolutePath, (error) => error ? reject(error) : resolve());
      });
      return backup;
    }, signal); } catch (error) {
      throw new RemoteFileError(effects, !!error && typeof error === 'object' && 'code' in error && (error.code === 3 || error.code === 'EACCES' || error.code === 'EPERM'), error instanceof Error ? error.message : undefined);
    }
  }

  private async withSftp<T>(hostId: string, action: (sftp: SFTPWrapper, assertActive: () => void) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const client = this.connections.get(hostId);
    if (!client) throw new Error('Host is not connected');
    return withSftpSession(client, action, { signal, isCurrent: () => this.connections.get(hostId) === client });
  }

  private async checkSafeParent(sftp: SFTPWrapper, absolutePath: string): Promise<void> {
    if (!path.posix.isAbsolute(absolutePath) || absolutePath === '/') throw new Error('An absolute file path is required');
    const parts = path.posix.dirname(absolutePath).split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current += `/${part}`;
      const stat = await this.lstatOptional(sftp, current);
      if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe or missing parent directory: ${current}`);
    }
  }

  private async lstatOptional(sftp: SFTPWrapper, remotePath: string): Promise<import('ssh2').Stats | undefined> {
    return new Promise((resolve, reject) => {
      sftp.lstat(remotePath, (error, stat) => {
        if (!error) resolve(stat);
        else if ('code' in error && error.code === 2) resolve(undefined);
        else reject(error);
      });
    });
  }

  private async writeSftpFile(sftp: SFTPWrapper, remotePath: string, content: Buffer, mode = 0o600, assertAuthorized: () => void = () => {}): Promise<void> {
    assertAuthorized();
    return new Promise((resolve, reject) => {
      sftp.writeFile(remotePath, content, { mode, flag: 'wx' }, (error) => error ? reject(error) : resolve());
    });
  }

  private async unlinkOptional(sftp: SFTPWrapper, remotePath: string, assertAuthorized: () => void = () => {}): Promise<void> {
    assertAuthorized();
    await new Promise<void>((resolve) => { sftp.unlink(remotePath, () => resolve()); });
  }

  disconnect(hostId: string): void {
    const client = this.connections.get(hostId);
    if (!client) return;
    this.connections.delete(hostId);
    this.identities.delete(hostId);
    this.generations.set(hostId, (this.generations.get(hostId) ?? 0) + 1);
    client.end();
    this.onDisconnected(hostId);
  }

  close(): void {
    for (const hostId of this.connections.keys()) this.disconnect(hostId);
  }
}
