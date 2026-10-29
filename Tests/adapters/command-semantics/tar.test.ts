import { expect, it } from 'vitest';
import { resolveCommandDirectory, type CommandCall } from '@cloudhelm/core';
import { tarSemantics } from '../../../packages/adapters/src/command-semantics/tar.js';
const call = (args: string[]): CommandCall => ({ name: 'tar', args, dynamic: false, redirects: false });

it.each([['-cf', 'out.tar', 'data'], ['cf', 'out.tar', 'data'], ['-czfout.tar', 'data'],
  ['--create', '--file=out.tar', '--', 'data']])('recognizes create form %j', (...args) => {
  expect(tarSemantics(call(args))).toMatchObject({ coverage: 'complete', tar: { mode: 'create', paths: [
    { kind: 'write', path: 'out.tar' }, { kind: 'read', path: 'data' }
  ] } });
});
it('keeps the archive relative to process cwd; -C only changes member lookup', () => {
  const result = tarSemantics(call(['-C', '/srv', '-cf', 'out.tar', 'data', '-C', 'more', 'other']));
  expect(result.coverage).toBe('complete');
  expect(result.tar!.paths.map((effect) => [effect.path, resolveCommandDirectory(effect.directory, '/entry')]))
    .toEqual([['out.tar', '/entry'], ['data', '/srv'], ['other', '/srv/more']]);
});
it('does not treat archive member filters in list mode as files read from the filesystem', () => {
  expect(tarSemantics(call(['-tf', 'out.tar', '/member']))).toMatchObject({
    coverage: 'complete', tar: { paths: [{ kind: 'read', path: 'out.tar' }] }
  });
});
it('preserves explicit archive output even when an option is unsupported', () => {
  expect(tarSemantics(call(['-cf', '/dev/sda', '--future-option', 'data']))).toMatchObject({
    coverage: 'partial', tar: { paths: expect.arrayContaining([{ kind: 'write', path: '/dev/sda', directory: { state: 'known', changes: [] } }]) }
  });
});
it('does not pretend to understand members from an archive or file list', () => {
  for (const args of [['-xf', 'out.tar'], ['-cf', 'out.tar', '-T', 'files'], ['-cctf', 'out.tar'], ['-cf'],
    ['-cf', 'one', '-f', 'two', 'data'], ['-cf', 'one', '--to-command=custom']]) {
    expect(tarSemantics(call(args)).coverage).toBe('partial');
  }
});
it('does not recognize object prototype names as supported operations', () => {
  for (const key of ['constructor', '__proto__', 'toString']) {
    expect(tarSemantics(call([`--${key}`, '--file', 'out.tar'])).coverage).toBe('partial');
  }
});
it('models stdio as a stream, not a path named -', () => {
  expect(tarSemantics(call(['-cf', '-', 'data'])).tar!.paths).toHaveLength(1);
});
