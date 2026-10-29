import { changeCommandDirectory, isLiteralCommandPath, type CommandCall, type CommandDirectory,
  type CommandPathEffect, type CommandSemantics } from '@cloudhelm/core';

const ORDINARY_SUBCOMMANDS = new Set(['add', 'bisect', 'blame', 'branch', 'checkout', 'cherry-pick', 'clone',
  'commit', 'config', 'describe', 'diff', 'fetch', 'help', 'init', 'log', 'merge', 'mv', 'pull', 'restore',
  'revert', 'rm', 'show', 'stash', 'status', 'switch', 'tag', 'rev-parse', 'ls-files', 'ls-tree', 'remote',
  'clean', 'push', 'reset', 'rebase']);
const FLAGS = new Set(['--no-pager', '--paginate', '-p', '-P', '--bare', '--no-replace-objects',
  '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks', '--no-lazy-fetch']);

/** Bounded argv interpretation only; never resolve aliases/config from the local machine. */
export function gitSemantics(call: CommandCall): CommandSemantics {
  let directory: CommandDirectory = call.context?.cwd ?? { state: 'known', changes: [] };
  const paths: CommandPathEffect[] = [];
  const reasons: string[] = [];
  let subcommand: string | undefined;
  let rest: string[] = [];
  let index = 0;
  let changedDirectory = false;
  while (index < call.args.length) {
    const option = call.args[index++]!;
    if (option === '--') { subcommand = call.args[index++]; break; }
    if (!option.startsWith('-')) { subcommand = option; break; }
    if (['--help', '-h', '--version', '-v'].includes(option)) { subcommand = 'help'; index = call.args.length; break; }
    if (FLAGS.has(option)) continue;
    const key = option.startsWith('--') ? option.split('=')[0]!
      : option.startsWith('-C') ? '-C' : option.startsWith('-c') ? '-c' : option;
    if (!['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path'].includes(key)) {
      reasons.push(`Unsupported Git global option: ${key}`);
      // An unknown option may consume the following token; don't guess a subcommand.
      break;
    }
    const attached = option.startsWith('--') ? option.indexOf('=') >= 0 ? option.slice(option.indexOf('=') + 1) : undefined
      : option.length > 2 ? option.slice(2) : undefined;
    const value = attached ?? call.args[index++];
    if (value === undefined) { reasons.push(`Missing Git option value: ${key}`); break; }
    if (key === '-C') {
      changedDirectory = true;
      // Git -C '' leaves cwd unchanged.
      if (value) directory = changeCommandDirectory(directory, value);
      if (directory.state === 'unknown') reasons.push('Dynamic Git working directory');
    } else if (key === '-c') {
      const [configKey, ...parts] = value.split('=');
      if (!/^core\.quotepath$/iu.test(configKey ?? '') || !/^(?:true|false|yes|no|0|1)$/iu.test(parts.join('='))) {
        reasons.push('Git configuration may change execution or alias semantics');
      }
    } else if (key === '--git-dir' || key === '--work-tree') {
      if (!isLiteralCommandPath(value)) reasons.push(`Unresolved Git ${key}`);
      paths.push({ kind: 'read', path: value, directory }, { kind: 'write', path: value, directory });
    } else {
      reasons.push(`Git environment/execution option requires additional evidence: ${key}`);
    }
  }
  rest = call.args.slice(index);
  if (changedDirectory) paths.push({ kind: 'read', path: '.', directory }, { kind: 'write', path: '.', directory });
  if (!subcommand || !ORDINARY_SUBCOMMANDS.has(subcommand)) reasons.push('Unknown or missing Git subcommand');
  if (call.dynamic) reasons.push('Dynamic Git arguments');
  return { coverage: reasons.length ? 'partial' : 'complete', unknownReasons: reasons,
    git: { subcommand, args: rest, directory, paths: paths.map((effect) => ({ ...effect, directory })) } };
}
