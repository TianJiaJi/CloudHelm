import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { buildPublishPlan, parsePublishHash } from '@cloudhelm/core';

/** Real-filesystem counterexamples for the publish guards. Every case runs the
 * actual buildPublishPlan scripts as real GNU commands under WSL root and
 * asserts both the exit code and the resulting on-disk state, so a vacuously
 * passing find predicate, a link created inside a directory target, a
 * non-exclusive candidate or a bypassed route confirmation can never pass
 * these tests. On machines without a root-capable WSL the suite skips. */

const content = '[Unit]\nDescription=CloudHelm filesystem guard demo\n[Service]\nExecStart=/usr/bin/sleep 600\n[Install]\nWantedBy=multi-user.target\n';
const contentSha256 = createHash('sha256').update(content, 'utf8').digest('hex');
const contentBytes = Buffer.byteLength(content, 'utf8');
const baseRoot = '/root/chpub-fs';
const escapeSingle = (value: string) => value.replaceAll("'", "'\\''");
const q = (value: string) => `'${escapeSingle(value)}'`;

const wslProbe = process.platform === 'win32'
  ? spawnSync('wsl.exe', ['-u', 'root', '-e', 'sh', '-c', 'id -u'], { encoding: 'utf8', timeout: 30_000 })
  : undefined;
const wslRootAvailable = wslProbe?.status === 0 && (wslProbe.stdout ?? '').trim() === '0';
const maybeDescribe = wslRootAvailable ? describe : describe.skip;

interface CasePlan {
  caseId: string;
  targetPath: string;
  candidatePath: string;
  stagingPath: string;
  publishCandidate: string;
  publishCommit: string;
  wrappedCandidate: string;
  wrappedCommit: string;
}

function planFor(caseId: string, owner = 'root:root', relative = 'demo.conf'): CasePlan {
  const nonce = createHash('sha256').update(`chpub-fs-${caseId}`).digest('hex').slice(0, 16);
  const stagingPath = `/tmp/chpub-${caseId}.staging`;
  const targetPath = `${baseRoot}/${caseId}/${relative}`;
  const plan = buildPublishPlan({ targetPath, contentSha256, contentBytes, mode: '644', owner, stagingPath, nonce });
  expect(plan).toBeDefined();
  return { caseId, targetPath, candidatePath: plan!.candidatePath, stagingPath,
    publishCandidate: plan!.candidateScript, publishCommit: plan!.commitScript,
    wrappedCandidate: plan!.wrappedCandidateCommand, wrappedCommit: plan!.wrappedCommitCommand };
}

function runRootBash(script: string): { status: number | null; stdout: string } {
  const result = spawnSync('wsl.exe', ['-u', 'root', '-e', 'bash', '-s'], { input: script, encoding: 'utf8', timeout: 55_000 });
  return { status: result.status, stdout: result.stdout ?? '' };
}

interface HarnessOutcome { rc: number; publishOut: string; state: string; raw: string }

/** One harness invocation: fixture setup, one publish script under sh -c with
 * its exit code captured, then an on-disk state inspection. */
