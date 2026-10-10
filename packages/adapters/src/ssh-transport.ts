import { openIntegratedShell } from './shell-integration.js';
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
}

export interface AuthMaterial {
  password?: string;
  passphrase?: string;
}

export interface SshLoginPrompt {
  hostId: string;
  username: string;
  text: string;
  echo: boolean;
}

export type SshLoginChallenge = (prompt: SshLoginPrompt) => Promise<string | null>;

async function connectClient(host: SshHost, secret: AuthMaterial, socket?: ClientChannel, challenge?: SshLoginChallenge, signal?: AbortSignal): Promise<Client> {
  signal?.throwIfAborted();
  let observed: string | undefined;
  const config: ConnectConfig = {
    host: host.address, port: host.port, username: host.username, sock: socket,
    // A keyboard-interactive challenge can remain open while the user reads the
    // server prompt and enters an OTP. Its UI request expires after two minutes.
    readyTimeout: challenge ? 150_000 : 20_000,
    keepaliveInterval: 15_000, keepaliveCountMax: 3, tryKeyboard: !!challenge,
    hostVerifier(key: Buffer) {
      observed = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`;
      return observed === host.fingerprint;
    }
  };
  if (host.auth === 'agent') {
    const agent = process.env.SSH_AUTH_SOCK;
    if (!agent) throw new Error('SSH Agent is unavailable');
    config.agent = agent;
  } else if (host.auth === 'private-key') {
    if (!host.privateKeyPath) throw new Error('Private key path is required');
    config.privateKey = await readFile(host.privateKeyPath);
    if (secret.passphrase) config.passphrase = secret.passphrase;
  } else {
    if (!secret.password) throw new Error('SSH password is required');
    config.password = secret.password;
  }
  return new Promise((resolve, reject) => {
    const client = new Client();
    if (challenge) client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
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
      signal?.removeEventListener('abort', abort);
      client.on('error', () => {});
      client.end();
      reject(observed && observed !== host.fingerprint ? new HostKeyError(observed, host.fingerprint) : error);
    };
    const abort = () => fail(new Error('SSH connection timed out'));
    client.once('ready', () => {
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
  private readonly generations = new Map<string, number>();

  constructor(private readonly onDisconnected: (hostId: string) => void = () => {}) {}

  async connect(host: SshHost, secret: AuthMaterial, jump?: { host: SshHost; secret: AuthMaterial }, challenge?: SshLoginChallenge, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.disconnect(host.id);
    let socket: ClientChannel | undefined;
    if (jump) {
      let jumpClient = this.connections.get(jump.host.id);
      if (!jumpClient) {
        jumpClient = await connectClient(jump.host, jump.secret, undefined, challenge, signal);
        if (signal?.aborted) { jumpClient.end(); signal.throwIfAborted(); }
        this.registerConnection(jump.host.id, jumpClient);
      }
      socket = await forwardSocket(jumpClient, host, signal);
    }
    let client: Client;
    try { client = await connectClient(host, secret, socket, challenge, signal); }
    catch (error) { socket?.end(); throw error; }
    if (signal?.aborted) { client.end(); signal.throwIfAborted(); }
    this.registerConnection(host.id, client);
  }

  private registerConnection(hostId: string, client: Client): void {
    if (this.connections.has(hostId)) this.disconnect(hostId);
    this.connections.set(hostId, client);
    this.generations.set(hostId, (this.generations.get(hostId) ?? 0) + 1);
    client.once('close', () => {
      if (this.connections.get(hostId) !== client) return;
      this.connections.delete(hostId);
      this.generations.set(hostId, (this.generations.get(hostId) ?? 0) + 1);
      this.onDisconnected(hostId);
    });
  }

  isConnected(hostId: string): boolean { return this.connections.has(hostId); }
  private readonly commandPreflights = new Map<string, { generation: number; promise: Promise<void> }>();

  private async checkCommandEnvironment(hostId: string): Promise<void> {
    const generation = this.connectionGeneration(hostId);
    const previous = this.commandPreflights.get(hostId);
    if (previous?.generation === generation) return previous.promise;
    const promise = this.execFixed(hostId, `python3 -I -c 'import pty, fcntl, termios, socket, subprocess, shutil'`).then((result) => {
      if (result.exitCode !== 0) throw new Error('远端需要可用的 POSIX Python 3；请安装后继续');
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
    return new Promise((resolve, reject) => {
      client.exec(command, (error, channel) => {
        if (error) { reject(error); return; }
        let output = '';
        let exitCode = -1;
        const timer = setTimeout(() => { channel.close(); reject(new Error('远端环境检查超时；业务命令未发送')); }, 15_000);
        channel.on('error', (error: Error) => { clearTimeout(timer); reject(error); });
        channel.on('data', (data: Buffer) => { output = (output + data.toString('utf8')).slice(-4096); });
        channel.stderr.on('data', (data: Buffer) => { output = (output + data.toString('utf8')).slice(-4096); });
        channel.on('exit', (code: number) => { exitCode = code; });
        channel.on('close', () => { clearTimeout(timer); resolve({ exitCode, output }); });
      });
    });
  }

  async openPipe(hostId: string, command: string): Promise<ClientChannel> {
    const client = this.connections.get(hostId);
    if (!client) throw new Error('Host is not connected');
    return new Promise((resolve, reject) => {
      client.exec(command, (error, channel) => error ? reject(error) : resolve(channel));
    });
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
      throw new Error('Direct command execution requires Python 3 on the host; no command was sent.');
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

  async integratedShell(hostId: string, cols = 100, rows = 30) {
    const client = this.connections.get(hostId);
    if (!client) throw new Error('Host is not connected');
    return openIntegratedShell(client, cols, rows);
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

  /** Read a small regular script for policy analysis; never follow symlinks or expose it to the model. */
  async inspectScript(hostId: string, absolutePath: string): Promise<{ source: string; sha256: string }> {
    return this.withSftp(hostId, async (sftp) => {
      await this.checkSafeParent(sftp, absolutePath);
      const stat = await this.lstatOptional(sftp, absolutePath);
      if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) throw new Error('Script is not a small regular file');
      const bytes = await this.readSftpFile(sftp, absolutePath);
      if (bytes.length > 65_536 || bytes.includes(0)) throw new Error('Script content is not inspectable text');
      const source = bytes.toString('utf8');
      if (!Buffer.from(source, 'utf8').equals(bytes)) throw new Error('Script encoding is not valid UTF-8');
      return { source, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
  }

  /** Writes through a private temporary file and retains a private backup of an overwritten file. */
  async writeFile(hostId: string, absolutePath: string, content: Buffer, assertAuthorized: () => void = () => {}): Promise<string | undefined> {
    if (content.length > 1_048_576) throw new Error('Structured writes are limited to 1 MiB');
    let effects: 'none' | 'possible' = 'none';
    try { return await this.withSftp(hostId, async (sftp) => {
      await this.checkSafeParent(sftp, absolutePath);
      const existing = await this.lstatOptional(sftp, absolutePath);
      if (existing?.isSymbolicLink() || existing?.isDirectory()) throw new Error('Target must be a regular file, not a symlink or directory');
      if (existing && existing.size > 1_048_576) throw new Error('Existing file is too large for a managed backup');
      const backup = existing ? `${absolutePath}.cloudhelm-backup-${randomUUID()}` : undefined;
      if (backup) {
        const original = await this.readSftpFile(sftp, absolutePath);
        effects = 'possible';
        await this.writeSftpFile(sftp, backup, original, 0o600, assertAuthorized);
      }
      const temporary = `${absolutePath}.cloudhelm-new-${randomUUID()}`;
      try {
        effects = 'possible';
        await this.writeSftpFile(sftp, temporary, content, existing ? existing.mode & 0o777 : 0o600, assertAuthorized);
        await new Promise<void>((resolve, reject) => {
          assertAuthorized();
          sftp.ext_openssh_rename(temporary, absolutePath, (error) => error ? reject(error) : resolve());
        });
      } catch (error) {
        await this.unlinkOptional(sftp, temporary, assertAuthorized).catch(() => undefined);
        throw error;
      }
      return backup;
    }); } catch (error) {
      throw new RemoteFileError(effects, !!error && typeof error === 'object' && 'code' in error && (error.code === 3 || error.code === 'EACCES' || error.code === 'EPERM'), error instanceof Error ? error.message : undefined);
    }
  }

  /** Deletes regular files only, preserving a separate recovery copy. */
  async deleteFile(hostId: string, absolutePath: string, assertAuthorized: () => void = () => {}): Promise<string> {
    let effects: 'none' | 'possible' = 'none';
    try { return await this.withSftp(hostId, async (sftp) => {
      await this.checkSafeParent(sftp, absolutePath);
      const existing = await this.lstatOptional(sftp, absolutePath);
      if (!existing || existing.isDirectory() || existing.isSymbolicLink()) throw new Error('Only an existing regular file can be deleted');
      if (existing.size > 1_048_576) throw new Error('File is too large for a managed backup');
      const backup = `${absolutePath}.cloudhelm-backup-${randomUUID()}`;
      effects = 'possible';
      await this.writeSftpFile(sftp, backup, await this.readSftpFile(sftp, absolutePath), 0o600, assertAuthorized);
      await new Promise<void>((resolve, reject) => {
        assertAuthorized();
        sftp.unlink(absolutePath, (error) => error ? reject(error) : resolve());
      });
      return backup;
    }); } catch (error) {
      throw new RemoteFileError(effects, !!error && typeof error === 'object' && 'code' in error && (error.code === 3 || error.code === 'EACCES' || error.code === 'EPERM'), error instanceof Error ? error.message : undefined);
    }
  }

  private async withSftp<T>(hostId: string, action: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    const client = this.connections.get(hostId);
    if (!client) throw new Error('Host is not connected');
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((error, instance) => error ? reject(error) : resolve(instance));
    });
    try { return await action(sftp); }
    finally { sftp.end(); }
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

  private async readSftpFile(sftp: SFTPWrapper, remotePath: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      sftp.readFile(remotePath, (error, data) => error ? reject(error) : resolve(data));
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
    this.generations.set(hostId, (this.generations.get(hostId) ?? 0) + 1);
    client.end();
    this.onDisconnected(hostId);
  }

  close(): void {
    for (const hostId of this.connections.keys()) this.disconnect(hostId);
  }
}
