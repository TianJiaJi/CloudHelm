// One-shot read-only probe of the G3 isolated VM: sudo/su availability,
// interpreter presence for a health-endpoint service, systemd, port state
// and leftover artifacts from earlier runs. Read-only; changes nothing.
// Credentials arrive ONLY via G3_* environment variables; every line of
// output is redacted before printing or writing to disk.
import console from 'node:console';
import { mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vmConnect } from './lib/vm-ssh.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const requiredEnv = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
};
const secrets = { password: requiredEnv('G3_CRED'), apiKey: process.env.G3_MODEL_KEY ?? '' };
const vm = { address: requiredEnv('G3_HOST'), port: Number(process.env.G3_PORT ?? '22'), username: requiredEnv('G3_LOGIN') };
const redact = (text) => {
  let value = String(text);
  for (const secret of [secrets.password, secrets.apiKey]) value = value.split(secret).join('[G3-REDACTED]');
  return value;
};

const probes = [
  ['identity', 'id; groups'],
  ['os', 'head -2 /etc/os-release; uname -r'],
  ['sudo-noninteractive', 'sudo -n true 2>&1; echo "probe-exit=$?"'],
  ['sudo-list', 'sudo -n -l 2>&1 | head -6'],
  ['sudo-binary', 'command -v sudo; command -v su'],
  ['python2', 'command -v python2 python2.7; python2 -V 2>&1'],
  ['python3', 'command -v python3; python3 -V 2>&1'],
  ['http-clients', 'command -v curl; command -v wget'],
  ['systemd', 'systemctl --version 2>&1 | head -1'],
  ['port-18080', '(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep 18080 || echo port-18080-free'],
  ['home', 'ls -la "$HOME" | head -24'],
  ['system-units', 'ls /etc/systemd/system/ 2>/dev/null | head -12'],
  ['g3-leftovers', 'ls -la "$HOME"/g3* /etc/systemd/system/g3* 2>&1 | head -12'],
];

const connection = await vmConnect({ ...vm, password: secrets.password });
const results = {};
try {
  for (const [name, command] of probes) {
    try {
      const { code, stdout, stderr } = await connection.exec(command, 20_000);
      results[name] = { code, out: stdout.trim().slice(0, 1200), err: stderr.trim().slice(0, 400) };
    } catch (error) {
      results[name] = { error: String(error?.message ?? error) };
    }
    console.log(`[${name}] ${redact(JSON.stringify(results[name]))}`);
  }
} finally {
  await connection.close();
}
const output = path.join(root, '.cache/g3-real-machine', `vm-probe-${new Date().toISOString().replace(/[-:.T]/gu, '').slice(0, 14)}.json`);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, redact(JSON.stringify({ vm: { address: vm.address, port: vm.port }, results }, null, 2)));
console.log(`probe evidence: ${output}`);
