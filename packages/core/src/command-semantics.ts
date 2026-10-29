import path from 'node:path';
import type { CommandAnalysis, CommandCall, CommandDirectory } from './model.js';

/** No expansion, local environment, realpath or filesystem I/O. */
export function isLiteralCommandPath(value: string): boolean {
  return !!value && !/[$`*?{}\[\]<>\n\r\u0000]/u.test(value) && !value.startsWith('~');
}

export function changeCommandDirectory(directory: CommandDirectory, value: string): CommandDirectory {
  if (!isLiteralCommandPath(value)) return { state: 'unknown' };
  if (value.startsWith('/')) return { state: 'known', changes: [value] };
  return directory.state === 'known' ? { state: 'known', changes: [...directory.changes, value] } : directory;
}

export function resolveCommandDirectory(directory: CommandDirectory, entryCwd: string): string | null {
  return directory.state === 'unknown' ? null : directory.changes.reduce((cwd, next) => path.posix.resolve(cwd, next), entryCwd);
}

export function resolveCommandPath(value: string, cwd: string | null): string | null {
  if (!isLiteralCommandPath(value) || (!cwd && !value.startsWith('/'))) return null;
  return path.posix.resolve(cwd ?? '/', value);
}

export function callDirectory(call: CommandCall, entryCwd: string): string | null {
  if (call.context?.namespace === 'unknown') return null;
  const directory = call.semantics?.git?.directory ?? call.context?.cwd;
  return directory ? resolveCommandDirectory(directory, entryCwd) : entryCwd;
}

/** Missing evidence must not silently restore an ordinary-command fast path. */
export function hasIncompleteCommandSemantics(analysis: CommandAnalysis): boolean {
  return analysis.calls.some((call) => {
    const name = path.posix.basename(call.name);
    return (analysis.scopedContexts && !call.context)
      || call.context?.cwd.state === 'unknown' || call.context?.namespace === 'unknown'
      || call.context?.identity.state === 'unknown' || !!call.context?.unknownReasons.length
      || call.semantics?.coverage === 'partial'
      || (['git', 'tar'].includes(name) && !call.semantics?.[name as 'git' | 'tar']);
  });
}
