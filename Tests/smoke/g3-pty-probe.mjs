// G3 diagnostic probe: capture the raw PTY byte stream of the exact native sudo
// dispatch the product sends (marker prompt + controlled password injection) on
// a host whose login user is NOT in sudoers, to establish why the transport-level
// sudoers-denial classification (and with it the confirmed su fallback offer)
// does not fire in either build. Out-of-band evidence only; nothing is changed
// on the VM (the dispatched command is the same failing mkdir the app ran).
import console from 'node:console';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { vmConnect } from './lib/vm-ssh.mjs';

const env = () => {
  const host = process.env.G3_HOST, port = Number(process.env.G3_PORT ?? '22');
  const login = process.env.G3_LOGIN ?? 'admin', password = process.env.G3_CRED;
  if (!host || !password) throw new Error('G3_HOST and G3_CRED are required');
  return { host, port, login, password };
};

const nonce = [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
const markerPrompt = `\rcloudhelm:${nonce} password: `;
const q = (v) => `'${v.replaceAll("'", "'\\''")}'`;
const sudoCommand = `sudo -k -p ${q(markerPrompt)} -- install -d -m 755 -o root -g root /usr/local/share/g3-health`;
const script = `cd ${q('/usr/local/share')} || exit 125\n${sudoCommand}`;
const rendered = `exec /usr/bin/env -i PATH=${q('/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin')} LC_ALL=C /bin/sh -c ${q(script)}`;

const SUDO_DENIED = /(?:^|[\r\n])(?:sudo:[^\r\n]{0,256}(?:not allowed to execute|not in the sudoers|may not run sudo)|[a-z_][a-z0-9_.-]{0,63}[$]? is not in the sudoers file\b|Sorry,\s*user [^\r\n]{1,128} (?:is not allowed to execute|may not run sudo)\b)/iu;
const OUTCOME_DENIED = /(?:^|[\r\n])sudo:\s*[^\r\n]*(?:not allowed to execute|not in the sudoers|may not run sudo)/iu;

const { host, port, login, password } = env();
const t0 = Date.now();
const rel = () => `${Date.now() - t0}ms`;
const vm = await vmConnect({ address: host, port, username: login, password });
const client = vm.client;
const result = await new Promise((resolve, reject) => {
  const chunks = [];
  let raw = '';
  let injected = false;
  client.exec(rendered, { pty: { term: 'dumb', cols: 100, rows: 30, modes: { ECHO: 0 } } }, (error, stream) => {
    if (error) return reject(error);
    stream.on('data', (chunk) => {
      const text = chunk.toString('latin1');
      chunks.push({ at: rel(), bytes: JSON.stringify(text) });
      raw += text;
      if (!injected && raw.includes(`cloudhelm:${nonce}`)) {
        injected = true;
        setTimeout(() => { try { stream.write(`${password}\n`); chunks.push({ at: rel(), event: 'password-injected' }); } catch { /* stream gone */ } }, 300);
      }
    });
    stream.stderr.on('data', (chunk) => { chunks.push({ at: rel(), stderr: JSON.stringify(chunk.toString('latin1')) }); });
    stream.on('exit', (code) => { chunks.push({ at: rel(), event: 'exit', code }); });
    stream.on('close', () => { chunks.push({ at: rel(), event: 'close' }); resolve({ chunks, raw }); });
    setTimeout(() => { try { stream.close(); } catch { /* already closed */ } }, 30_000).unref?.();
  });
});
await vm.close();

console.log(JSON.stringify({ probe: 'g3-pty-probe', rendered: rendered.replace(password, '<redacted>'), chunks: result.chunks }, null, 1));
const { raw } = result;
const denialAt = raw.indexOf('not in the sudoers');
console.log('denial present:', denialAt >= 0);
if (denialAt >= 0) {
  const before = raw.slice(Math.max(0, denialAt - 120), denialAt);
  console.log('raw before denial:', JSON.stringify(before));
  console.log('raw around denial:', JSON.stringify(raw.slice(Math.max(0, denialAt - 120), denialAt + 80)));
}
console.log('SUDO_DENIED matches raw:', SUDO_DENIED.test(raw));
console.log('OUTCOME_DENIED matches raw:', OUTCOME_DENIED.test(raw));
console.log('marker seen:', raw.includes(`cloudhelm:${nonce}`));
