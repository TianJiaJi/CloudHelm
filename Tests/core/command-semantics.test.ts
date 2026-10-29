import { describe, expect, it } from 'vitest';
import { changeCommandDirectory, hasIncompleteCommandSemantics, resolveCommandDirectory, resolveCommandPath } from '../../packages/core/src/command-semantics.js';
import type { CommandAnalysis, CommandDirectory } from '../../packages/core/src/model.js';

const entry: CommandDirectory = { state: 'known', changes: [] };
describe('pure lexical command contexts', () => {
  it('binds relative changes to the operation, not the machine cwd', () => {
    const directory = changeCommandDirectory(changeCommandDirectory(entry, '..'), 'data');
    expect(resolveCommandDirectory(directory, '/srv/app')).toBe('/srv/data');
    expect(resolveCommandDirectory(directory, '/opt/project')).toBe('/opt/data');
    expect(entry).toEqual({ state: 'known', changes: [] });
  });
  it('does not forge cwd after a dynamic change; absolute paths can reestablish it', () => {
    const unknown = changeCommandDirectory(entry, '$TARGET');
    expect(resolveCommandDirectory(changeCommandDirectory(unknown, 'relative'), '/srv/app')).toBeNull();
    expect(resolveCommandDirectory(changeCommandDirectory(unknown, '/srv'), '/srv/app')).toBe('/srv');
    expect(resolveCommandPath('relative', null)).toBeNull();
    expect(resolveCommandPath('/etc/passwd', null)).toBe('/etc/passwd');
  });
  it('treats missing family metadata as incomplete without rejecting legacy query shapes', () => {
    const analysis: CommandAnalysis = { calls: [{ name: 'git', args: ['-C', '/', 'status'], dynamic: false, redirects: false }],
      raw: '', redirectTargets: [], hasExpansion: false, hasPipeline: false, hasCompound: false, hasRedirection: false, hasError: false };
    expect(hasIncompleteCommandSemantics(analysis)).toBe(true);
    analysis.calls[0]!.name = 'pwd';
    expect(hasIncompleteCommandSemantics(analysis)).toBe(false);
  });
});