function runCase(plan: CasePlan, setup: string[], publish: string): HarnessOutcome {
  const inspect = [
    `stat -c 'TARGET %F %a %U:%G' ${q(plan.targetPath)} 2>/dev/null || echo 'TARGET stat-missing'`,
    `readlink ${q(plan.targetPath)} 2>/dev/null && echo 'TARGETLINK symlink' || echo 'TARGETLINK none'`,
    `if test -d ${q(plan.targetPath)}; then ls -A ${q(plan.targetPath)} | sed 's/^/DIRENTRY /'; fi`,
    `sha256sum ${q(plan.targetPath)} 2>/dev/null || echo 'TARGETSHA none'`,
    `stat -c 'CAND %F %a %U:%G' ${q(plan.candidatePath)} 2>/dev/null || echo 'CAND stat-missing'`,
    `readlink ${q(plan.candidatePath)} 2>/dev/null && echo 'CANDLINK symlink' || echo 'CANDLINK none'`,
    `sha256sum ${q(plan.candidatePath)} 2>/dev/null || echo 'CANDSHA none'`,
  ];
  const script = [...setup,
    'echo ---PUBLISH---',
    // 2>&1 mirrors the production PTY, where stdout and stderr share one
    // stream: the su dispatch marker carries no newline, so the boundary hash
    // line only stands alone because find's /dev/full error precedes it.
    `sh -c ${q(publish)} 2>&1`,
    'echo "PUBLISH_RC=$?"',
    'echo ---STATE---',
    ...inspect,
    'exit 0'].join('\n');
  const result = runRootBash(script);
  expect(result.status, plan.caseId).toBe(0);
  const publishMatch = /---PUBLISH---\n([\s\S]*?)PUBLISH_RC=(\d+)\n/u.exec(result.stdout);
  expect(publishMatch, plan.caseId).not.toBeNull();
  return { rc: Number(publishMatch?.[2]), publishOut: publishMatch?.[1] ?? '',
    state: result.stdout.split('---STATE---\n')[1] ?? '', raw: result.stdout };
}

function fixtureSetup(plan: CasePlan, extra: string[] = []): string[] {
  return [
    `rm -rf ${q(`${baseRoot}/${plan.caseId}`)} ${q(plan.stagingPath)}`,
    `mkdir -p ${q(`${baseRoot}/${plan.caseId}`)}`,
    `printf '%s' ${q(content)} > ${q(plan.stagingPath)}`,
    ...extra,
  ];
}

function setupWithCandidate(plan: CasePlan, fixtureExtra: string[] = [], afterCandidate: string[] = []): string[] {
  return [...fixtureSetup(plan, fixtureExtra),
    `sh -c ${q(plan.publishCandidate)} 2>&1`,
    'echo "CANDIDATE_RC=$?"',
    ...afterCandidate];
}

