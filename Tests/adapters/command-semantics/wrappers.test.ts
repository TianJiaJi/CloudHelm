import { expect, it } from 'vitest';
import { callDirectory, isEffectFreeQuery, resolveCommandDirectory, type CommandCall } from '@cloudhelm/core';
import { launcherInfo, entryContext } from '../../../packages/adapters/src/command-semantics/wrappers.js';
import { BashAnalyzer } from '../../../packages/adapters/src/bash-analyzer.js';
const call = (name: string, args: string[]): CommandCall => ({ name, args, dynamic: false, redirects: false, context: entryContext() });

it('binds requested user/group and nested cwd without asserting authentication success', () => {
  const inner = launcherInfo(call('sudo', ['--user=backup', '-gstaff', '-D/srv', '--', 'env', '-C', 'app', 'touch', 'marker'])).command!;
  const target = launcherInfo(inner).command!;
  expect(target.context?.identity).toEqual({ state: 'requested', user: 'backup', group: 'staff' });
  expect(callDirectory(target, '/entry')).toBe('/srv/app');
  expect(target.args).toEqual(['marker']);
});
it('treats each sudo default as a new root request, not the previous wrapper user', () => {
  const inner = launcherInfo(call('sudo', ['-u', 'backup', 'sudo', '-g', 'staff', 'touch', 'marker'])).command!;
  expect(launcherInfo(inner).command!.context?.identity).toEqual({ state: 'requested', user: 'root', group: 'staff' });
});
it('retains the namespace boundary even after an absolute cwd is specified', () => {
  const result = launcherInfo(call('sudo', ['-R', '/other', '-D', '/', 'touch', 'marker']));
  expect(result.context.namespace).toBe('unknown');
  expect(callDirectory(result.command!, '/entry')).toBeNull();
});
it('does not invent context for dynamic directories or login startup', () => {
  for (const [name, args] of [['env', ['-C', '$TARGET', 'touch', 'marker']],
    ['sudo', ['--login', 'touch', 'marker']]] as const) {
    expect(launcherInfo(call(name, [...args])).context.cwd.state).toBe('unknown');
  }
});
it('does not treat object prototype names as launchers', () => {
  expect(launcherInfo(call('constructor', ['touch', 'marker'])).command).toBeUndefined();
});
it('does not mistake arguments after -- for split-string options', () => {
  expect(launcherInfo(call('env', ['--', 'echo', '-S', 'text'])).splitIndex).toBeUndefined();
});
it('scopes shell redirects outside launcher directory changes', async () => {
  const parsed = await new BashAnalyzer().analyze('env -C / printf ok > marker');
  expect(callDirectory(parsed.calls.find((item) => item.name === 'printf')!, '/srv/app')).toBe('/');
  expect(resolveCommandDirectory(parsed.redirectEffects![0]!.context.cwd, '/srv/app')).toBe('/srv/app');
});
it('restores context after subshells and marks conditional/functional flow unknown', async () => {
  const analyzer = new BashAnalyzer();
  const local = await analyzer.analyze('(cd /); touch marker');
  expect(callDirectory(local.calls.find((item) => item.name === 'touch')!, '/srv/app')).toBe('/srv/app');
  for (const source of ['cd / || touch marker', 'if test x; then cd /; fi; touch marker',
    'f() { cd /; }; touch marker', 'cd / | cat; touch marker']) {
    const parsed = await analyzer.analyze(source);
    expect(parsed.calls.find((item) => item.name === 'touch')?.context?.cwd.state, source).toBe('unknown');
  }
});
it('does not mark a literal query failure branch unknown unless shell state can change', async () => {
  const analyzer = new BashAnalyzer();
  expect(isEffectFreeQuery(await analyzer.analyze('ping -c 1 -W 1 192.0.2.1 || ping -c 1 -W 1 192.0.2.2'))).toBe(true);
  const changed = await analyzer.analyze('cd / || ls etc');
  expect(isEffectFreeQuery(changed)).toBe(false);
  expect(changed.calls.find((item) => item.name === 'ls')?.context?.cwd.state).toBe('unknown');
});
it('keeps source locations and labels separately parsed embedded shell ranges', async () => {
  const parsed = await new BashAnalyzer().analyze('env -C / sh -c "rm -rf etc"');
  expect(parsed.calls[0]?.source).toMatchObject({ start: 0, depth: 0 });
  const nested = parsed.calls.find((item) => item.name === 'rm')!;
  expect(nested.source).toMatchObject({ start: 0, depth: 1 });
  expect(callDirectory(nested, '/srv/app')).toBe('/');
});
it('keeps the complete env split-string tail when looking for known hazards', async () => {
  const parsed = await new BashAnalyzer().analyze("env -C / -S 'rm' -rf etc");
  expect(parsed.calls.find((item) => item.name === 'rm')).toMatchObject({ args: ['-rf', 'etc'] });
});
