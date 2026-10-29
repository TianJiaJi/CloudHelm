import { describe, expect, it } from 'vitest';
import { decideSafety, inspectScriptSafety, isEffectFreeQuery, scriptFilePath, supportsSudo, type OperationScope, type ReviewMode } from '@cloudhelm/core';
import { BashAnalyzer } from '../../packages/adapters/src/bash-analyzer.js';

// Parser input only: no transport, executor, model or shell process is used.
const analyzer = new BashAnalyzer();
const scope: OperationScope = { taskId: 'task', hostId: 'fixture', cwd: '/srv/app', runAs: 'deploy',
  terminalId: 'fixture', terminalGeneration: 1, policyRevision: 1, allowedWorkingRoots: ['/srv/app'],
  protectedPaths: [], goal: 'Bounded maintenance' };
const modes: ReviewMode[] = ['ask', 'ai-review', 'permissive'];
async function classify(command: string, mode: ReviewMode, overrides: Partial<OperationScope> = {}) {
  return decideSafety({ id: 'fixture', kind: 'command', command, scope: { ...scope, ...overrides } },
    { mode, revision: 1 }, await analyzer.analyze(command));
}

const gitPrefixes = ['git', 'git -C /srv/app', 'git -C/srv -C app', 'git -c core.quotepath=false',
  'git -ccore.quotepath=false', 'git --git-dir=/srv/app/.git --work-tree /srv/app', 'git --'];
describe('Git global options preserve operation classification', () => {
  it.each(gitPrefixes)('%s reset --hard remains high impact', async (prefix) => {
    for (const mode of modes) expect(await classify(`${prefix} reset --hard`, mode)).toMatchObject({
      verdict: mode === 'ai-review' ? 'evaluate' : 'ask', ruleId: 'high-impact-command' });
  });
  it.each(['push origin main', 'clean -fd', 'rebase main'])('does not demote %s through options', async (args) => {
    expect((await classify(`git -C /srv/app ${args}`, 'ask')).verdict).toBe('ask');
  });
  it.each(['git status', 'git -C /srv/app log --oneline', 'git -c core.quotepath=false status'])(
    'keeps understood ordinary Git forms: %s', async (command) => {
      for (const mode of modes) expect((await classify(command, mode)).verdict).toBe('allow');
    });
  it('uses the Git working directory for relative operands, not for option values', async () => {
    expect((await classify('git -C /srv add private/file', 'ask', { protectedReadPaths: ['/srv/private'] })).verdict).toBe('deny');
    expect((await classify('git -C app status', 'ask', { protectedReadPaths: ['/srv/app/app/app'] })).verdict).toBe('allow');
    expect((await classify('git -C /srv/private status', 'ask', { protectedReadPaths: ['/srv/private'] })).verdict).toBe('deny');
  });
  it.each(['git --future-option status', 'git -C', 'git -c alias.wipe=reset wipe --hard',
    'git -c core.sshCommand=custom push', 'git --config-env=core.pager=PAGER log'])(
    'does not claim bounded ordinary effects for %s', async (command) => {
      expect(await classify(command, 'ask')).toMatchObject({ verdict: 'ask', ruleId: 'uncertain-command' });
    });
});

