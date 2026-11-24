// One-off G3 VM check CLI: runs the read-only preflight (SELinux, sudo
// password-injection probe, toolchain, port, leftovers) and the deterministic
// deployment reset, printing the redacted result. Validates the out-of-band
// machinery before any paid model round and resets the VM between rounds.
// Credentials arrive ONLY via environment variables.
import console from 'node:console';
import process from 'node:process';
import { vmPreflight, vmResetDeployment } from './lib/vm-lifecycle.mjs';

const requiredEnv = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}：G3 凭据只经环境变量注入`);
  return value;
};
const password = requiredEnv('G3_CRED');
const vm = { address: requiredEnv('G3_HOST'), port: Number(process.env.G3_PORT ?? '22'), username: requiredEnv('G3_LOGIN') };
const redact = (text) => String(text).split(password).join('[G3-REDACTED]');

console.log('[preflight] ' + redact(JSON.stringify(await vmPreflight(vm, password))));
console.log('[reset] ' + redact(JSON.stringify(await vmResetDeployment(vm, password))));
