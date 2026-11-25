import path from 'node:path';

/** One structured create-only privileged publish, split into two backend-built
 * scripts. The reviewed content never travels through command text: a
 * separately reviewed write-file operation stages the exact bytes under the
 * ordinary login identity. The candidate script then re-verifies everything it
 * relies on at execution time — assertion-device availability, target
 * absence, staging shape, every parent component (real directory, no symlink,
 * root-owned, not group/world-writable) — creates a private exclusive
 * candidate inside the trusted target parent, keeps it root-owned mode 600
 * until commit, and emits the candidate's hash for the backend gate. Only
 * after that gate passes does the commit script re-verify the candidate
 * exclusively, emit its hash at the commit boundary, link it atomically with
 * ln -T (never inside an existing directory), apply the reviewed metadata,
 * verify and emit the committed file's hash again, and remove the candidate.
 * Every match-based guard asserts its match through a guaranteed-failing
 * -fprint /dev/full write, so a non-matching predicate can never pass
 * vacuously. Both scripts stay literal-only — no pipes, redirections,
 * expansions or variables — so the credential-bound native PTY su route
 * accepts the backend wrap. */
export interface PublishPlanInput {
  /** Canonical absolute POSIX target; never '/', no trailing slash, no '..'. */
  targetPath: string;
  /** Reviewed content hash, 64 lowercase hex characters. */
  contentSha256: string;
  /** Reviewed content length in UTF-8 bytes, 1..1048576. */
  contentBytes: number;
  /** Three-digit octal file mode, for example '644'. */
  mode: string;
  /** Final owner as user:group, for example 'root:root'. */
  owner: string;
  /** Canonical absolute staging path created by the staging write-file. */
  stagingPath: string;
  /** Random per-publish token naming the staging and candidate files. */
  nonce: string;
}

export interface PublishPlan {
  /** Candidate-phase script: guards, exclusive candidate copy, hash emit. */
  candidateScript: string;
  /** Commit-phase script: boundary verification, atomic link, read-back, cleanup. */
  commitScript: string;
  /** The same scripts wrapped for the credential-bound native PTY su route. */
  wrappedCandidateCommand: string;
  wrappedCommitCommand: string;
  /** Private candidate path inside the target parent. */
  candidatePath: string;
  /** Resolved target parent directory. */
  parentPath: string;
}

export type CandidatePhase = 'ready' | 'refused' | 'unknown';
export type CommitPhase = 'succeeded' | 'commit-failed' | 'committed-unverified' | 'unknown';

function isCanonicalAbsolutePath(value: string): boolean {
  return typeof value === 'string' && path.posix.isAbsolute(value) && value === path.posix.normalize(value)
    && !value.endsWith('/') && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value);
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Phase semantics of the candidate script's exit codes. Every refusal
 * (including the unreachable-working-directory 125) proves the target was
 * never touched and no commit may follow. */
export function candidateExitPhase(exitCode: number | undefined): CandidatePhase {
  if (exitCode === 0) return 'ready';
  if (exitCode === undefined) return 'unknown';
  if ((exitCode >= 10 && exitCode <= 14) || exitCode === 125) return 'refused';
  return 'unknown';
}

export function candidateExitCode(exitCode: number | undefined): string {
  switch (exitCode) {
    case 10: return 'target-exists';
    case 11: return 'staging-invalid';
    case 12: return 'parent-untrusted';
    case 13: return 'candidate-create-failed';
    case 14: return 'candidate-mode-failed';
    default: return 'unknown';
  }
}

/** Phase semantics of the commit script's exit codes. Exit 21 proves the
 * pre-commit guards refused the candidate before anything was linked; exit 22
 * means the reviewed content is committed but its metadata read-back failed. */
export function commitExitPhase(exitCode: number | undefined): CommitPhase {
  if (exitCode === 0) return 'succeeded';
  if (exitCode === undefined) return 'unknown';
  if (exitCode === 20 || exitCode === 21 || exitCode === 125) return 'commit-failed';
  if (exitCode === 22) return 'committed-unverified';
  return 'unknown';
}

export function commitExitCode(exitCode: number | undefined): string {
  switch (exitCode) {
    case 20: return 'commit-failed';
    case 21: return 'candidate-untrusted';
    case 22: return 'readback-metadata-mismatch';
    default: return 'unknown';
  }
}

/** Last sha256sum output line naming exactly this path; the command echo never
 * matches because it quotes the path. Undefined means the gate must refuse. */
export function parsePublishHash(output: string, filePath: string): string | undefined {
  let found: string | undefined;
  for (const line of output.split(/\r?\n/u)) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/u.exec(line);
    if (match && match[2] === filePath) found = match[1];
  }
  return found;
}

/** Best-effort candidate removal with its own marker line; the business exit
 * code stays independent of the cleanup outcome. unlink is the single-file
 * primitive: it has no recursive or directory semantics at all, so the
 * scripts stay unambiguous mass-destruction-free command sets. */
function cleanupClause(candidate: string): string {
  return `unlink ${quote(candidate)} && printf 'cloudhelm-publish: cleanup ok\\n' || printf 'cloudhelm-publish: cleanup failed\\n'`;
}

