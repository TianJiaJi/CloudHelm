import { supportsSudo, sudoTarget, type CommandAnalysis } from '@cloudhelm/core';

export interface InputPlan { auth?: 'sudo'; aptInstall: boolean }

const APT = ['apt', 'apt-get', '/usr/bin/apt', '/usr/bin/apt-get'];
const APT_TRANSACTIONS = new Set(['install', 'remove', 'purge', 'reinstall', 'upgrade', 'full-upgrade', 'dist-upgrade', 'autoremove']);

/** Authentication is attached to literal sudo processes, including foreground lists. */
export function inputPlan(analysis: CommandAnalysis): InputPlan | undefined {
  if (analysis.hasError || analysis.hasPipeline || analysis.hasRedirection || analysis.hasExpansion) return;
  const first = analysis.calls[0];
  if (!first || first.dynamic || first.redirects) return;
  const sudo = supportsSudo(analysis);
  if (sudo && analysis.steps!.length > 1) return { auth: 'sudo', aptInstall: false };
  let name = first.name;
  let args = first.args;
  if (sudo) {
    const target = sudoTarget(first)!;
    name = target.name;
    args = target.args;
  } else if (analysis.calls.length !== 1 || analysis.hasCompound) return;
  const apt = APT.includes(name);
  const aptInstall = apt && args[0] === 'install' && args.length > 1
    && args.slice(1).every((arg) => /^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?(?:=[a-z0-9.+:~_-]+)?$/iu.test(arg) && !arg.endsWith('-'));
  if (!sudo && !aptInstall) return;
  return { auth: sudo ? 'sudo' : undefined, aptInstall };
}

/** Only the latest complete C-locale apt transaction summary can authorize a bounded yes. */
export function aptHasNoRemovals(output: string): boolean {
  const summaries = [...output.matchAll(/(?:^|[\r\n])(\d+) upgraded, (\d+) newly installed, (\d+) to remove and (\d+) not upgraded\./gu)];
  return summaries.at(-1)?.[3] === '0' && !/(?:REMOVED|essential packages|downgraded|overwrite|configuration file)/iu.test(output);
}

/** apt transactions prompt on stdin unless -y/--yes already answers them; a
 * channel without writable stdin would strand that prompt forever. */
export function aptNeedsPtyStdin(analysis: CommandAnalysis): boolean {
  const call = analysis.steps?.[0]?.call;
  if (!call || call.dynamic || analysis.steps?.length !== 1 || !APT.includes(call.name)) return false;
  if (call.args.some((arg) => arg === '--yes' || arg === '--assume-yes' || (/^-[a-z]+$/iu.test(arg) && arg.includes('y')))) return false;
  const subcommand = call.args.find((arg) => !arg.startsWith('-'));
  return subcommand !== undefined && APT_TRANSACTIONS.has(subcommand);
}
