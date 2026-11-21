import { analyzeQueryImpact, isQuery, isBlockDevice, BAD_DISK_TOOLS, PROJECT_CODE_COMMANDS } from './command-query-impact.js';
export { isReadOnlyQuery, isEffectFreeQuery } from './command-query-impact.js';
import { validFileEditCommit, validRecoveryEntryName, FILE_TRANSACTION_UUID } from './file-transaction.js';
import { SERVICE_PROPERTIES, validServiceUnit } from './service-observation.js';
import { analyzeOperationImpact } from './operation-impact.js';
import { commandTransfer } from './command-transfer.js';
import path from 'node:path';
import { describeCommandReview } from './command-review-reasons.js';
import { callDirectory, hasIncompleteCommandSemantics, resolveCommandDirectory, resolveCommandPath } from './command-semantics.js';
import type { CommandAnalysis, CommandCall, ProposedOperation, SafetyDecision, SafetySettings } from './model.js';

const CRITICAL_TREES = new Set(['/', '/etc', '/usr', '/usr/bin', '/usr/sbin', '/usr/lib', '/boot', '/home', '/root', '/var', '/var/lib', '/var/lib/docker', '/bin', '/sbin', '/lib', '/lib64', '/dev', '/proc', '/sys']);


const CRITICAL_FILES = new Set(['/etc/passwd', '/etc/shadow', '/etc/sudoers', '/etc/fstab']);
const ORDINARY_COMMANDS = new Set(['mkdir', 'touch', 'cp', 'mv', 'install', 'tee', 'truncate', 'chmod', 'chown', 'ln',
  'sed', 'patch', 'tar', 'unzip', 'git', 'python', 'python3', 'node',
  'systemctl', 'service', 'docker', 'apt', 'apt-get', 'dnf', 'yum', 'apk', 'brew', 'rsync', 'rm', 'rmdir']);
const OPAQUE_COMMANDS = new Set(['bash', 'sh', 'zsh', 'fish', 'python', 'python3', 'node', 'perl', 'ruby', 'php', 'eval', 'source', '.']);
const HIGH_IMPACT_COMMANDS = new Set(['useradd', 'userdel', 'usermod', 'groupadd', 'groupdel', 'passwd', 'chpasswd',
  'iptables', 'ip6tables', 'nft', 'ufw', 'firewall-cmd', 'shutdown', 'reboot', 'poweroff']);
/** Service-manager actions that change what code runs now or at boot, or take the host down. */
const SERVICE_AVAILABILITY_ACTIONS = new Set(['enable', 'reenable', 'disable', 'mask', 'unmask', 'link',
  'start', 'stop', 'restart', 'try-restart', 'reload-or-restart', 'force-reload', 'force-stop', 'kill', 'isolate',
  'reboot', 'poweroff', 'halt', 'suspend', 'hibernate', 'kexec', 'rescue', 'emergency']);

function decision(verdict: SafetyDecision['verdict'], ruleId: string, reason: string): SafetyDecision {
  return { verdict, ruleId, reason };
}

