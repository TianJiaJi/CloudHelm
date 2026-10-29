import { changeCommandDirectory, isLiteralCommandPath, type CommandCall, type CommandDirectory,
  type CommandPathEffect, type CommandSemantics, type TarCommandSemantics } from '@cloudhelm/core';

const MODES: Record<string, TarCommandSemantics['mode']> = { c: 'create', create: 'create', t: 'list', list: 'list', x: 'extract', extract: 'extract', get: 'extract' };
const FLAGS = new Set(['z', 'j', 'J', 'v', 'h', 'p', 'numeric-owner', 'gzip', 'gunzip', 'ungzip', 'bzip2', 'xz', 'verbose', 'dereference']);
// These are not trusted: arity only prevents their values becoming fake operands.
const OPAQUE_VALUES = new Set(['T', 'I', 'X', 'files-from', 'use-compress-program', 'exclude-from', 'checkpoint-action',
  'to-command', 'rsh-command', 'transform', 'xform', 'exclude', 'warning', 'owner', 'group', 'mode']);

/** GNU/POSIX common forms only. Unknown options keep coverage partial. */
export function tarSemantics(call: CommandCall): CommandSemantics {
  const entry: CommandDirectory = call.context?.cwd ?? { state: 'known', changes: [] };
  let directory = entry;
  const reasons: string[] = [];
  const paths: CommandPathEffect[] = [];
  const archives: string[] = [];
  const operands: Array<{ path: string; directory: CommandDirectory }> = [];
  const extractionDirectories: CommandDirectory[] = [];
  const modes: NonNullable<TarCommandSemantics['mode']>[] = [];
  let index = 0;
  let endOptions = false;
  let help = false;
  const value = (key: string, attached?: string): string | undefined => {
    const result = attached ?? call.args[index++];
    if (result === undefined || result === '') reasons.push(`Missing tar option value: ${key}`);
    return result;
  };
  const option = (key: string, attached?: string) => {
    if (Object.hasOwn(MODES, key)) { modes.push(MODES[key]!); return; }
    if (FLAGS.has(key)) return;
    if (key === 'f' || key === 'file') {
      const archive = value(key, attached);
      if (archive !== undefined) archives.push(archive);
      return;
    }
    if (key === 'C' || key === 'directory') {
      const target = value(key, attached);
      directory = target === undefined ? { state: 'unknown' } : changeCommandDirectory(directory, target);
      extractionDirectories.push(directory);
      return;
    }
    if (key === 'help' || key === 'version') { help = call.args.length === 1; return; }
    reasons.push(`Unsupported tar option: ${key}`);
    if (OPAQUE_VALUES.has(key)) {
      const operand = value(key, attached);
      if (operand && ['T', 'X', 'files-from', 'exclude-from'].includes(key)) {
        paths.push({ kind: 'read', path: operand, directory: entry });
      }
    }
  };
  while (index < call.args.length) {
    const arg = call.args[index++]!;
    if (!endOptions && arg === '--') { endOptions = true; continue; }
    if (!endOptions && arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const key = arg.slice(2, equals < 0 ? undefined : equals);
      option(key, equals < 0 ? undefined : arg.slice(equals + 1));
      if (equals >= 0 && !['file', 'directory', ...OPAQUE_VALUES].includes(key)) reasons.push('Unexpected tar option value');
      continue;
    }
    const oldStyle = !endOptions && index === 1 && /^[a-zA-Z]+$/u.test(arg);
    if (!endOptions && (oldStyle || arg.startsWith('-') && arg !== '-')) {
      const flags = oldStyle ? arg : arg.slice(1);
      for (let offset = 0; offset < flags.length; offset++) {
        const flag = flags[offset]!;
        const takesValue = ['f', 'C', ...OPAQUE_VALUES].includes(flag);
        const attached = !oldStyle && takesValue && offset + 1 < flags.length ? flags.slice(offset + 1) : undefined;
        option(flag, attached);
        if (attached !== undefined) break;
      }
      continue;
    }
    operands.push({ path: arg, directory });
  }
  const mode = modes[0];
  if (!help && modes.length !== 1) reasons.push('Missing, repeated or conflicting tar operation');
  if (!help && archives.length !== 1) reasons.push('Archive path is missing or repeated');
  if (mode === 'extract') reasons.push('Archive member destinations have not been inspected');
  // Preserve known hazards even when another part of the command is opaque.
  for (const archive of archives) {
    if (archive === '-') continue;
    const kinds = modes.length ? modes.map((item) => item === 'create' ? 'write' as const : 'read' as const)
      : ['read' as const, 'write' as const];
    for (const kind of new Set(kinds)) {
      paths.push({ kind, path: archive, directory: entry });
    }
  }
  if (modes.includes('create')) {
    paths.push(...operands.map((operand) => ({ kind: 'read' as const, ...operand, recursive: true })));
    if (!operands.length) reasons.push('No explicit archive members');
  }
  if (modes.includes('extract')) {
    for (const target of extractionDirectories.length ? extractionDirectories : [directory]) {
      paths.push({ kind: 'write', path: '.', directory: target, recursive: true });
    }
  }
  if (call.dynamic || paths.some((effect) => !isLiteralCommandPath(effect.path) || effect.directory.state === 'unknown')) {
    reasons.push('Dynamic tar path or directory');
  }
  return { coverage: reasons.length ? 'partial' : 'complete', unknownReasons: [...new Set(reasons)], tar: { mode, paths } };
}