describe('tar operands have directional roles', () => {
  it.each(['tar -cf /dev/sda ./data', 'tar -czf/dev/sda ./data', 'tar cf /dev/sda ./data',
    'tar --create --file=/dev/sda ./data', 'tar -cf /etc/passwd ./data',
    'env -C /dev tar -cf sda /srv/app/data'])(
    'denies an archive output to a forbidden resource: %s', async (command) => {
      for (const mode of modes) expect((await classify(command, mode)).verdict).toBe('deny');
    });
  it.each(['tar -cf ./backup.tar ./data', 'tar czf backup.tar data', 'tar --create --file backup.tar -C /srv data',
    'tar -tf /dev/sda', 'tar --list --file backup.tar', 'tar -cf - ./data'])(
    'retains understood archive behavior: %s', async (command) => {
      for (const mode of modes) expect((await classify(command, mode)).verdict).toBe('allow');
    });
  it.each([
    ['tar -cf /srv/write/out.tar ./data', 'deny'], ['tar -cf /srv/read/out.tar ./data', 'allow'],
    ['tar -cf ./out.tar /srv/read/data', 'deny'], ['tar -tf /srv/write/in.tar', 'allow'],
    ['tar -tf /srv/read/in.tar', 'deny'], ['tar -cf ./out.tar -C /srv read/data', 'deny']
  ] as const)('checks correct path direction: %s', async (command, verdict) => {
    expect((await classify(command, 'ask', { protectedReadPaths: ['/srv/read'], protectedWritePaths: ['/srv/write'] })).verdict)
      .toBe(verdict);
  });
  it.each(['tar -xf backup.tar', 'tar -cf backup.tar --checkpoint-action=exec=custom data',
    'tar -cf backup.tar -T files.txt', 'tar -cf backup.tar --future-option data', 'tar -ctf backup.tar',
    'tar -cf one.tar -f two.tar data', 'tar -cf'])(
    'keeps unproved archive effects opaque: %s', async (command) => {
      expect(await classify(command, 'ask')).toMatchObject({ verdict: 'ask', ruleId: 'uncertain-command' });
    });
  it('recognizes credentials when they are read', async () => {
    expect((await classify('tar -cf ./out.tar /etc/shadow', 'ask')).verdict).toBe('deny');
    expect((await classify('tar -tf /etc/shadow', 'ask')).verdict).toBe('deny');
    expect((await classify('tar -cf out.tar -T /etc/shadow', 'permissive')).verdict).toBe('deny');
    expect((await classify('tar -rf /etc/shadow data', 'permissive')).verdict).toBe('deny');
  });
});

describe('wrapper context belongs to its inner call, not the flat call list', () => {
  it.each(['env -C / rm -rf etc', 'env -C/ rm -rf etc', 'env --chdir=/ rm -rf etc',
    'sudo -D / rm -rf etc', 'sudo -D/ rm -rf etc', 'sudo --chdir=/ rm -rf etc',
    'env -C /srv sudo -D / rm -rf etc', 'env -C / sh -c "rm -rf etc"', '(cd / && rm -rf etc)',
    "env -C / -S 'rm' -rf etc"])(
    'denies system tree deletion with effective cwd: %s', async (command) => {
      for (const mode of modes) expect((await classify(command, mode)).verdict).toBe('deny');
    });
  it.each(['env -C /srv cat private/secret', 'sudo -D /srv cat private/secret'])(
    'protects relative reads after chdir: %s', async (command) => {
      expect((await classify(command, 'permissive', { protectedReadPaths: ['/srv/private'] })).verdict).toBe('deny');
    });
  it.each(['env -C / cat etc/shadow', 'sudo -D / cat etc/shadow'])(
    'protects credentials after chdir: %s', async (command) => {
      expect((await classify(command, 'permissive')).verdict).toBe('deny');
    });
  it.each(['env -C / true; rm -rf etc', '(cd /); rm -rf etc', 'echo "$(cd /)"; rm -rf etc'])(
    'does not leak an inner cwd into a sibling: %s', async (command) => {
      expect(await classify(command, 'ask')).toMatchObject({ verdict: 'ask', impact: 'high' });
    });
  it.each(['env -C "$TARGET" touch marker', 'sudo -i touch marker', 'sudo -R /other touch marker'])(
    'does not label unknown context as ordinary: %s', async (command) => {
      expect(await classify(command, 'ask')).toMatchObject({ verdict: 'ask', ruleId: 'uncertain-command' });
    });
  it('does not expand sudo execution support or read-only capabilities', async () => {
    const parsed = await analyzer.analyze('sudo -D / ls etc');
    expect(supportsSudo(parsed)).toBe(false);
    expect(isEffectFreeQuery(parsed)).toBe(false);
  });
  it.each(['env -C / sh ./deploy.sh', 'sudo -D / sh /srv/app/deploy.sh'])(
    'does not inspect changed-cwd scripts as if executed from the entry cwd: %s', async (command) => {
      expect(scriptFilePath(await analyzer.analyze(command))).toBeUndefined();
    });
});

describe('inspected script content retains new semantic findings', () => {
  it.each(['git -C /srv/app reset --hard', 'tar -cf /dev/sda ./data', 'env -C / rm -rf etc'])(
    'does not bypass semantics when inspecting %s', async (source) => {
      const parsed = await analyzer.analyze(source);
      for (const mode of modes) {
        const result = inspectScriptSafety({ id: 'op', kind: 'command', command: 'sh ./deploy.sh', scope },
          source, parsed, { mode, revision: 1 });
        expect(result.verdict).toBe(source.startsWith('git') ? mode === 'ai-review' ? 'evaluate' : 'ask' : 'deny');
      }
    });
});