maybeDescribe('publish plan real-filesystem guards', () => {
  it('asserts find matches through the guaranteed /dev/full write and refuses ln -T into directories', () => {
    const result = runRootBash([
      'test -c /dev/full',
      'echo "CHARDEV=$?"',
      'find / -maxdepth 0 -type d -fprint /dev/full',
      'echo "MATCH=$?"',
      'find / -maxdepth 0 -type f -fprint /dev/full',
      'echo "NOMATCH=$?"',
      `mkdir -p ${q(`${baseRoot}/lnt-probe`)}`,
      `ln -T /etc/hostname ${q(`${baseRoot}/lnt-probe`)} 2>/dev/null`,
      'echo "LNT_DIR=$?"',
      `ls -A ${q(`${baseRoot}/lnt-probe`)} | sed 's/^/LNT_ENTRY /'`,
      'exit 0',
    ].join('\n'));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('CHARDEV=0');
    expect(result.stdout).toContain('MATCH=1');
    expect(result.stdout).toContain('NOMATCH=0');
    // Without -T a link into an existing directory would silently create the
    // entry inside it; -T keeps the directory empty and fails instead.
    expect(result.stdout).toContain('LNT_DIR=1');
    expect(result.stdout).not.toMatch(/^LNT_ENTRY /mu);
  }, 120_000);

  it('stages an exclusive root-owned mode-600 candidate for a deep trusted chain', () => {
    const plan = planFor('deep', 'root:root', 'etc/systemd/system/demo.service');
    const result = runCase(plan, fixtureSetup(plan, [`mkdir -p ${q(`${baseRoot}/deep/etc/systemd/system`)}`]), plan.publishCandidate);
    expect(result.rc).toBe(0);
    expect(result.publishOut).toContain(`${contentSha256}  ${plan.candidatePath}`);
    expect(result.publishOut).toContain('cloudhelm-publish: candidate ready');
    expect(result.state).toContain('TARGET stat-missing');
    expect(result.state).toContain('CAND regular file 600 root:root');
    expect(result.state).toContain(`${contentSha256}  ${plan.candidatePath}`);
  }, 120_000);

  it('refuses pre-existing targets of every shape', () => {
    const preserved = createHash('sha256').update('pre-existing', 'utf8').digest('hex');
    const cases: Array<{ id: string; extra: (plan: CasePlan) => string[]; state: string[] }> = [
      { id: 'target-file', extra: (plan) => [`printf '%s' 'pre-existing' > ${q(plan.targetPath)}`],
        state: ['TARGET regular file', 'TARGETLINK none', `${preserved}  ${baseRoot}/target-file/demo.conf`] },
      { id: 'target-dir', extra: (plan) => [`mkdir ${q(plan.targetPath)}`], state: ['TARGET directory', 'TARGETLINK none'] },
      { id: 'target-link', extra: (plan) => [`printf '%s' 'elsewhere' > ${q(`${baseRoot}/target-link/elsewhere`)}`,
        `ln -s ${q(`${baseRoot}/target-link/elsewhere`)} ${q(plan.targetPath)}`], state: ['TARGETLINK symlink'] },
      { id: 'target-dangling', extra: (plan) => [`ln -s ${q(`${baseRoot}/target-dangling/missing`)} ${q(plan.targetPath)}`],
        state: ['TARGET symbolic link 777 root:root', 'TARGETLINK symlink', 'TARGETSHA none'] },
    ];
    for (const definition of cases) {
      const plan = planFor(definition.id);
      const result = runCase(plan, fixtureSetup(plan, definition.extra(plan)), plan.publishCandidate);
      expect(result.rc, definition.id).toBe(10);
      for (const fragment of definition.state) expect(result.state, definition.id).toContain(fragment);
      expect(result.state, definition.id).toContain('CAND stat-missing');
      expect(result.publishOut, definition.id).not.toContain('cloudhelm-publish: candidate ready');
    }
  }, 240_000);

  it('refuses invalid staging (symlink, wrong size, missing)', () => {
    const cases: Array<{ id: string; extra: (plan: CasePlan) => string[] }> = [
      { id: 'staging-link', extra: (plan) => [`rm ${q(plan.stagingPath)}`, `ln -s /etc/hostname ${q(plan.stagingPath)}`] },
      { id: 'staging-size', extra: (plan) => [`printf '%s' 'tiny' > ${q(plan.stagingPath)}`] },
      { id: 'staging-missing', extra: (plan) => [`rm ${q(plan.stagingPath)}`] },
    ];
    for (const definition of cases) {
      const plan = planFor(definition.id);
      const result = runCase(plan, fixtureSetup(plan, definition.extra(plan)), plan.publishCandidate);
      expect(result.rc, definition.id).toBe(11);
      expect(result.state, definition.id).toContain('CAND stat-missing');
      expect(result.publishOut, definition.id).not.toContain('cloudhelm-publish: candidate ready');
    }
  }, 240_000);

  it('refuses untrusted parent components (symlink, writable, foreign-owned, missing)', () => {
    const cases: Array<{ id: string; extra: (plan: CasePlan) => string[] }> = [
      { id: 'comp-link', extra: () => [`mv ${q(`${baseRoot}/comp-link`)} ${q(`${baseRoot}/comp-link.real`)}`,
        `ln -s ${q(`${baseRoot}/comp-link.real`)} ${q(`${baseRoot}/comp-link`)}`] },
      { id: 'comp-world', extra: () => [`chmod 777 ${q(`${baseRoot}/comp-world`)}`] },
      { id: 'comp-group', extra: () => [`chmod 775 ${q(`${baseRoot}/comp-group`)}`] },
      { id: 'comp-owner', extra: () => [`chown nobody ${q(`${baseRoot}/comp-owner`)}`] },
      { id: 'comp-missing', extra: () => [`rm -rf ${q(`${baseRoot}/comp-missing`)}`] },
    ];
    for (const definition of cases) {
      const plan = planFor(definition.id);
      const result = runCase(plan, fixtureSetup(plan, definition.extra(plan)), plan.publishCandidate);
      expect(result.rc, definition.id).toBe(12);
      expect(result.state, definition.id).toContain('CAND stat-missing');
      expect(result.publishOut, definition.id).not.toContain('cloudhelm-publish: candidate ready');
    }
  }, 240_000);

  it('refuses pre-existing candidates without touching them', () => {
    const foreign = 'occupied by a foreign pre-existing file';
    const foreignSha = createHash('sha256').update(foreign, 'utf8').digest('hex');
    const plan = planFor('occupied');
    const result = runCase(plan, fixtureSetup(plan, [`printf '%s' ${q(foreign)} > ${q(plan.candidatePath)}`]), plan.publishCandidate);
    expect(result.rc).toBe(13);
    expect(result.state).toContain('CAND regular file');
    expect(result.state).toContain(`${foreignSha}  ${plan.candidatePath}`);
    expect(result.state).toContain('TARGET stat-missing');
    expect(result.publishOut).not.toContain('cloudhelm-publish: candidate ready');
  }, 120_000);

  it('commits through the boundary hash and verifies metadata and read-back', () => {
    const plan = planFor('commit-ok');
    const result = runCase(plan, setupWithCandidate(plan), plan.publishCommit);
    expect(result.raw).toContain('CANDIDATE_RC=0');
    expect(result.rc).toBe(0);
    expect(parsePublishHash(result.publishOut, plan.candidatePath)).toBe(contentSha256);
    expect(parsePublishHash(result.publishOut, plan.targetPath)).toBe(contentSha256);
    expect(result.publishOut.indexOf(`${contentSha256}  ${plan.candidatePath}`))
      .toBeLessThan(result.publishOut.indexOf('cloudhelm-publish: committed'));
    expect(result.publishOut.indexOf(`${contentSha256}  ${plan.targetPath}`))
      .toBeGreaterThan(result.publishOut.indexOf('cloudhelm-publish: committed'));
    expect(result.publishOut).toContain('cloudhelm-publish: cleanup ok');
    expect(result.publishOut).toContain('cloudhelm-publish: readback verified');
    expect(result.state).toContain('TARGET regular file 644 root:root');
    expect(result.state).toContain(`${contentSha256}  ${plan.targetPath}`);
    expect(result.state).toContain('CAND stat-missing');
    expect(result.state).toContain('CANDLINK none');
  }, 120_000);

  it('refuses targets that appear between the phases without linking inside directories', () => {
    const cases: Array<{ id: string; after: (plan: CasePlan) => string[]; state: string[] }> = [
      { id: 'appeared-file', after: (plan) => [`printf '%s' 'appeared' > ${q(plan.targetPath)}`], state: ['TARGET regular file'] },
      { id: 'appeared-dir', after: (plan) => [`mkdir ${q(plan.targetPath)}`], state: ['TARGET directory'] },
      { id: 'appeared-link', after: (plan) => [`ln -s /etc/hostname ${q(plan.targetPath)}`], state: ['TARGETLINK symlink'] },
    ];
    for (const definition of cases) {
      const plan = planFor(definition.id);
      const result = runCase(plan, setupWithCandidate(plan, [], definition.after(plan)), plan.publishCommit);
      expect(result.raw, definition.id).toContain('CANDIDATE_RC=0');
      expect(result.rc, definition.id).toBe(20);
      for (const fragment of definition.state) expect(result.state, definition.id).toContain(fragment);
      expect(result.state, definition.id).toContain('CAND regular file 600 root:root');
      expect(result.state, definition.id).not.toMatch(/^DIRENTRY /mu);
      expect(result.publishOut, definition.id).not.toContain('cloudhelm-publish: committed');
    }
  }, 240_000);

  it('refuses candidates that lose exclusivity between the phases', () => {
    const cases: Array<{ id: string; after: (plan: CasePlan) => string[]; cand: string }> = [
      { id: 'lost-mode', after: (plan) => [`chmod 666 ${q(plan.candidatePath)}`], cand: 'CAND regular file 666 root:root' },
      { id: 'lost-owner', after: (plan) => [`rm ${q(plan.candidatePath)}`, `printf '%s' 'foreign replacement' > ${q(plan.candidatePath)}`,
        `chown nobody ${q(plan.candidatePath)}`, `chmod 600 ${q(plan.candidatePath)}`], cand: 'CAND regular file 600 nobody' },
      { id: 'lost-link', after: (plan) => [`rm ${q(plan.candidatePath)}`, `ln -s /etc/hostname ${q(plan.candidatePath)}`], cand: 'CANDLINK symlink' },
    ];
    for (const definition of cases) {
      const plan = planFor(definition.id);
      const result = runCase(plan, setupWithCandidate(plan, [], definition.after(plan)), plan.publishCommit);
      expect(result.raw, definition.id).toContain('CANDIDATE_RC=0');
      expect(result.rc, definition.id).toBe(21);
      expect(result.state, definition.id).toContain('TARGET stat-missing');
      expect(result.state, definition.id).toContain(definition.cand);
      expect(result.publishOut, definition.id).not.toContain('cloudhelm-publish: committed');
    }
  }, 240_000);

  it('emits tampered hashes when root tampers the candidate between the phases', () => {
    const tampered = 'tampered by root between the phases';
    const tamperedSha = createHash('sha256').update(tampered, 'utf8').digest('hex');
    const plan = planFor('tampered');
    const result = runCase(plan, setupWithCandidate(plan, [], [`printf '%s' ${q(tampered)} > ${q(plan.candidatePath)}`]), plan.publishCommit);
    // The structural guards still pass for a root-owned mode-600 replacement;
    // the emitted hashes differ from the review and are the backend gate's
    // detection input (covered by the worker tests).
    expect(result.raw).toContain('CANDIDATE_RC=0');
    expect(result.rc).toBe(0);
    expect(parsePublishHash(result.publishOut, plan.candidatePath)).toBe(tamperedSha);
    expect(parsePublishHash(result.publishOut, plan.targetPath)).toBe(tamperedSha);
    expect(result.state).toContain(`${tamperedSha}  ${plan.targetPath}`);
    expect(result.state).toContain('CAND stat-missing');
  }, 120_000);

  it('leaves committed-but-unverified targets when the reviewed owner is invalid', () => {
    const plan = planFor('bad-owner', 'nosuchuser:root');
    const result = runCase(plan, setupWithCandidate(plan), plan.publishCommit);
    expect(result.raw).toContain('CANDIDATE_RC=0');
    expect(result.rc).toBe(22);
    expect(result.state).toContain('TARGET regular file 600 root:root');
    expect(result.state).toContain(`${contentSha256}  ${plan.targetPath}`);
    expect(result.state).toContain('CAND regular file 600 root:root');
    expect(result.publishOut).toContain('cloudhelm-publish: committed');
    expect(result.publishOut).not.toContain('cloudhelm-publish: readback verified');
  }, 120_000);

  it('runs the production su-wrapped dispatches end to end', () => {
    const plan = planFor('su-e2e');
    const marker = '0123456789abcdef0123456789abcdef';
    const dispatch = (wrapped: string) => `printf '%s' 'cloudhelm:${marker}'; ${wrapped}`;
    const result = runCase(plan, [
      ...fixtureSetup(plan),
      `sh -c ${q(dispatch(plan.wrappedCandidate))}`,
      'echo "CANDIDATE_RC=$?"',
    ], dispatch(plan.wrappedCommit));
    expect(result.raw).toContain('CANDIDATE_RC=0');
    expect(result.rc).toBe(0);
    expect(parsePublishHash(result.publishOut, plan.candidatePath)).toBe(contentSha256);
    expect(parsePublishHash(result.publishOut, plan.targetPath)).toBe(contentSha256);
    expect(result.state).toContain('TARGET regular file 644 root:root');
    expect(result.state).toContain(`${contentSha256}  ${plan.targetPath}`);
    expect(result.state).toContain('CAND stat-missing');
  }, 180_000);

  afterAll(() => {
    if (!wslRootAvailable) return;
    runRootBash(`rm -rf ${q(baseRoot)}\nrm -f /tmp/chpub-*.staging\nexit 0`);
  });
});
