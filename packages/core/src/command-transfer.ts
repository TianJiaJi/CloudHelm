import path from 'node:path';
import type { CommandCall } from './model.js';

/** Syntactic operands only. No file reads, URL requests or argv echoed in audit. */
export function commandTransfer(call: CommandCall): { reads: string[]; sendsData: boolean } {
  const name = path.posix.basename(call.name), reads: string[] = [];
  let sendsData = false;
  if (name !== 'curl') return { reads, sendsData: ['scp', 'sftp', 'rsync', 'nc', 'ncat', 'netcat', 'socat'].includes(name)
    || name === 'git' && (call.semantics?.git?.subcommand ?? call.args[0]) === 'push' };
  const options = new Set(['-d', '--data', '--data-binary', '--data-ascii', '--data-urlencode', '--json',
    '-F', '--form', '--form-string', '-T', '--upload-file', '-K', '--config', '--data-raw']);
  for (let i = 0; i < call.args.length; i++) {
    const arg = call.args[i]!;
    if (arg === '--') break;
    let option = arg, value: string | undefined;
    const equals = arg.indexOf('=');
    if (arg.startsWith('--') && equals > 0) { option = arg.slice(0, equals); value = arg.slice(equals + 1); }
    else if (/^-[dFTK].+/u.test(arg)) { option = arg.slice(0, 2); value = arg.slice(2); }
    if (!options.has(option)) continue;
    value ??= call.args[++i];
    const config = option === '-K' || option === '--config';
    if (!config) sendsData = true;
    if (!value || value === '-') continue;
    if (config || option === '-T' || option === '--upload-file') { reads.push(value); continue; }
    if (option === '--data-raw' || option === '--form-string') continue;
    if (option === '-F' || option === '--form') {
      const marker = /^[^=]+=[@<](.+)$/u.exec(value)?.[1];
      if (marker) reads.push(marker.split(';')[0]!);
    } else if (option === '--data-urlencode') {
      const at = value.indexOf('@'), equals = value.indexOf('=');
      if (at >= 0 && (equals < 0 || at < equals)) reads.push(value.slice(at + 1));
    } else if (value.startsWith('@')) reads.push(value.slice(1));
  }
  return { reads, sendsData };
}
