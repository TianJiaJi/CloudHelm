import { describe, expect, it } from 'vitest';
import { HostKeyError, SshTransport, type SshHost } from '../../packages/adapters/src/ssh-transport.js';

const testKey = process.env.CLOUDHELM_TEST_SSH_KEY;
const run = testKey ? it : it.skip;

describe('SSH transport against an opt-in local SSH server', () => {
  run('verifies the host key, opens a PTY, refuses metadata-unknown replacement and retains a deletion content copy', async () => {
    const transport = new SshTransport();
    const host: SshHost = {
      id: 'smoke-host', label: 'Local test server', address: '127.0.0.1',
      port: Number(process.env.CLOUDHELM_TEST_SSH_PORT ?? '22388'),
      username: process.env.CLOUDHELM_TEST_SSH_USER ?? process.env.USER ?? '',
      auth: 'private-key', privateKeyPath: testKey
    };
    try {
      let fingerprint = '';
      try { await transport.connect(host, {}); }
      catch (error) {
        expect(error).toBeInstanceOf(HostKeyError);
        fingerprint = (error as HostKeyError).fingerprint;
      }
      expect(fingerprint).toMatch(/^SHA256:/u);
      host.fingerprint = fingerprint;
      await transport.connect(host, {});

      const shell = await transport.shell(host.id);
      const output = new Promise<string>((resolve, reject) => {
        let buffer = '';
        const timeout = setTimeout(() => reject(new Error('PTY did not echo the executed command')), 5000);
        shell.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          if (buffer.includes('cloudhelm-pty-ok')) { clearTimeout(timeout); resolve(buffer); }
        });
      });
      shell.write("printf 'cloudhelm-pty-ok\\n'\n");
      expect(await output).toContain('cloudhelm-pty-ok');
      shell.end();

      const remoteRoot = process.env.CLOUDHELM_TEST_REMOTE_ROOT ?? (process.platform === 'darwin' ? '/private/tmp' : '/tmp');
      const remote = `${remoteRoot}/cloudhelm-transport-${Date.now()}`;
      expect(await transport.writeFile(host.id, remote, Buffer.from('first'))).toBeUndefined();
      await expect(transport.writeFile(host.id, remote, Buffer.from('second')))
        .rejects.toMatchObject({ effects: 'none', code: 'metadata-unverifiable' });
      expect((await transport.execFixed(host.id, `cat '${remote}'`)).output).toContain('first');
      const deletedBackup = await transport.deleteFile(host.id, remote);
      expect((await transport.execFixed(host.id, `cat '${deletedBackup}'`)).output).toContain('first');
      await transport.execFixed(host.id, `rm -f -- '${deletedBackup}'`);
    } finally { transport.close(); }
  }, 20_000);
});
