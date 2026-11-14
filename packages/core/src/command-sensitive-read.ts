import path from 'node:path';
import type { CommandAnalysis } from './model.js';
import { callDirectory, resolveCommandDirectory, resolveCommandPath } from './command-semantics.js';
import { isSensitiveReadPath } from './sensitive-read.js';
import { commandTransfer } from './command-transfer.js';

function literalPath(value: string, cwd: string | null): string | null {
  return resolveCommandPath(value.replace(/^(['"])(.*)\1$/u, '$2'), cwd);
}

export function hasSensitiveCommandRead(analysis: CommandAnalysis, cwd: string): boolean {
  if (analysis.readRedirectEffects?.some((effect) => isSensitiveReadPath(literalPath(effect.target,
    resolveCommandDirectory(effect.context.cwd, cwd)) ?? effect.target))) return true;
  return analysis.calls.some((call) => {
    const name = path.posix.basename(call.name);
    if (name === 'xauth') return true;
    if (commandTransfer(call).reads.some((arg) => isSensitiveReadPath(literalPath(arg, callDirectory(call, cwd)) ?? arg))) return true;
    if (name === 'tar' && call.semantics?.tar) {
      return call.semantics.tar.paths.some((effect) => effect.kind === 'read'
        && isSensitiveReadPath(literalPath(effect.path, resolveCommandDirectory(effect.directory, cwd)) ?? ''))
        || call.semantics.coverage === 'partial' && call.args.some((arg) => isSensitiveReadPath(literalPath(arg, callDirectory(call, cwd)) ?? ''));
    }
    if (!['cat', 'grep', 'head', 'tail', 'less', 'more', 'sed', 'awk', 'bash', 'sh', 'zsh', 'source', '.',
      'cp', 'mv', 'rsync', 'scp', 'tar', 'find', 'tee', 'base64', 'xxd', 'od', 'hexdump', 'strings'].includes(name)) return false;
    return call.args.some((arg) => /\$\{?XAUTHORITY\}?/u.test(arg)
      || isSensitiveReadPath(literalPath(arg, callDirectory(call, cwd)) ?? arg.replace(/^(['"])(.*)\1$/u, '$2')));
  });
}
