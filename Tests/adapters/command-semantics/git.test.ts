import { expect, it } from 'vitest';
import { resolveCommandDirectory, type CommandCall } from '@cloudhelm/core';
import { gitSemantics } from '../../../packages/adapters/src/command-semantics/git.js';
const call = (args: string[]): CommandCall => ({ name: 'git', args, dynamic: false, redirects: false });
it('keeps Git directory changes symbolic until bound to an operation', () => {
  const result = gitSemantics(call(['-C', '..', '-C', 'project', '-C', '', 'status']));
  expect(result.coverage).toBe('complete');
  expect(resolveCommandDirectory(result.git!.directory, '/srv/app')).toBe('/srv/project');
  expect(result.git?.subcommand).toBe('status');
});
it('does not execute or trust aliases, execution config or missing option values', () => {
  for (const args of [['-c', 'alias.x=!arbitrary', 'x'], ['--exec-path=/tmp', 'status'], ['-c'],
    ['--config-env', 'core.pager=PAGER', 'log'], ['--namespace=other', 'status']]) {
    expect(gitSemantics(call(args)).coverage).toBe('partial');
  }
});
it('keeps the actual high-impact action even with unknown config', () => {
  const result = gitSemantics(call(['-c', 'core.hooksPath=/tmp', '-C/srv/app', 'reset', '--hard']));
  expect(result.coverage).toBe('partial');
  expect(result.git).toMatchObject({ subcommand: 'reset', args: ['--hard'] });
});
it('does not turn a global help request into an execution action', () => {
  expect(gitSemantics(call(['--help', 'reset', '--hard'])).git?.subcommand).toBe('help');
});
