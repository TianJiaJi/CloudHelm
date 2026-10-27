import type { CommandCall } from './model.js';

/** Effect classification only, never low-risk approval. Accept literal system
 * executables and a deliberately small diagnostic grammar, not arbitrary network
 * traffic, wrappers, output files, flood modes or indefinite probes. */
export function isBoundedDiagnosticCall(call: CommandCall): boolean {
  if (call.dynamic || call.redirects) return false;
  const name = call.name.split('/').at(-1)!;
  if (![name, `/bin/${name}`, `/usr/bin/${name}`, `/sbin/${name}`, `/usr/sbin/${name}`].includes(call.name)) return false;
  const args = call.args;
  if (args.some((arg) => !arg || arg.length > 1024 || /[\u0000-\u0020\u007f$`*?{}\[\]<>]/u.test(arg))) return false;
  if (name === 'ping' || name === 'ping6') return boundedPing(args);
  if (name === 'lscpu') return !args.length || (args.length === 1 && args[0] === '--json');
  if (name === 'nproc') return !args.length || (args.length === 1 && args[0] === '--all');
  if (name === 'lsblk') {
    const switches = new Set(['-a', '-b', '-d', '-f', '-J', '-l', '-n', '-p', '-t', '--json', '--fs', '--bytes', '--list', '--nodeps']);
    let columns = false;
    for (let i = 0; i < args.length; i++) {
      if (switches.has(args[i]!)) continue;
      if (args[i] !== '-o' || columns) return false;
      columns = true;
      const value = args[++i];
      if (!value || !/^(?:NAME|SIZE|TYPE|MOUNTPOINTS?|FSTYPE|FSAVAIL|FSUSE%|UUID|ROTA|RO|MODEL)(?:,(?:NAME|SIZE|TYPE|MOUNTPOINTS?|FSTYPE|FSAVAIL|FSUSE%|UUID|ROTA|RO|MODEL))*$/u.test(value)) return false;
    }
    return true;
  }
  if (name === 'ss') return !args.length || args.every((arg) => /^-[ltunapoe46]+$/u.test(arg));
  if (name === 'ip') {
    const rest = [...args];
    if (['-br', '-brief', '-4', '-6'].includes(rest[0] ?? '')) rest.shift();
    return ['addr', 'address', 'link', 'route'].includes(rest[0] ?? '')
      && (rest.length === 1 || (rest.length === 2 && ['show', 'list'].includes(rest[1]!)));
  }
  return false;
}
function boundedPing(args: string[]): boolean {
  let count: number | undefined, wait: number | undefined, target: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (['-n', '-q', '-4', '-6'].includes(arg)) {
      if (seen.has(arg) || ((arg === '-4' || arg === '-6') && (seen.has('-4') || seen.has('-6')))) return false;
      seen.add(arg); continue;
    }
    const numeric = /^-(c|W)(\d*)$/u.exec(arg);
    if (numeric) {
      const kind = numeric[1]!;
      if (seen.has(kind)) return false;
      seen.add(kind);
      const value = numeric[2] || args[++i];
      if (!value || !/^[1-9]\d?$/u.test(value)) return false;
      if (kind === 'c') count = Number(value); else wait = Number(value);
      continue;
    }
    if (target || arg.startsWith('-') || arg.length > 253
      || !(/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.?$/u.test(arg) || /^[a-fA-F0-9:]{2,45}$/u.test(arg))) return false;
    target = arg;
  }
  return !!target && count !== undefined && count <= 10 && wait !== undefined && wait <= 5;
}
