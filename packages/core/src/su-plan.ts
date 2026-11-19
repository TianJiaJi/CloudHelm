import path from 'node:path';
import type { CommandAnalysis, CommandCall } from './model.js';

export function isSu(call: CommandCall): boolean {
  return call.name === 'su' || call.name === '/bin/su' || call.name === '/usr/bin/su';
}

/** Rebuild one reviewed business command as an operation-level su invocation for
 * the credential-bound native PTY. The working directory moves into the reviewed
 * -c body (it runs as root after authentication), never into an outer wrapper
 * step the invoking account might be unable to enter. The fixed /bin/sh keeps
 * the body's POSIX syntax independent of root's login shell. Returns undefined
 * for anything that is not one literal foreground action; the caller must then
 * not dispatch on this route. */
export function suPtyCommand(analysis: CommandAnalysis, cwd: string): string | undefined {
  const call = analysis.steps?.[0]?.call;
  if (!call || call.dynamic || call.redirects) return undefined;
  // A rebuild that silently dropped pipe, redirection or embedded content would
  // dispatch something other than what was reviewed; such forms stay off.
  if (analysis.hasError || analysis.hasExpansion || analysis.hasPipeline || analysis.hasRedirection
    || analysis.hasCompound || analysis.steps?.length !== 1 || analysis.calls.length !== 1) return undefined;
  if (['true', '/bin/true', '/usr/bin/true'].includes(call.name) || /(?:^|\/)(?:sudo|su)$/u.test(call.name))
    return undefined;
  if (typeof cwd !== 'string' || !path.posix.isAbsolute(cwd) || cwd.length > 4096
    || /[\u0000-\u001f\u007f]/u.test(cwd)) return undefined;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  // 125 mirrors the native wrapper's directory-change failure: the business
  // action never starts when its reviewed working directory is unreachable.
  const body = `cd ${quote(cwd)} || exit 125\n${analysis.raw}`;
  const command = `su -l -s /bin/sh root -c ${quote(body)}`;
  // Leave headroom for the transport's marker prefix inside the 8 KiB exec bound.
  if (Buffer.byteLength(command, 'utf8') > 8000) return undefined;
  return command;
}
