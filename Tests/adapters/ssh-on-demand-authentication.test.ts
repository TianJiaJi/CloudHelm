import { createHash, createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Server, utils, type Connection } from 'ssh2';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { HostKeyError, SshTransport, type SshHost, type SshLoginChallenge } from '../../packages/adapters/src/ssh-transport.js';

// Local protocol fixture only: synthetic keys, loopback, no OS login or remote shell.
let server: Server, host: SshHost, directory: string, plainKey: string, encryptedKey: string;
let mode: 'none' | 'password' | 'publickey' | 'keyboard' | 'keyboard-repeat' | 'reject';
let methods: string[], sessions: number;
const connections = new Set<Connection>(), transports: SshTransport[] = [];
beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'cloudhelm-ssh-auth-'));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } });
  const parsed = utils.parseKey(privateKey);
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Invalid synthetic key');
  plainKey = path.join(directory, 'plain'); encryptedKey = path.join(directory, 'encrypted');
  await writeFile(plainKey, privateKey);
  await writeFile(encryptedKey, createPrivateKey(privateKey).export({ type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'synthetic-phrase' }));
  server = new Server({ hostKeys: [privateKey] }, (client) => {
    connections.add(client); client.on('close', () => connections.delete(client)); client.on('error', () => {});
    client.on('session', (_accept, reject) => { sessions++; reject(); });
    client.on('authentication', (context) => {
      methods.push(context.method);
      if (context.username !== 'root') { context.reject(); return; }
      if (mode === 'none' && context.method === 'none') { context.accept(); return; }
      if (mode === 'password' && context.method === 'password' && context.password === 'synthetic-password') { context.accept(); return; }
      if (mode === 'publickey' && context.method === 'publickey' && context.key.data.equals(parsed.getPublicSSH())
        && (!context.signature || parsed.verify(context.blob!, context.signature, context.hashAlgo) === true)) { context.accept(); return; }
      if ((mode === 'keyboard' || mode === 'keyboard-repeat') && context.method === 'keyboard-interactive') {
        const prompt = () => context.prompt([{ prompt: 'Verification code', echo: false }], (answers) => {
          if (answers[0] === 'synthetic-otp') context.accept();
          else if (mode === 'keyboard-repeat') prompt();
          else context.reject(['keyboard-interactive']);
        });
        prompt(); return;
      }
      context.reject([mode === 'publickey' || mode === 'reject' ? 'publickey' : mode.startsWith('keyboard') ? 'keyboard-interactive' : 'password']);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No loopback port');
  host = { id: 'fixture', label: 'Synthetic SSH', address: '127.0.0.1', port: address.port, username: 'root', auth: 'password',
    fingerprint: `SHA256:${createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/u, '')}` };
});
beforeEach(() => { mode = 'password'; methods = []; sessions = 0; });
afterEach(() => {
  for (const transport of transports.splice(0)) transport.close();
  for (const connection of connections) connection.end();
  expect(sessions).toBe(0);
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});
function connect(challenge: SshLoginChallenge, overrides: Partial<SshHost> = {}, signal?: AbortSignal) {
  const transport = new SshTransport(); transports.push(transport);
  return { transport, result: transport.connect({ ...host, ...overrides }, {}, undefined, challenge, signal, { onDemandAuthentication: true }) };
}

it.each(['password', 'private-key'] as const)('never asks or loads credentials when none authentication succeeds (%s)', async (auth) => {
  mode = 'none'; const challenge = vi.fn(async () => 'must-not-be-requested');
  const f = connect(challenge, { auth, privateKeyPath: path.join(directory, 'does-not-exist') }); await f.result;
  expect(f.transport.isConnected(host.id)).toBe(true); expect(methods).toEqual(['none']); expect(challenge).not.toHaveBeenCalled();
});
it('rejects a legacy Agent configuration before accessing the network or requesting a replacement secret', async () => {
  const challenge = vi.fn(async () => 'must-not-be-requested');
  await expect(connect(challenge, { auth: 'agent' }).result).rejects.toThrow('SSH Agent 已停用');
  expect(methods).toEqual([]); expect(challenge).not.toHaveBeenCalled();
});
it('requests a password only after negotiated demand, and permits bounded correction', async () => {
  const challenge = vi.fn<SshLoginChallenge>(async (prompt) => {
    expect(methods[0]).toBe('none'); expect(prompt).toMatchObject({ hostId: host.id, username: 'root', kind: 'password', echo: false });
    return prompt.attempt === 1 ? 'wrong' : 'synthetic-password';
  });
  await connect(challenge).result;
  expect(challenge.mock.calls.map(([prompt]) => prompt.attempt)).toEqual([1, 2]); expect(methods).toEqual(['none', 'password', 'password']);
});
it.each([null, 'wrong'] as const)('stops on cancellation or exhaustion without another identity (%s)', async (answer) => {
  const challenge = vi.fn(async () => answer), f = connect(challenge);
  await expect(f.result).rejects.toMatchObject({ code: answer === null ? 'cancelled' : 'attempts-exhausted' });
  expect(challenge).toHaveBeenCalledTimes(answer === null ? 1 : 3);
  expect(methods).toEqual(answer === null ? ['none'] : ['none', 'password', 'password', 'password']);
  expect(f.transport.isConnected(host.id)).toBe(false);
});
it.each(['private-key'] as const)('honors a server password request independently of ordinary login configuration (%s)', async (auth) => {
  const challenge = vi.fn(async () => 'synthetic-password');
  await connect(challenge, { auth, privateKeyPath: path.join(directory, 'not-read') }).result;
  expect(challenge).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'password' }));
  expect(methods).toEqual(['none', 'password']);
});
it('uses an unencrypted key without a passphrase question', async () => {
  mode = 'publickey'; const challenge = vi.fn(async () => 'must-not-be-requested');
  await connect(challenge, { auth: 'private-key', privateKeyPath: plainKey }).result;
  expect(challenge).not.toHaveBeenCalled(); expect(methods).toEqual(['none', 'publickey', 'publickey']);
});
it('requests an encrypted key passphrase only when its actual parser needs it', async () => {
  mode = 'publickey'; const challenge = vi.fn<SshLoginChallenge>(async (prompt) => {
    expect(methods).toEqual(['none']); expect(prompt.kind).toBe('key-passphrase');
    return prompt.attempt === 1 ? 'wrong' : 'synthetic-phrase';
  });
  await connect(challenge, { auth: 'private-key', privateKeyPath: encryptedKey }).result;
  expect(challenge).toHaveBeenCalledTimes(2); expect(methods).toEqual(['none', 'publickey', 'publickey']);
});
it('bounds incorrect encrypted-key passphrases without sending a key or changing authentication', async () => {
  mode = 'publickey'; const challenge = vi.fn(async () => 'wrong');
  await expect(connect(challenge, { auth: 'private-key', privateKeyPath: encryptedKey }).result).rejects.toMatchObject({ code: 'attempts-exhausted' });
  expect(challenge).toHaveBeenCalledTimes(3); expect(methods).toEqual(['none']);
});
it('routes a real keyboard-interactive OTP through the private challenge callback', async () => {
  mode = 'keyboard'; const challenge = vi.fn(async () => 'synthetic-otp');
  await connect(challenge).result;
  expect(challenge).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'keyboard-interactive', text: 'Verification code', echo: false }));
});
it('bounds repeated keyboard challenges within the same authentication round', async () => {
  mode = 'keyboard-repeat'; const challenge = vi.fn(async () => 'wrong');
  await expect(connect(challenge).result).rejects.toMatchObject({ code: 'attempts-exhausted' });
  expect(challenge).toHaveBeenCalledTimes(3); expect(methods).toEqual(['none', 'keyboard-interactive']);
});
it('never prompts on an untrusted host key or an unavailable configured method', async () => {
  const challenge = vi.fn(async () => 'must-not-be-requested');
  await expect(connect(challenge, { fingerprint: 'SHA256:wrong' }).result).rejects.toBeInstanceOf(HostKeyError);
  expect(methods).toEqual([]); expect(challenge).not.toHaveBeenCalled();
  mode = 'reject'; await expect(connect(challenge).result).rejects.toMatchObject({ code: 'authentication-rejected' });
  expect(challenge).not.toHaveBeenCalled(); expect(methods).toEqual(['none']);
});
it('does not submit an answer returned after connection cancellation', async () => {
  let answer!: (value: string) => void;
  const challenge = vi.fn(() => new Promise<string>((resolve) => { answer = resolve; }));
  const abort = new AbortController(), f = connect(challenge, {}, abort.signal);
  const failed = expect(f.result).rejects.toThrow('timed out');
  await vi.waitFor(() => expect(challenge).toHaveBeenCalledOnce(), { timeout: 5000 });
  abort.abort(); await failed; answer('synthetic-password');
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(methods).toEqual(['none']); expect(f.transport.isConnected(host.id)).toBe(false);
});
