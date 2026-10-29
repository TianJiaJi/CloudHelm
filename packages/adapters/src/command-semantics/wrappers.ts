import path from 'node:path';
import { changeCommandDirectory, type CommandCall, type CommandContext } from '@cloudhelm/core';

export function entryContext(): CommandContext {
  return { cwd: { state: 'known', changes: [] }, identity: { state: 'inherited' }, namespace: 'inherited', unknownReasons: [] };
}
export function unknownContext(context: CommandContext, reason: string): CommandContext {
  return { ...context, cwd: { state: 'unknown' }, unknownReasons: [...context.unknownReasons, reason] };
}

const VALUE_OPTIONS: Record<string, Set<string>> = {
  sudo: new Set(['-u', '-g', '-p', '-C', '-R', '-D', '-T', '-h', '--user', '--group', '--prompt', '--close-from', '--chroot', '--chdir', '--command-timeout', '--host']),
  env: new Set(['-u', '-C', '--unset', '--chdir']),
  command: new Set(), exec: new Set(['-a']), nohup: new Set(), busybox: new Set(),
  nice: new Set(['-n', '--adjustment']), time: new Set(['-f', '-o', '--format', '--output']),
  timeout: new Set(['-k', '-s', '--kill-after', '--signal']), setsid: new Set(),
  xargs: new Set(['-a', '-d', '-E', '-I', '-L', '-n', '-P', '-s', '--arg-file', '--delimiter', '--eof', '--replace', '--max-lines', '--max-args', '--max-procs', '--max-chars']),
  runuser: new Set(['-u', '-g', '-G', '--user', '--group', '--supp-group'])
};
const FLAGS: Record<string, Set<string>> = {
  sudo: new Set(['-n', '-k', '-K', '-H', '-E', '-b', '--non-interactive', '--reset-timestamp', '--remove-timestamp', '--set-home', '--preserve-env']),
  env: new Set(['-i', '-', '--ignore-environment', '-0', '--null']),
  command: new Set(['-p']), exec: new Set(['-c', '-l']), nohup: new Set(), busybox: new Set(),
  nice: new Set(), time: new Set(['-p']), timeout: new Set(['--foreground', '--preserve-status', '-v', '--verbose']),
  setsid: new Set(['-f', '-w', '--fork', '--wait']), xargs: new Set(['-0', '-r', '--null', '--no-run-if-empty']), runuser: new Set()
};

/** Shares argument boundaries and context transformations with wrapper extraction. */
export function launcherInfo(call: CommandCall): { command?: CommandCall; context: CommandContext; splitIndex?: number } {
  const name = path.posix.basename(call.name);
  const values = Object.hasOwn(VALUE_OPTIONS, name) ? VALUE_OPTIONS[name] : undefined;
  let context = call.context ?? entryContext();
  if (!values) return { context };
  if (name === 'sudo') context = { ...context, identity: { state: 'requested', user: 'root' } };
  let index = 0;
  const uncertain = (reason: string) => { context = { ...context, unknownReasons: [...context.unknownReasons, reason] }; };
  while (index < call.args.length) {
    const arg = call.args[index]!;
    if (arg === '--') { index++; break; }
    if (name === 'env' && (arg === '-S' || arg.startsWith('-S') || arg === '--split-string' || arg.startsWith('--split-string='))) {
      uncertain('env split-string interpretation is partial');
      return { context, splitIndex: index };
    }
    if (/^[A-Za-z_][A-Za-z_0-9]*=/u.test(arg)) {
      if (!/^(?:LANG|LC_[A-Z_]+|TZ)=/u.test(arg)) uncertain('Environment assignment may alter executable behavior');
      index++; continue;
    }
    if (name === 'env' && arg === '-') { index++; continue; }
    if (!arg.startsWith('-')) break;
    const longKey = arg.split('=')[0]!;
    const shortKey = arg.slice(0, 2);
    const key = arg.startsWith('--') ? longKey : values.has(shortKey) ? shortKey : arg;
    if (values.has(key)) {
      const attached = arg.startsWith('--') ? arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : undefined
        : arg.length > 2 ? arg.slice(2) : undefined;
      const value = attached ?? call.args[index + 1];
      index += attached === undefined ? 2 : 1;
      if (value === undefined) { uncertain(`Missing wrapper option value: ${key}`); break; }
      if (name === 'env' && ['-C', '--chdir'].includes(key) || name === 'sudo' && ['-D', '--chdir'].includes(key)) {
        context = { ...context, cwd: changeCommandDirectory(context.cwd, value) };
      } else if (name === 'sudo' && ['-R', '--chroot'].includes(key)) {
        context = { ...unknownContext(context, 'sudo changes filesystem namespace'), namespace: 'unknown' };
      } else if (['sudo', 'runuser'].includes(name) && ['-u', '--user', '-g', '--group'].includes(key)) {
        const identity = context.identity.state === 'requested' ? context.identity : { state: 'requested' as const };
        context = { ...context, identity: /^[a-z_][a-z0-9_-]*[$]?$/iu.test(value) || /^#?\d+$/u.test(value)
          ? { ...identity, ...(['-u', '--user'].includes(key) ? { user: value } : { group: value }) }
          : { state: 'unknown' } };
      } else if (name === 'sudo' && ['-h', '--host'].includes(key)) {
        context = { ...unknownContext(context, 'sudo host context is unresolved'), namespace: 'unknown' };
      } else if (name === 'time' && ['-o', '--output'].includes(key) || name === 'exec' && key === '-a') {
        uncertain('Wrapper has additional effects or executable identity');
      }
      continue;
    }
    if (name === 'sudo' && ['-i', '--login', '-s', '--shell'].includes(arg)) {
      context = unknownContext(context, 'sudo shell/login startup is unresolved');
      index++; continue;
    }
    if (!FLAGS[name]?.has(arg)) {
      // Unknown options might have a value: extracted calls are only best effort.
      context = unknownContext(context, `Unsupported ${name} option: ${arg}`);
    }
    index++;
  }
  if (name === 'timeout') index++;
  if (['xargs', 'runuser'].includes(name)) context = unknownContext(context, `${name} execution context is partial`);
  if (!call.args[index]) return { context };
  const command: CommandCall = { name: call.args[index]!, args: call.args.slice(index + 1),
    dynamic: call.dynamic, redirects: call.redirects, context, source: call.source };
  return { command, context };
}

export function embeddedContext(call: CommandCall): CommandContext {
  const name = path.posix.basename(call.name);
  const context = launcherInfo(call).context;
  if (['su', 'runuser'].includes(name)) return { ...unknownContext(context, 'su/runuser identity and startup are unverified'), identity: { state: 'unknown' } };
  if (call.args.some((arg) => arg === '--login' || /^-[^-]*l/u.test(arg)) && ['bash', 'sh', 'dash', 'zsh', 'ksh'].includes(name)) {
    return unknownContext(context, 'Login shell startup may change directory');
  }
  return context;
}
