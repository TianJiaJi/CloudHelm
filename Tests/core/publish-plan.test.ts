import { describe, expect, it } from 'vitest';
import { BashAnalyzer } from '@cloudhelm/adapters';
import { buildPublishPlan, candidateExitCode, candidateExitPhase, commitExitCode, commitExitPhase, nativePtySuEligible, parsePublishHash } from '@cloudhelm/core';

const input = { targetPath: '/etc/systemd/system/cloudhelm-demo.service', contentSha256: 'a'.repeat(64),
  contentBytes: 128, mode: '644', owner: 'root:root', stagingPath: '/tmp/.cloudhelm-publish-0123456789abcdef.staging',
  nonce: '0123456789abcdef' };
const scope = { taskId: 'task', hostId: 'host', terminalId: 'terminal', terminalGeneration: 1, policyRevision: 1,
  cwd: '/', loginAs: 'user', runAs: 'user', protectedPaths: [], allowedWorkingRoots: [], goal: 'publish' };

describe('publish plan', () => {
  it('builds two literal scripts and their su wraps for the plan input', () => {
    const plan = buildPublishPlan(input);
    expect(plan).toBeDefined();
    expect(plan!.candidateScript).toContain('test -c /dev/full || exit 12');
    expect(plan!.candidateScript).toContain(`test ! -e '${input.targetPath}' || exit 10`);
    expect(plan!.candidateScript).toContain(`test ! -L '${input.targetPath}' || exit 10`);
    expect(plan!.candidateScript).toContain(`test ! -L '${input.stagingPath}' || exit 11`);
    expect(plan!.candidateScript).toContain(`test -f '${input.stagingPath}' || exit 11`);
    expect(plan!.candidateScript).toContain(`find '${input.stagingPath}' -maxdepth 0 -type f -size 128c -fprint /dev/full && exit 11`);
    expect(plan!.candidateScript).toContain(`dd if='${input.stagingPath}' of='${plan!.candidatePath}' conv=excl || exit 13`);
    expect(plan!.candidateScript).toContain(`chmod '600' '${plan!.candidatePath}'`);
    expect(plan!.candidateScript).not.toContain(`chown '${input.owner}' '${plan!.candidatePath}'`);
    expect(plan!.candidateScript).toContain(`sha256sum '${plan!.candidatePath}'`);
    expect(plan!.candidateScript).toContain('cloudhelm-publish: candidate ready');
    expect(plan!.commitScript).toContain('test -c /dev/full || exit 21');
    expect(plan!.commitScript).toContain(`test ! -e '${input.targetPath}' || exit 20`);
    expect(plan!.commitScript).toContain(`test ! -L '${input.targetPath}' || exit 20`);
    expect(plan!.commitScript).toContain(`test -f '${plan!.candidatePath}' || exit 21`);
    expect(plan!.commitScript).toContain(`find '${plan!.candidatePath}' -maxdepth 0 -type f -user root -perm 600 -fprint /dev/full && exit 21`);
    expect(plan!.commitScript).toContain(`ln -T '${plan!.candidatePath}' '${input.targetPath}' || exit 20`);
    expect(plan!.commitScript).toContain(`chown '${input.owner}' '${input.targetPath}' || exit 22`);
    expect(plan!.commitScript).toContain(`chmod '644' '${input.targetPath}' || exit 22`);
    expect(plan!.commitScript).toContain(`find '${input.targetPath}' -maxdepth 0 -type f -user 'root' -group 'root' -perm 644 -fprint /dev/full && exit 22`);
    // The candidate hash is emitted at the commit boundary before the link,
    // and the committed hash after it; parsePublishHash tells them apart by path.
    const boundaryIndex = plan!.commitScript.indexOf(`sha256sum '${plan!.candidatePath}'`);
    const linkIndex = plan!.commitScript.indexOf(`ln -T '${plan!.candidatePath}'`);
    const targetHashIndex = plan!.commitScript.indexOf(`sha256sum '${input.targetPath}'`);
    expect(boundaryIndex).toBeGreaterThan(-1);
    expect(boundaryIndex).toBeLessThan(linkIndex);
    expect(targetHashIndex).toBeGreaterThan(linkIndex);
    expect(plan!.commitScript).toContain('cloudhelm-publish: readback verified');
    expect(plan!.candidatePath).toBe(`/etc/systemd/system/.cloudhelm-publish-${input.nonce}`);
    expect(plan!.parentPath).toBe('/etc/systemd/system');
    expect(plan!.wrappedCandidateCommand.startsWith("su -l -s /bin/sh root -c '")).toBe(true);
    expect(plan!.wrappedCommitCommand.startsWith("su -l -s /bin/sh root -c '")).toBe(true);
    expect(plan!.wrappedCandidateCommand).toContain("cd '\\''/'\\'' || exit 125\n");
    expect(plan!.wrappedCommitCommand).toContain("cd '\\''/'\\'' || exit 125\n");
    expect(Buffer.byteLength(plan!.wrappedCandidateCommand, 'utf8')).toBeLessThanOrEqual(8000);
    expect(Buffer.byteLength(plan!.wrappedCommitCommand, 'utf8')).toBeLessThanOrEqual(8000);
    // Literal-only bodies: the credential-bound native PTY su route refuses
    // pipelines, redirections and expansions inside the quoted -c payload
    // (logical || and && are allowed), and the reviewed content hash itself
    // never travels through command text.
    for (const script of [plan!.candidateScript, plan!.commitScript]) {
      expect(script).not.toContain('$');
      expect(script).not.toContain('`');
      expect(script).not.toContain('>');
      expect(script).not.toContain('<');
      expect(script).not.toMatch(/(?<!\|)\|(?!\|)/u);
      expect(script).not.toContain(input.contentSha256.slice(0, 32));
    }
  });

  it('guards every parent component from root down to the target parent', () => {
    const plan = buildPublishPlan({ ...input, targetPath: '/opt/apps/demo/config.yaml' });
    expect(plan).toBeDefined();
    for (const component of ['/', '/opt', '/opt/apps', '/opt/apps/demo']) {
      expect(plan!.candidateScript).toContain(`test -d '${component}' || exit 12`);
      expect(plan!.candidateScript)
        .toContain(`find '${component}' -maxdepth 0 -type d -user root ! -perm -020 ! -perm -002 -fprint /dev/full && exit 12`);
    }
  });

  it('produces wrapped commands the real analyzer accepts for the native PTY su route', async () => {
    const plan = buildPublishPlan(input);
    const analyzer = new BashAnalyzer();
    for (const wrapped of [plan!.wrappedCandidateCommand, plan!.wrappedCommitCommand]) {
      const analysis = await analyzer.analyze(wrapped);
      expect(analysis.hasError).toBe(false);
      expect(analysis.hasExpansion).toBe(false);
      expect(analysis.hasPipeline).toBe(false);
      expect(analysis.hasRedirection).toBe(false);
      expect(nativePtySuEligible({ id: 'op', kind: 'command', command: wrapped, privilege: 'root', scope }, analysis)).toBe(true);
    }
  });

  it('escapes single quotes in paths and still qualifies for the su route', async () => {
    const plan = buildPublishPlan({ ...input, targetPath: "/opt/it's/demo.conf" });
    expect(plan).toBeDefined();
    const analyzer = new BashAnalyzer();
    for (const wrapped of [plan!.wrappedCandidateCommand, plan!.wrappedCommitCommand]) {
      const analysis = await analyzer.analyze(wrapped);
      expect(nativePtySuEligible({ id: 'op', kind: 'command', command: wrapped, privilege: 'root', scope }, analysis)).toBe(true);
    }
  });

  it('refuses invalid inputs', () => {
    expect(buildPublishPlan({ ...input, targetPath: 'etc/demo.conf' })).toBeUndefined();
    expect(buildPublishPlan({ ...input, targetPath: '/etc/demo/' })).toBeUndefined();
    expect(buildPublishPlan({ ...input, targetPath: '/' })).toBeUndefined();
    expect(buildPublishPlan({ ...input, targetPath: '/etc/../etc/demo.conf' })).toBeUndefined();
    expect(buildPublishPlan({ ...input, targetPath: `/etc/${'a'.repeat(4200)}.conf` })).toBeUndefined();
    expect(buildPublishPlan({ ...input, contentSha256: 'XYZ' })).toBeUndefined();
    expect(buildPublishPlan({ ...input, contentBytes: 0 })).toBeUndefined();
    expect(buildPublishPlan({ ...input, contentBytes: 1_048_577 })).toBeUndefined();
    expect(buildPublishPlan({ ...input, contentBytes: 12.5 })).toBeUndefined();
    expect(buildPublishPlan({ ...input, mode: '0644' })).toBeUndefined();
    expect(buildPublishPlan({ ...input, mode: '7777' })).toBeUndefined();
    expect(buildPublishPlan({ ...input, owner: 'root' })).toBeUndefined();
    expect(buildPublishPlan({ ...input, owner: 'root;rm' })).toBeUndefined();
    expect(buildPublishPlan({ ...input, stagingPath: 'tmp/x' })).toBeUndefined();
    expect(buildPublishPlan({ ...input, nonce: 'xyz' })).toBeUndefined();
  });

  it('refuses plans whose wrapped commands would exceed the 8 KiB exec bound', () => {
    const deep = `/${Array.from({ length: 120 }, (_v, index) => `component-${index}`).join('/')}/demo.conf`;
    expect(buildPublishPlan({ ...input, targetPath: deep })).toBeUndefined();
  });

  it('maps candidate exit codes onto phases and stable codes', () => {
    expect(candidateExitPhase(0)).toBe('ready');
    for (const code of [10, 11, 12, 13, 14, 125]) expect(candidateExitPhase(code)).toBe('refused');
    expect(candidateExitPhase(undefined)).toBe('unknown');
    expect(candidateExitPhase(1)).toBe('unknown');
    expect(candidateExitCode(10)).toBe('target-exists');
    expect(candidateExitCode(11)).toBe('staging-invalid');
    expect(candidateExitCode(12)).toBe('parent-untrusted');
    expect(candidateExitCode(13)).toBe('candidate-create-failed');
    expect(candidateExitCode(14)).toBe('candidate-mode-failed');
    expect(candidateExitCode(99)).toBe('unknown');
  });

  it('maps commit exit codes onto phases and stable codes', () => {
    expect(commitExitPhase(0)).toBe('succeeded');
    for (const code of [20, 21, 125]) expect(commitExitPhase(code)).toBe('commit-failed');
    expect(commitExitPhase(22)).toBe('committed-unverified');
    expect(commitExitPhase(undefined)).toBe('unknown');
    expect(commitExitPhase(1)).toBe('unknown');
    expect(commitExitCode(20)).toBe('commit-failed');
    expect(commitExitCode(21)).toBe('candidate-untrusted');
    expect(commitExitCode(22)).toBe('readback-metadata-mismatch');
    expect(commitExitCode(99)).toBe('unknown');
  });

  it('parses the last exact sha256sum line for the named path only', () => {
    const hash = 'b'.repeat(64);
    const later = 'c'.repeat(64);
    const candidate = '/etc/systemd/system/.cloudhelm-publish-0123456789abcdef';
    expect(parsePublishHash(`noise\r\n${hash}  ${candidate}\r\ncloudhelm-publish: candidate ready\r\n`, candidate)).toBe(hash);
    expect(parsePublishHash(`${hash}  ${candidate}\n${later}  ${candidate}\n`, candidate)).toBe(later);
    expect(parsePublishHash(`echo '${hash}  ${candidate}'`, candidate)).toBeUndefined();
    expect(parsePublishHash(`${hash}  ${candidate}.staging`, candidate)).toBeUndefined();
    expect(parsePublishHash('no hash line at all', candidate)).toBeUndefined();
    expect(parsePublishHash(`${hash}  ${candidate} trailing`, candidate)).toBeUndefined();
    // The match-assertion guards surface find's /dev/full write error on
    // stderr as a progress line; it must never parse as a hash.
    expect(parsePublishHash(`find: '/dev/full': No space left on device\n${hash}  ${candidate}\n`, candidate)).toBe(hash);
    expect(parsePublishHash("find: '/dev/full': No space left on device\n", candidate)).toBeUndefined();
  });
});
