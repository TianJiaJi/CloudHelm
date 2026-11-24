// Out-of-band SSH access to the G3 isolated VM for harness use only:
// VM state probing, per-round state reset, health endpoint checks and the
// mid-write disconnection trigger. Credentials arrive ONLY via environment
// variables from the calling script; this module never logs or stores them.
import { createRequire } from 'node:module';
import path from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(path.join(root, 'packages/adapters/package.json'));
const { Client } = require('ssh2');

/**
 * Connect to the VM and return { exec, shell, close }.
 * exec(command) resolves { code, stdout, stderr } after exit.
 * shell() is reserved for interactive probing; the disconnection trigger
 * in g3-netcut.mjs opens its own connection instead.
 */
export function vmConnect(config, { readyTimeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const failOnce = (error) => reject(error);
    client.once('error', failOnce);
    client.connect({ host: config.address, port: config.port ?? 22, username: config.username,
      password: config.password, readyTimeout: readyTimeoutMs });
    client.once('ready', () => {
      client.removeListener('error', failOnce);
      client.on('error', () => { /* late errors surface through close */ });
      resolve({
        // options: number (legacy timeout) | { timeoutMs?, stdin?, pty? }. stdin carries
        // e.g. the sudo -S password so the secret never lands in command text.
        exec: (command, options = {}) => new Promise((res, rej) => {
          const config = typeof options === 'number' ? { timeoutMs: options } : options ?? {};
          const { timeoutMs = 20_000, stdin = null, pty = false } = config;
          const execOptions = pty ? { pty: { term: 'dumb', cols: 200, rows: 50, modes: { ECHO: 0 } } } : {};
          client.exec(command, execOptions, (error, stream) => {
            if (error) return rej(error);
            let stdout = '';
            let stderr = '';
            const timer = setTimeout(() => { try { stream.close(); } catch { /* already gone */ } }, timeoutMs);
            stream.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
            stream.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
            stream.on('close', (code) => { clearTimeout(timer); res({ code: code ?? -1, stdout, stderr }); });
            if (stdin !== null) { stream.write(stdin); stream.end(); }
            timer.unref?.();
          });
        }),
        client,
        close: () => new Promise((res) => { try { client.end(); } catch { /* already closed */ } setTimeout(res, 50); }),
      });
    });
  });
}