function literalPath(value: string, cwd: string | null): string | null {
  const unquoted = value.replace(/^(['"])(.*)\1$/u, '$2');
  return resolveCommandPath(unquoted, cwd);
}

function isInside(target: string, root: string): boolean {
  const normalized = path.posix.resolve(root);
  return target === normalized || target.startsWith(normalized === '/' ? '/' : `${normalized}/`);
}

function isRecursive(args: string[]): boolean {
  return args.some((arg) => arg === '--recursive' || /^-[a-zA-Z]*[rR]/u.test(arg));
}

function criticalMassTarget(value: string, cwd: string | null): boolean {
  const normalized = literalPath(value, cwd);
  if (normalized && CRITICAL_TREES.has(normalized)) return true;
  const unquoted = value.replace(/^(['"])(.*)\1$/u, '$2');
  const glob = unquoted.search(/[*?{\[]/u);
  if (glob < 0) return false;
  const prefix = unquoted.slice(0, glob);
  if (!cwd && !prefix.startsWith('/')) return false;
  const base = path.posix.resolve(cwd ?? '/', prefix);
  return CRITICAL_TREES.has(base) || [...CRITICAL_TREES].some((target) => target.startsWith(base));
}

function writableRootMount(args: string[]): boolean {
  return args.some((arg) => {
    const volume = arg.replace(/^(?:--volume=|-v)/u, '');
    if (volume.startsWith('/:')) return !(volume.split(':')[2] ?? '').split(',').includes('ro');
    const mount = arg.replace(/^--mount=/u, '');
    return /(?:^|,)(?:source|src)=\/(?:,|$)/u.test(mount)
      && !/(?:^|,)(?:readonly(?:=true)?|ro)(?:,|$)/u.test(mount);
  });
}

function findRoots(args: string[]): string[] {
  const roots: string[] = [];
  for (const arg of args) {
    if (!roots.length && ['-H', '-L', '-P'].includes(arg)) continue;
    if (arg.startsWith('-') || arg === '(' || arg === '!') break;
    roots.push(arg);
  }
  return roots.length ? roots : ['.'];
}

function hardCommandReason(analysis: CommandAnalysis, cwd: string): string | null {
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(analysis.raw)) return 'Terminal control bytes are not accepted in Agent commands';
  if (/\bsudo\s+(?:-[^\s]*S|--stdin)\b/u.test(analysis.raw)
    || /(?:password|passwd|otp|verification[_-]?code)\s*(?:=|:)\s*\S+/iu.test(analysis.raw)) {
    return 'Credentials must use the private authentication channel, never a Shell command';
  }
  let effectiveCwd: string | null = cwd;
  for (const call of analysis.calls) {
    if (analysis.scopedContexts) effectiveCwd = callDirectory(call, cwd);
    const name = path.posix.basename(call.name);
    if (!analysis.scopedContexts && (name === 'cd' || name === 'pushd')) effectiveCwd = literalPath(call.args.at(-1) ?? '', effectiveCwd);
    for (const effect of call.semantics?.tar?.paths ?? []) {
      if (effect.kind !== 'write') continue;
      const target = literalPath(effect.path, resolveCommandDirectory(effect.directory, cwd));
      if (target && (isBlockDevice(target) || CRITICAL_FILES.has(target))) return 'Archive output changes a disk or essential system file';
    }
    if ((BAD_DISK_TOOLS.has(name) || name.startsWith('mkfs.')) && !isQuery(call)) {
      return 'Disk formatting or partition mutation is reserved for manual operation';
    }
    if (name === 'dd' && call.args.some((arg) => isBlockDevice(literalPath(arg.replace(/^of=/u, ''), effectiveCwd) ?? ''))) return 'Direct disk overwrite is forbidden';
    if (['cp', 'mv', 'install', 'tee', 'truncate', 'shred'].includes(name)
      && call.args.some((arg) => isBlockDevice(literalPath(arg.replace(/^--[^=]+=/u, ''), effectiveCwd) ?? ''))) return 'Direct disk mutation is forbidden';
    if (['rm', 'mv', 'tee', 'truncate', 'shred'].includes(name) && call.args.some((arg) => CRITICAL_FILES.has(literalPath(arg, effectiveCwd) ?? ''))) return 'Destruction of essential system files is forbidden';
    if (['mv', 'rmdir'].includes(name) && call.args.some((arg) => criticalMassTarget(arg, effectiveCwd))) return 'Removing or relocating a system tree is forbidden';
    if (name === 'rsync' && call.args.some((arg) => arg.startsWith('--delete')) && criticalMassTarget(call.args.at(-1) ?? '', effectiveCwd)) return 'Deleting system-tree contents through synchronization is forbidden';
    if (name === 'find' && findRoots(call.args).some((arg) => criticalMassTarget(arg, effectiveCwd))
      && analysis.calls.some((nested) => ['rm', 'shred', 'truncate'].includes(path.posix.basename(nested.name)))) return 'Destructive traversal of a system tree is forbidden';
    if (name === 'find' && call.args.includes('-delete') && findRoots(call.args).some((arg) => criticalMassTarget(arg, effectiveCwd))) return 'Mass deletion of a system tree is forbidden';
    if ((name === 'chmod' || name === 'chown') && isRecursive(call.args) && call.args.some((arg) => criticalMassTarget(arg, effectiveCwd))) {
      return 'Recursive permission changes to a system tree are forbidden';
    }
    if (name === 'rm' && isRecursive(call.args)) {
      const targets = call.args.filter((arg) => !arg.startsWith('-'));
      if (targets.some((arg) => criticalMassTarget(arg, effectiveCwd))) {
        return 'Recursive deletion of a system tree is forbidden';
      }
    }
    if (name === 'docker' && call.args.some((arg) => arg === 'run' || arg === 'create') && writableRootMount(call.args)) {
      return 'Writable host-root mount is forbidden';
    }
  }
  if (analysis.redirectTargets.some(isBlockDevice)) return 'Direct redirection to a block device is forbidden';
  const redirects = analysis.redirectEffects?.map((effect) => ({ target: effect.target,
    cwd: resolveCommandDirectory(effect.context.cwd, cwd) }))
    ?? analysis.redirectTargets.map((target) => ({ target, cwd: effectiveCwd }));
  if (redirects.some((effect) => { const target = literalPath(effect.target, effect.cwd);
    return !!target && (isBlockDevice(target) || CRITICAL_FILES.has(target)); })) return 'Overwriting a disk or essential system file is forbidden';
  return null;
}

function readPaths(operation: ProposedOperation): string[] {
  return operation.scope.protectedReadPaths ?? operation.scope.protectedPaths;
}

function writePaths(operation: ProposedOperation): string[] {
  return operation.scope.protectedWritePaths ?? operation.scope.protectedPaths;
}

function protectedTarget(operation: ProposedOperation): boolean {
  const { cwd } = operation.scope;
  const raw = operation.kind === 'write-file' || operation.kind === 'delete-path' || operation.kind === 'cleanup-recovery' ? operation.path
    : operation.kind === 'upload' ? operation.remotePath : null;
  if (!raw) return false;
  const target = literalPath(raw, cwd);
  if (!target) return false;
  return writePaths(operation).some((protectedPath) => isInside(target, protectedPath)
    || (operation.kind === 'delete-path' && isInside(path.posix.resolve(protectedPath), target)));
}

function protectedCommandTarget(operation: ProposedOperation, analysis: CommandAnalysis): boolean {
  const { cwd } = operation.scope;
  let effectiveCwd: string | null = cwd;
  const overlaps = (raw: string, roots: string[], destructive: boolean, directory = effectiveCwd): boolean => {
    const value = raw.replace(/^[A-Za-z_-][A-Za-z_0-9-]*=/u, '');
    // A literal prefix of a glob still identifies a protected tree.
    const prefix = value.split(/[*?{\[]/u)[0] ?? '';
    const target = literalPath(prefix, directory);
    if (target === null) return false;
    return roots.some((root) => isInside(target, root)
      || (destructive && isInside(path.posix.resolve(root), target))
      || (prefix !== value && path.posix.resolve(root).startsWith(target)));
  };
  if (analysis.readRedirectEffects?.some((effect) => overlaps(effect.target, readPaths(operation), false,
    resolveCommandDirectory(effect.context.cwd, cwd)))) return true;
  if (analysis.redirectEffects?.some((effect) => overlaps(effect.target, writePaths(operation), false,
    resolveCommandDirectory(effect.context.cwd, cwd)))) return true;
  if (!analysis.redirectEffects && analysis.redirectTargets.some((target) => overlaps(target, writePaths(operation), false))) return true;
  for (const [index, call] of analysis.calls.entries()) {
    if (analysis.scopedContexts) effectiveCwd = callDirectory(call, cwd);
    const name = path.posix.basename(call.name);
    if (commandTransfer(call).reads.some((target) => overlaps(literalPath(target, effectiveCwd) ?? target, readPaths(operation), false))) return true;
    for (const effect of call.semantics?.tar?.paths ?? call.semantics?.git?.paths ?? []) {
      if (overlaps(effect.path, effect.kind === 'read' ? readPaths(operation) : writePaths(operation),
        effect.recursive ?? false, resolveCommandDirectory(effect.directory, cwd))) return true;
    }
    if (name === 'tar' && call.semantics?.tar && call.semantics.coverage === 'complete') continue;
    if (name === 'echo' || name === 'printf') continue;
    if (index < analysis.calls.length - 1 && ['sudo', 'env', 'command', 'exec', 'nohup', 'nice', 'time', 'timeout', 'setsid']
      .includes(name)) continue;
    const destructive = ['rm', 'rmdir', 'mv', 'chmod', 'chown', 'find', 'rsync'].includes(name);
    const readOnly = isQuery(call) || ['grep', 'head', 'tail', 'less', 'wc', 'file', 'sha256sum'].includes(name);
    const writeOnly = ['mkdir', 'touch', 'rm', 'rmdir', 'chmod', 'chown', 'truncate', 'tee'].includes(name);
    const targetArgs = call.semantics?.git?.args ?? call.args;
    const operands = targetArgs.filter((arg) => !arg.startsWith('-'));
    if (['cp', 'install'].includes(name) && !call.args.some((arg) => arg === '-t' || arg.startsWith('--target-directory'))) {
      if (operands.length >= 2) {
        if (operands.slice(0, -1).some((arg) => overlaps(arg, readPaths(operation), false))
          || overlaps(operands.at(-1)!, writePaths(operation), false)) return true;
        continue;
      }
    }
    const roots = readOnly ? readPaths(operation) : writeOnly ? writePaths(operation)
      : [...readPaths(operation), ...writePaths(operation)];
    if (targetArgs.some((arg) => (!arg.startsWith('-') || arg.includes('=')) && overlaps(arg, roots, destructive))) return true;
    if (!analysis.scopedContexts && (name === 'cd' || name === 'pushd')) effectiveCwd = literalPath(call.args.at(-1) ?? '', effectiveCwd);
  }
  if (!analysis.redirectEffects && analysis.redirectTargets.some((target) => overlaps(target, writePaths(operation), false))) return true;
  return false;
}

function isLowRiskCommand(analysis: CommandAnalysis, operation: ProposedOperation): boolean {
  if (hasIncompleteCommandSemantics(analysis)) return false;
  if (analyzeQueryImpact(analysis).autoApproval === 'eligible') return true;
  if (analysis.hasCompound || analysis.hasExpansion || analysis.hasPipeline || analysis.hasRedirection || analysis.calls.length !== 1) return false;
  const call = analysis.calls[0];
  if (!call) return false;
  if (call.name === 'cd' && call.args.length === 1) {
    const target = literalPath(call.args[0] ?? '', operation.scope.cwd);
    return target !== null && operation.scope.allowedWorkingRoots.some((root) => isInside(target, root));
  }
  if (call.name !== 'mkdir' || call.dynamic || call.redirects) return false;
  const args = call.args.filter((arg) => arg !== '-p' && arg !== '--parents' && arg !== '--');
  if (args.length === 0 || args.some((arg) => arg.startsWith('-'))) return false;
  return args.every((arg) => {
    const target = literalPath(arg, operation.scope.cwd);
    return target !== null
      && operation.scope.allowedWorkingRoots.some((root) => isInside(target, root))
      && !writePaths(operation).some((root) => isInside(target, root));
  });
}

function securityConfiguration(value: string, cwd: string | null): boolean {
  const target = literalPath(value, cwd);
  return !!target && (/^\/etc\/(?:ssh\/|sudoers(?:\.d\/|$)|sysctl\.d\/|iptables\/|systemd\/system\/)/u.test(target)
    || /^\/(?:usr\/)?lib\/systemd\/system\//u.test(target)
    || /^\/root\/\.ssh\//u.test(target) || /\/\.ssh\/authorized_keys$/u.test(target));
}

function highImpactCommand(analysis: CommandAnalysis, cwd: string): string | null {
  const names = analysis.calls.map((call) => path.posix.basename(call.name));
  const securityRedirect = analysis.redirectEffects
    ? analysis.redirectEffects.some((effect) => securityConfiguration(effect.target, resolveCommandDirectory(effect.context.cwd, cwd)))
    : analysis.redirectTargets.some((target) => securityConfiguration(target, cwd));
  if (securityRedirect
    || analysis.calls.some((call) => !isQuery(call) && (call.semantics?.tar
      ? call.semantics.tar.paths.some((effect) => effect.kind === 'write'
        && securityConfiguration(effect.path, resolveCommandDirectory(effect.directory, cwd)))
      : call.args.some((arg) => securityConfiguration(arg, callDirectory(call, cwd)))))) {
    return 'Changes SSH, sudo, service unit, or host security configuration';
  }
  if (names.some((name) => HIGH_IMPACT_COMMANDS.has(name))) return 'Changes account access, firewall, or host availability';
  // The backend service probe keeps its exact query shape; any service-manager
  // action outside it that changes availability or persistence stays high impact.
  if (analysis.calls.some((call) => {
    const name = path.posix.basename(call.name);
    return ['systemctl', 'service'].includes(name) && !isQuery(call)
      && call.args.some((arg) => SERVICE_AVAILABILITY_ACTIONS.has(arg));
  })) return 'Changes service or host availability through service management';
  if (analysis.calls.some((call) => {
    const name = path.posix.basename(call.name);
    if (name === 'rm' && isRecursive(call.args)) return true;
    if (['chmod', 'chown'].includes(name) && isRecursive(call.args)) return true;
    if (name === 'rsync' && call.args.some((arg) => arg.startsWith('--delete'))) return true;
    if (name === 'git' && (call.semantics?.git?.subcommand ?? call.args[0]) === 'reset'
      && (call.semantics?.git?.args ?? call.args).includes('--hard')) return true;
    if (name === 'docker' && (call.args.includes('prune') || call.args.includes('--volumes') || call.args.includes('-v') && call.args.includes('down'))) return true;
    return ['apt', 'apt-get', 'dnf', 'yum'].includes(name) && call.args.some((arg) => ['remove', 'purge', 'autoremove', 'upgrade', 'dist-upgrade'].includes(arg));
  })) return 'Broad deletion, permission, package, or volume change';
  if (analysis.hasPipeline && names.some((name) => ['curl', 'wget'].includes(name))
    && names.some((name) => ['sh', 'bash', 'zsh'].includes(name))) return 'Downloads and executes code without a stable reviewed copy';
  return null;
}

function ordinaryCommand(analysis: CommandAnalysis): boolean {
  if (analysis.hasExpansion || analysis.hasPipeline || !analysis.calls.length || hasIncompleteCommandSemantics(analysis)) return false;
  if (analysis.hasRedirection) {
    return analysis.calls.length === 1 && ['echo', 'printf'].includes(path.posix.basename(analysis.calls[0]!.name))
      && analysis.redirectTargets.length === 1 && !analysis.calls[0]!.dynamic;
  }
  if (analysis.hasCompound && analysis.steps?.length !== 1) return false;
  // A privileged wrapper ends the ordinary fast path: root reach makes
  // "bounded ordinary command" a false claim, mirroring the query machinery,
  // which never auto-approves sudo-wrapped queries either.
  if (analysis.calls.slice(0, -1).some((item) => !['env', 'command', 'exec', 'nohup', 'nice', 'time', 'timeout', 'setsid']
    .includes(path.posix.basename(item.name)))) return false;
  const call = analysis.calls.at(-1)!;
  const name = path.posix.basename(call.name);
  if (call.dynamic || !ORDINARY_COMMANDS.has(name)) return false;
  if (OPAQUE_COMMANDS.has(name) && call.args.some((arg) => ['-c', '-e', '--eval', '-m'].includes(arg)
    || /\.(?:py|js|sh|bash|pl|rb|php)$/u.test(arg))) return false;
  if (name === 'git' && ['clean', 'push', 'reset', 'rebase'].includes(call.semantics?.git?.subcommand ?? call.args[0] ?? '')) return false;
  if (name === 'docker' && !['compose', 'build', 'pull', 'ps', 'logs', 'restart', 'start', 'stop'].includes(call.args[0] ?? '')) return false;
  return true;
}

/** The inspector reads with the operation entry cwd, not a launcher's changed cwd. */
function scriptUsesEntryDirectory(call: CommandCall): boolean {
  return !call.context || call.context.namespace === 'inherited' && call.context.cwd.state === 'known'
    && call.context.cwd.changes.length === 0 && !call.context.unknownReasons.length;
}

/** A literal script file; dynamic or changed-context execution remains opaque. */
export function scriptFilePath(analysis: CommandAnalysis): string | undefined {
  if (analysis.hasError || analysis.hasExpansion || analysis.hasPipeline || analysis.hasRedirection
    || hasIncompleteCommandSemantics(analysis) || (analysis.hasCompound && analysis.steps?.length !== 1)) return undefined;
  const call = analysis.calls.find((item) => ['bash', 'sh', 'zsh'].includes(path.posix.basename(item.name))
    && scriptUsesEntryDirectory(item) && !item.dynamic && item.args.length >= 1 && !item.args[0]?.startsWith('-'));
  if (call) return call.args[0];
  const direct = analysis.calls.length === 1 ? analysis.calls[0] : undefined;
  return direct && scriptUsesEntryDirectory(direct) && !direct.dynamic && /\.\w*sh$/u.test(direct.name) ? direct.name : undefined;
}

export function inspectScriptSafety(operation: Extract<ProposedOperation, { kind: 'command' }>, source: string,
  analysis: CommandAnalysis, settings: SafetySettings): SafetyDecision {
  const inspected = { ...operation, command: source };
  const base = decideSafety(inspected, { ...settings, mode: 'ask' }, analysis);
  if (base.verdict === 'deny' || base.verdict === 'error') return base;
  const high = base.ruleId === 'high-impact-command';
  const impact = analyzeOperationImpact(inspected, analysis);
  const bounded = !high && impact.codeExecution !== 'detected' && impact.externalTransfer !== 'detected' && !analysis.hasExpansion && !analysis.hasPipeline && analysis.calls.length > 0
    && !analysis.calls.some((call) => call.dynamic || !['echo', 'printf'].includes(path.posix.basename(call.name))
      && !ordinaryCommand({ ...analysis, calls: [call], hasCompound: false, hasRedirection: false, hasPipeline: false }));
  if (bounded) return decision('allow', 'inspected-script', 'The current script source contains only bounded recognized actions');
  const ruleId = high ? 'high-impact-script' : 'script-uncertain';
  const reason = high ? base.reason : 'Inspected script still has effects that cannot be determined confidently';
  // High-impact script effects keep their risk in every mode: the permissive tier
  // relaxes opacity, never an identified high-impact action.
  if (settings.mode === 'permissive' && !high) {
    return decision('allow', 'permissive-script', 'Opaque script allowed in full-access mode');
  }
  // The ai-review tier triages opacity and high impact through the independent
  // reviewer first; only important or uncertain findings reach a human.
  if (settings.mode === 'ai-review') return { ...decision('evaluate', ruleId, reason), impact: high ? 'high' : 'unknown' };
  return { ...decision('ask', ruleId, reason), impact: high ? 'high' : 'unknown' };
}

function highImpactFile(operation: ProposedOperation): boolean {
  if (operation.kind === 'command') return false;
  const target = literalPath(operation.kind === 'upload' ? operation.remotePath : operation.path, operation.scope.cwd);
  return !!target && securityConfiguration(target, operation.scope.cwd);
}

/** Identified high impact always keeps a human or independent reviewer in the loop. */
function highImpactDecision(ruleId: string, reason: string, settings: SafetySettings): SafetyDecision {
  return { ...decision(settings.mode === 'ai-review' ? 'evaluate' : 'ask', ruleId, reason), impact: 'high' };
}

const RECOVERY_PROBE_QUERY_PREFIX = `systemctl show --no-pager --property=${SERVICE_PROPERTIES} -- `;

/** The recovery probe is backend-generated evidence collection after an unknown result:
 * exactly the read-only service query grammar, bound to the unknown operation it serves. */
function validRecoveryProbe(operation: Extract<ProposedOperation, { kind: 'command' }>): boolean {
  return typeof operation.recoveryTarget === 'string' && FILE_TRANSACTION_UUID.test(operation.recoveryTarget)
    && !operation.privilege && !operation.executionMode && !operation.processControl && !operation.outputExpectation
    && !operation.serviceUnit && operation.scope.sessionId === undefined
    && operation.command.startsWith(RECOVERY_PROBE_QUERY_PREFIX)
    && validServiceUnit(operation.command.slice(RECOVERY_PROBE_QUERY_PREFIX.length));
}

export function decideSafety(operation: ProposedOperation, settings: SafetySettings, analysis?: CommandAnalysis): SafetyDecision {
  const impact = analyzeOperationImpact(operation, analysis);
  if (settings.revision !== operation.scope.policyRevision) return decision('error', 'policy-stale', 'Policy changed after this operation was proposed');
  if (operation.scope.conversationRevision !== undefined && settings.conversationRevision !== undefined
    && settings.conversationRevision !== operation.scope.conversationRevision) {
    return decision('error', 'conversation-policy-stale', 'Conversation review mode changed after this operation was proposed');
  }
  if (operation.scope.reviewerRevision !== undefined && settings.reviewerRevision !== undefined
    && settings.reviewerRevision !== operation.scope.reviewerRevision) {
    return decision('error', 'reviewer-stale', 'Reviewer configuration changed after this operation was proposed');
  }
  if (operation.kind === 'command' && operation.probe === 'identity' && (operation.command !== 'id -u'
    || operation.privilege || operation.executionMode || operation.processControl || operation.outputExpectation || operation.serviceUnit
    || operation.recoveryTarget || operation.scope.sessionId !== undefined))
    return decision('error', 'invalid-internal-probe', 'Backend identity probe has an invalid shape; nothing dispatched');
  if (operation.kind === 'command' && operation.probe === 'recovery' && !validRecoveryProbe(operation))
    return decision('error', 'invalid-internal-probe', 'Backend recovery probe has an invalid shape; nothing dispatched');
  if (operation.kind === 'write-file' && operation.fileEdit && (!validFileEditCommit(operation.fileEdit) || !operation.expectedSha256 || operation.createOnly))
    return decision('error', 'invalid-file-transaction', 'Invalid backend file transaction; nothing dispatched');
  if (operation.kind === 'inspect-file' && operation.recoveryDirectoryId && !FILE_TRANSACTION_UUID.test(operation.recoveryDirectoryId))
    return decision('error', 'invalid-file-transaction', 'Invalid recovery directory binding');
  if (operation.kind === 'cleanup-recovery' && (!Array.isArray(operation.names) || operation.names.length < 1 || operation.names.length > 16
    || new Set(operation.names).size !== operation.names.length || operation.names.some((name) => !validRecoveryEntryName(name))))
    return decision('error', 'invalid-recovery-cleanup', 'Invalid recovery material names; nothing dispatched');
  if (operation.kind === 'upload') {
    const localRoot = path.resolve(operation.localRoot);
    const localTarget = path.resolve(operation.localPath);
    const relative = path.relative(localRoot, localTarget);
    if (!path.isAbsolute(operation.localRoot) || !path.isAbsolute(operation.localPath)
      || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return decision('deny', 'local-scope', 'Upload source is outside the user-selected local directory');
    }
  }
  if (operation.kind !== 'command' && operation.kind !== 'inspect-file') {
    const target = operation.kind === 'upload' ? operation.remotePath : operation.path;
    if (!literalPath(target, operation.scope.cwd)) return decision('error', 'path-opaque', 'Structured file target is not a literal path');
    const absolute = literalPath(target, operation.scope.cwd)!;
    if (isBlockDevice(absolute) || CRITICAL_FILES.has(absolute)) return decision('deny', 'system-resource', 'Changing disks or essential system files is forbidden');
  }
  if (impact.sensitiveRead === 'detected' && (operation.kind !== 'command' || analysis && !analysis.hasError)) return decision('deny', 'credential-resource', 'AI cannot read or transfer credential file contents');
  if (operation.kind === 'inspect-file') {
    const target = literalPath(operation.path, operation.scope.cwd);
    if (!target) return decision('error', 'path-opaque', 'An absolute literal file path is required');
    if (readPaths(operation).some((root) => isInside(target, root))) return decision('deny', 'protected-resource', 'Protected file read');
    return operation.privilege === 'root' ? highImpactDecision('privileged-file-read', 'Read a bounded file using operation-bound root authentication', settings)
      : decision('allow', 'structured-file-read', 'Bounded private inspection; no file mutation');
  }
  if (operation.kind === 'list-recovery') {
    const target = literalPath(operation.path, operation.scope.cwd);
    if (!target) return decision('error', 'path-opaque', 'An absolute literal directory path is required');
    if (readPaths(operation).some((root) => isInside(target, root))) return decision('deny', 'protected-resource', 'Protected resource listing');
    return operation.privilege === 'root' ? highImpactDecision('privileged-recovery-listing', 'List private recovery material using operation-bound root authentication', settings)
      : decision('allow', 'structured-file-read', 'Bounded private recovery listing; names and sizes only, no content read');
  }
  if (protectedTarget(operation)) return decision('deny', 'protected-resource', 'Target belongs to a user-protected resource');
  if (operation.kind === 'delete-path') {
    const target = literalPath(operation.path, operation.scope.cwd);
    if (target && CRITICAL_TREES.has(target)) return decision('deny', 'system-tree-delete', 'Deleting a system tree is forbidden');
  }
  if (operation.kind === 'command') {
    if (!analysis) return decision('error', 'analyzer-missing', 'Command analysis unavailable');
    if (analysis.hasError) return decision('error', 'parse-failed', 'Command could not be parsed completely');
    const hard = hardCommandReason(analysis, operation.scope.cwd);
    if (hard) return decision('deny', 'system-blacklist', hard);
    if (protectedCommandTarget(operation, analysis)) return decision('deny', 'protected-resource', 'Command accesses or removes a user-protected resource');
    if (isLowRiskCommand(analysis, operation)) return decision('allow', 'low-risk-command', 'Known low-risk command in the authorized context');
    const high = highImpactCommand(analysis, operation.scope.cwd);
    // Three-tier routing for identified high impact: the cautious tier asks,
    // the AI tier triages first, and even the permissive tier keeps asking.
    if (high) return highImpactDecision('high-impact-command', high, settings);
    if (analysis.calls.some((call) => PROJECT_CODE_COMMANDS.has(path.posix.basename(call.name)))) {
      return { verdict: settings.mode === 'ai-review' ? 'evaluate' : settings.mode === 'permissive' ? 'allow' : 'ask',
        ruleId: 'project-code-entry', impact: 'unknown',
        reason: settings.mode === 'permissive'
          ? 'Project code execution explicitly permitted by full-access mode; lifecycle/build effects remain unverified'
          : 'Package/build tools can execute project code or lifecycle hooks; program name alone does not bound their effects' };
    }
    // Detected effects outrank the legacy ordinary-program fast path. These
    // signals require review in cautious/AI modes, not a new hard prohibition;
    // permissive mode continues to allow opacity, never identified high impact.
    if (impact.externalTransfer === 'detected' || impact.codeExecution === 'detected') {
      const transfer = impact.externalTransfer === 'detected';
      const summary = transfer ? 'Command can transfer data outside the current host; destination and data scope remain unverified'
        : 'Command can execute code, hooks or package scripts; program name alone does not bound their effects';
      const reason = `${summary}；${describeCommandReview(impact.uncertaintyCodes)}`;
      return { verdict: settings.mode === 'ai-review' ? 'evaluate' : settings.mode === 'permissive' ? 'allow' : 'ask',
        ruleId: transfer ? 'external-transfer' : 'code-execution', impact: 'unknown',
        reason: settings.mode === 'permissive' ? `按所选宽松模式允许，影响未经确认；${reason}` : reason };
    }
    if (ordinaryCommand(analysis)) return decision('allow', 'ordinary-command', 'Bounded ordinary command');
  }
  if (operation.kind === 'write-file' && operation.fileEdit && operation.privilege === 'root')
    return highImpactDecision('privileged-file-edit', 'Commit exact reviewed content and metadata using operation-bound root authentication', settings);
  if (highImpactFile(operation)) {
    return highImpactDecision('high-impact-file', 'Changes host access, service unit, or security configuration', settings);
  }
  // Recovery material removal is always reviewed regardless of identity or mode:
  // an explicit, bounded, per-name decision; never a silent automatic cleanup.
  if (operation.kind === 'cleanup-recovery') {
    return highImpactDecision('recovery-cleanup', operation.privilege === 'root'
      ? 'Remove named private recovery material using operation-bound root authentication'
      : 'Remove named private recovery material in the target directory', settings);
  }
  if (operation.kind !== 'command') return decision('allow', 'structured-file', 'Bounded file operation with a literal target');
  const reason = describeCommandReview(analysis ? analyzeQueryImpact(analysis).reviewReasons ?? ['unrecognized-operation'] : ['parse-incomplete']);
  if (settings.mode === 'ask') return { ...decision('ask', 'uncertain-command', reason), impact: 'unknown' };
  if (settings.mode === 'ai-review') return { ...decision('evaluate', 'uncertain-command', reason), impact: 'unknown' };
  return decision('allow', 'permissive-mode', `按所选宽松模式允许，影响未经确认；${reason}`);
}
