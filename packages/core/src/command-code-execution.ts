import path from 'node:path';
import type { CommandCall } from './model.js';
import { PROJECT_CODE_COMMANDS } from './command-query-impact.js';

const INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'fish', 'python', 'python3', 'node', 'perl', 'ruby', 'php',
  'awk', 'sed', 'eval', 'source', '.', 'xargs']);
const PACKAGERS = new Set(['apt', 'apt-get', 'dnf', 'yum', 'apk', 'brew']);
const PACKAGE_ACTIONS = new Set(['install', 'reinstall', 'update', 'upgrade', 'dist-upgrade', 'full-upgrade', 'remove', 'purge', 'autoremove']);
const GIT_HOOK_ACTIONS = new Set(['commit', 'checkout', 'switch', 'merge', 'rebase', 'cherry-pick', 'revert', 'pull', 'clone', 'am']);

/** Positive syntax signals, not an exhaustive execution model. A query proof is
 * checked by the caller first; unknown options/configuration remain unproven. */
export function hasCodeExecution(call: CommandCall): boolean {
  const name = path.posix.basename(call.name);
  if (INTERPRETERS.has(name) || PROJECT_CODE_COMMANDS.has(name)) return true;
  if (PACKAGERS.has(name)) return call.args.some((arg) => PACKAGE_ACTIONS.has(arg));
  if (name === 'git') return GIT_HOOK_ACTIONS.has(call.semantics?.git?.subcommand ?? call.args[0] ?? '');
  if (name !== 'docker') return false;
  return ['build', 'buildx', 'run', 'exec', 'start', 'restart'].includes(call.args[0] ?? '')
    || call.args[0] === 'compose' && call.args.slice(1).some((arg) => ['build', 'up', 'run', 'exec', 'start', 'restart', 'watch'].includes(arg));
}