export function buildPublishPlan(input: PublishPlanInput): PublishPlan | undefined {
  if (!isCanonicalAbsolutePath(input.targetPath) || input.targetPath === '/') return undefined;
  if (!isCanonicalAbsolutePath(input.stagingPath)) return undefined;
  if (!/^[a-f0-9]{64}$/u.test(input.contentSha256)) return undefined;
  if (!Number.isSafeInteger(input.contentBytes) || input.contentBytes < 1 || input.contentBytes > 1_048_576) return undefined;
  if (!/^[0-7]{3}$/u.test(input.mode)) return undefined;
  if (!/^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/u.test(input.owner)) return undefined;
  if (!/^[a-f0-9]{16,64}$/u.test(input.nonce)) return undefined;
  const parentPath = path.posix.dirname(input.targetPath);
  const candidatePath = path.posix.join(parentPath, `.cloudhelm-publish-${input.nonce}`);
  const [user, group] = input.owner.split(':');
  // Trust is checked per component from '/' down to the parent: each must be a
  // real (non-symlink) root-owned directory that is not group/world-writable.
  const components: string[] = [];
  for (let current = parentPath; ; current = path.posix.dirname(current)) {
    components.unshift(current);
    if (current === '/') break;
  }
  // -fprint /dev/full turns a matching find into a guaranteed ENOSPC write
  // failure (find exits 1), so `find ... -fprint /dev/full && exit N` refuses
  // exactly when nothing matched. A missing /dev/full would make every such
  // guard pass vacuously, so its presence is asserted up front.
  const candidateLines: string[] = [
    `test -c /dev/full || exit 12`,
    `test ! -e ${quote(input.targetPath)} || exit 10`,
    `test ! -L ${quote(input.targetPath)} || exit 10`,
    `test ! -L ${quote(input.stagingPath)} || exit 11`,
    `test -f ${quote(input.stagingPath)} || exit 11`,
    `find ${quote(input.stagingPath)} -maxdepth 0 -type f -size ${input.contentBytes}c -fprint /dev/full && exit 11`,
  ];
  for (const component of components) {
    candidateLines.push(`test -d ${quote(component)} || exit 12`);
    candidateLines.push(`find ${quote(component)} -maxdepth 0 -type d -user root ! -perm -020 ! -perm -002 -fprint /dev/full && exit 12`);
  }
  // Exit 13 leaves the candidate untouched: an exclusive-create failure cannot
  // be distinguished from a pre-existing foreign file, so removal never runs.
  // The candidate stays root:root 600 — exclusive even against the reviewed
  // final metadata — until the commit script links it.
  candidateLines.push(
    `dd if=${quote(input.stagingPath)} of=${quote(candidatePath)} conv=excl || exit 13`,
    `chmod ${quote('600')} ${quote(candidatePath)} || { ${cleanupClause(candidatePath)}; exit 14; }`,
    `sha256sum ${quote(candidatePath)}`,
    `printf 'cloudhelm-publish: candidate ready\\n'`);
  const commitLines: string[] = [
    `test -c /dev/full || exit 21`,
    `test ! -e ${quote(input.targetPath)} || exit 20`,
    `test ! -L ${quote(input.targetPath)} || exit 20`,
    `test -f ${quote(candidatePath)} || exit 21`,
    `find ${quote(candidatePath)} -maxdepth 0 -type f -user root -perm 600 -fprint /dev/full && exit 21`,
    `sha256sum ${quote(candidatePath)}`,
    `ln -T ${quote(candidatePath)} ${quote(input.targetPath)} || exit 20`,
    `printf 'cloudhelm-publish: committed\\n'`,
    `chown ${quote(input.owner)} ${quote(input.targetPath)} || exit 22`,
    `chmod ${quote(input.mode)} ${quote(input.targetPath)} || exit 22`,
    `find ${quote(input.targetPath)} -maxdepth 0 -type f -user ${quote(user!)} -group ${quote(group!)} -perm ${input.mode} -fprint /dev/full && exit 22`,
    `sha256sum ${quote(input.targetPath)}`,
    cleanupClause(candidatePath),
    `printf 'cloudhelm-publish: readback verified\\n'`];
  const plan: PublishPlan = { candidateScript: candidateLines.join('\n'), commitScript: commitLines.join('\n'),
    candidatePath, parentPath, wrappedCandidateCommand: '', wrappedCommitCommand: '' };
  const suWrap = (script: string): string => `su -l -s /bin/sh root -c ${quote(`cd '/' || exit 125\n${script}`)}`;
  plan.wrappedCandidateCommand = suWrap(plan.candidateScript);
  plan.wrappedCommitCommand = suWrap(plan.commitScript);
  // Leave headroom for the transport's marker prefix inside the 8 KiB exec bound.
  if (Buffer.byteLength(plan.wrappedCandidateCommand, 'utf8') > 8000
    || Buffer.byteLength(plan.wrappedCommitCommand, 'utf8') > 8000) return undefined;
  return plan;
}
