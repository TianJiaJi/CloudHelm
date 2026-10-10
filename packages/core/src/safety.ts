import { isServiceQuery } from './service-observation.js';
import path from 'node:path';
import type { CommandAnalysis, CommandCall, ProposedOperation, SafetyDecision, SafetySettings } from './model.js';

const CRITICAL_TREES = new Set(['/', '/etc', '/usr', '/usr/bin', '/usr/sbin', '/usr/lib', '/boot', '/home', '/root', '/var', '/var/lib', '/var/lib/docker', '/bin', '/sbin', '/lib', '/lib64', '/dev', '/proc', '/sys']);
const QUERY_COMMANDS = new Set(['pwd', 'whoami', 'id', 'uname', 'uptime', 'date', 'df', 'free', 'hostname', 'ls', 'stat', 'cat']);
const BAD_DISK_TOOLS = new Set(['mkfs', 'mkfs.ext4', 'mkfs.xfs', 'mkswap', 'wipefs', 'sfdisk', 'fdisk', 'parted', 'blkdiscard']);
const CRITICAL_FILES = new Set(['/etc/passwd', '/etc/shadow', '/etc/sudoers', '/etc/fstab']);
const SENSITIVE_FILE = /(?:^\/etc\/(?:shadow|gshadow)$|\/\.ssh\/(?:id_[^/]+|authorized_keys)$|(?:^|\/)\.env(?:\.[^/]+)?$)/u;
const ORDINARY_COMMANDS = new Set(['mkdir', 'touch', 'cp', 'mv', 'install', 'tee', 'truncate', 'chmod', 'chown', 'ln',
  'sed', 'patch', 'tar', 'unzip', 'git', 'npm', 'pnpm', 'yarn', 'pip', 'pip3', 'python', 'python3', 'node',
  'systemctl', 'service', 'docker', 'apt', 'apt-get', 'dnf', 'yum', 'apk', 'brew', 'make', 'cmake', 'rsync', 'rm', 'rmdir']);
const OPAQUE_COMMANDS = new Set(['bash', 'sh', 'zsh', 'fish', 'python', 'python3', 'node', 'perl', 'ruby', 'php', 'eval', 'source', '.']);
const HIGH_IMPACT_COMMANDS = new Set(['useradd', 'userdel', 'usermod', 'groupadd', 'groupdel', 'passwd', 'chpasswd',
  'iptables', 'ip6tables', 'nft', 'ufw', 'firewall-cmd', 'shutdown', 'reboot', 'poweroff']);

function decision(verdict: SafetyDecision['verdict'], ruleId: string, reason: string): SafetyDecision {
  return { verdict, ruleId, reason };
}

function literalPath(value: string, cwd: string): string | null {
  if (!value || /[$`*?{}\[\]<>\n\r]/u.test(value)) return null;
  const unquoted = value.replace(/^(['"])(.*)\1$/u, '$2');
  if (!unquoted || unquoted.startsWith('~')) return null;
  return path.posix.resolve(cwd, unquoted);
}

function isInside(target: string, root: string): boolean {
  const normalized = path.posix.resolve(root);
  return target === normalized || target.startsWith(normalized === '/' ? '/' : `${normalized}/`);
}

function isRecursive(args: string[]): boolean {
  return args.some((arg) => arg === '--recursive' || /^-[a-zA-Z]*[rR]/u.test(arg));
}

function criticalMassTarget(value: string, cwd: string): boolean {
  const normalized = literalPath(value, cwd);
  if (normalized && CRITICAL_TREES.has(normalized)) return true;
  const unquoted = value.replace(/^(['"])(.*)\1$/u, '$2');
  const glob = unquoted.search(/[*?{\[]/u);
  if (glob < 0) return false;
  const base = path.posix.resolve(cwd, unquoted.slice(0, glob));
  return CRITICAL_TREES.has(base) || [...CRITICAL_TREES].some((target) => target.startsWith(base));
}

function isBlockDevice(value: string): boolean {
  return /^\/dev\/(?:[hsv]d[a-z]+\d*|xvd[a-z]+\d*|nvme\d+n\d+(?:p\d+)?|mmcblk\d+(?:p\d+)?|disk\d+(?:s\d+)?|(?:mapper|disk)\/.+|dm-\d+|loop\d+|md\d+|zram\d+)$/u.test(value);
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
  let effectiveCwd = cwd;
  for (const rawCall of analysis.calls) {
    const call = rawCall;
    const name = path.posix.basename(call.name);
    if (name === 'cd' || name === 'pushd') effectiveCwd = literalPath(call.args.at(-1) ?? '', effectiveCwd) ?? effectiveCwd;
    if ((BAD_DISK_TOOLS.has(name) || name.startsWith('mkfs.')) && !isQuery(call)) {
      return 'Disk formatting or partition mutation is reserved for manual operation';
    }
    if (name === 'dd' && call.args.some((arg) => isBlockDevice(arg.replace(/^of=/u, '')))) return 'Direct disk overwrite is forbidden';
    if (['cp', 'mv', 'install', 'tee', 'truncate', 'shred'].includes(name) && call.args.some((arg) => isBlockDevice(arg.replace(/^--[^=]+=/u, '')))) return 'Direct disk mutation is forbidden';
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
  if (analysis.redirectTargets.some((target) => CRITICAL_FILES.has(literalPath(target, effectiveCwd) ?? ''))) return 'Overwriting essential system files is forbidden';
  return null;
}

function sensitiveRead(analysis: CommandAnalysis, cwd: string): boolean {
  return analysis.calls.some((call) => {
    const name = path.posix.basename(call.name);
    if (!['cat', 'grep', 'head', 'tail', 'less', 'more', 'sed', 'awk', 'bash', 'sh', 'zsh', 'source', '.',
      'cp', 'mv', 'rsync', 'scp', 'tar', 'find', 'tee'].includes(name)) return false;
    return call.args.some((arg) => SENSITIVE_FILE.test(literalPath(arg, cwd) ?? ''));
  });
}

function readPaths(operation: ProposedOperation): string[] {
  return operation.scope.protectedReadPaths ?? operation.scope.protectedPaths;
}

function writePaths(operation: ProposedOperation): string[] {
  return operation.scope.protectedWritePaths ?? operation.scope.protectedPaths;
}

function protectedTarget(operation: ProposedOperation): boolean {
  const { cwd } = operation.scope;
  const raw = operation.kind === 'write-file' || operation.kind === 'delete-path' ? operation.path
    : operation.kind === 'upload' ? operation.remotePath : null;
  if (!raw) return false;
  const target = literalPath(raw, cwd);
  if (!target) return false;
  return writePaths(operation).some((protectedPath) => isInside(target, protectedPath)
    || (operation.kind === 'delete-path' && isInside(path.posix.resolve(protectedPath), target)));
}

function protectedCommandTarget(operation: ProposedOperation, analysis: CommandAnalysis): boolean {
  const { cwd } = operation.scope;
  let effectiveCwd = cwd;
  const overlaps = (raw: string, roots: string[], destructive: boolean): boolean => {
    const value = raw.replace(/^[A-Za-z_-][A-Za-z_0-9-]*=/u, '');
    // A literal prefix of a glob still identifies a protected tree.
    const prefix = value.split(/[*?{\[]/u)[0] ?? '';
    const target = literalPath(prefix, effectiveCwd);
    if (target === null) return false;
    return roots.some((root) => isInside(target, root)
      || (destructive && isInside(path.posix.resolve(root), target))
      || (prefix !== value && path.posix.resolve(root).startsWith(target)));
  };
  if (analysis.redirectTargets.some((target) => overlaps(target, writePaths(operation), false))) return true;
  for (const [index, call] of analysis.calls.entries()) {
    const name = path.posix.basename(call.name);
    if (name === 'echo' || name === 'printf') continue;
    if (index < analysis.calls.length - 1 && ['sudo', 'env', 'command', 'exec', 'nohup', 'nice', 'time', 'timeout', 'setsid']
      .includes(name)) continue;
    const destructive = ['rm', 'rmdir', 'mv', 'chmod', 'chown', 'find', 'rsync'].includes(name);
    const readOnly = isQuery(call) || ['grep', 'head', 'tail', 'less', 'wc', 'file', 'sha256sum'].includes(name);
    const writeOnly = ['mkdir', 'touch', 'rm', 'rmdir', 'chmod', 'chown', 'truncate', 'tee'].includes(name);
    const operands = call.args.filter((arg) => !arg.startsWith('-'));
    if (['cp', 'install'].includes(name) && !call.args.some((arg) => arg === '-t' || arg.startsWith('--target-directory'))) {
      if (operands.length >= 2) {
        if (operands.slice(0, -1).some((arg) => overlaps(arg, readPaths(operation), false))
          || overlaps(operands.at(-1)!, writePaths(operation), false)) return true;
        continue;
      }
    }
    const roots = readOnly ? readPaths(operation) : writeOnly ? writePaths(operation)
      : [...readPaths(operation), ...writePaths(operation)];
    if (call.args.some((arg) => (!arg.startsWith('-') || arg.includes('=')) && overlaps(arg, roots, destructive))) return true;
    if (name === 'cd' || name === 'pushd') effectiveCwd = literalPath(call.args.at(-1) ?? '', effectiveCwd) ?? effectiveCwd;
  }
  if (analysis.redirectTargets.some((target) => overlaps(target, writePaths(operation), false))) return true;
  return false;
}

function isQuery(call: CommandCall): boolean {
  if (call.dynamic || call.redirects) return false;
  const name = path.posix.basename(call.name);
  if (![name, `/bin/${name}`, `/usr/bin/${name}`].includes(call.name)) return false;
  if (isServiceQuery(name, call.args)) return true;
  // Docker's container listing is a daemon query. Keep the grammar narrow: a
  // global -H/--host, context switch, or extra subcommand changes the target.
  if (name === 'docker') {
    const flags = call.args[0] === 'ps' ? call.args.slice(1)
      : call.args[0] === 'container' && call.args[1] === 'ls' ? call.args.slice(2) : undefined;
    if (!flags) return false;
    for (let index = 0; index < flags.length; index++) {
      const flag = flags[index]!;
      if (['-a', '--all', '--no-trunc', '-q', '--quiet', '-s', '--size'].includes(flag)) continue;
      if (flag !== '--format' && !flag.startsWith('--format=')) return false;
      const format = flag === '--format' ? flags[++index] : flag.slice('--format='.length);
      if (!format || !/^(?:table )?\{\{\.[A-Za-z][A-Za-z0-9]*\}\}(?:(?:\\t|\t)\{\{\.[A-Za-z][A-Za-z0-9]*\}\})*$/u.test(format)) return false;
    }
    return true;
  }
  if ((BAD_DISK_TOOLS.has(name) || name.startsWith('mkfs.')) && call.args.length === 1
    && ['--help', '--version', '-h', '-V'].includes(call.args[0]!)) return true;
  if (name === 'fdisk') return ['-l', '--list'].includes(call.args[0] ?? '')
    && call.args.slice(1).every((arg) => isBlockDevice(arg));
  if (name === 'sfdisk') return ['-l', '--list'].includes(call.args[0] ?? '')
    && call.args.slice(1).every((arg) => isBlockDevice(arg));
  if (name === 'wipefs') return ['-n', '--no-act'].includes(call.args[0] ?? '')
    && call.args.slice(1).length > 0 && call.args.slice(1).every((arg) => isBlockDevice(arg));
  if (name === 'parted') return call.args.some((arg) => ['print', '-l', '--list'].includes(arg))
    && call.args.every((arg) => ['-s', '--script', 'print', 'free', '-l', '--list'].includes(arg) || isBlockDevice(arg));
  if (name === 'hostname') return call.args.every((arg) => ['-a', '-A', '-d', '-f', '-i', '-I', '-s', '--fqdn', '--short', '--domain', '--ip-address', '--all-ip-addresses'].includes(arg));
  if (name === 'date') return call.args.every((arg) => ['-u', '-R', '-I', '--utc', '--rfc-email', '--iso-8601'].includes(arg) || (arg.startsWith('+') && !/[\r\n]/u.test(arg)));
  if (name === 'ifconfig') {
    return call.args.length === 0 || (call.args.length === 1 && (call.args[0] === '-a' || /^[a-zA-Z][\w.:-]*$/u.test(call.args[0] ?? '')));
  }
  if (!QUERY_COMMANDS.has(name)) return false;
  if (call.args.some((arg) => /[$`*?{}\[\]<>\n\r]/u.test(arg))) return false;
  if (name === 'cat') {
    const paths = call.args[0] === '--' ? call.args.slice(1) : call.args;
    return paths.length > 0 && paths.every((value) => value.length > 0 && !/^[-~]/u.test(value)
      && !/[\u0000-\u001f\u007f]/u.test(value) && !/^\/(?:dev\/(?:stdin|fd\/0)|proc\/(?:self|\d+)\/fd\/0)$/u.test(value));
  }
  if (name === 'ls' || name === 'stat') return !call.args.some((arg) => arg.startsWith('--output='));
  return call.args.every((arg) => !arg.startsWith('-') || /^-[a-zA-Z]+$/u.test(arg));
}

/** This capability is minted by the safety gate, never supplied by model/tool arguments. */
export function isReadOnlyQuery(analysis: CommandAnalysis): boolean {
  if (analysis.hasError || analysis.hasExpansion || analysis.hasPipeline || analysis.hasRedirection) return false;
  if (!analysis.hasCompound && analysis.calls.length === 1) return isQuery(analysis.calls[0]!);
  // The analyzer exposes a plain sudo invocation both as a wrapper and as its
  // inner call. Only the Docker listing needed to inspect daemon access gets
  // this capability; privileged file reads retain their separate review path.
  const [wrapper, inner] = analysis.calls;
  return analysis.hasCompound && analysis.steps?.length === 1 && analysis.calls.length === 2
    && wrapper?.name === 'sudo' && !wrapper.dynamic && !wrapper.redirects
    && !!inner && path.posix.basename(inner.name) === 'docker' && isQuery(inner)
    && wrapper.args.length === inner.args.length + 1 && wrapper.args[0] === inner.name
    && wrapper.args.slice(1).every((arg, index) => arg === inner.args[index]);
}

function isLowRiskCommand(analysis: CommandAnalysis, operation: ProposedOperation): boolean {
  if (isReadOnlyQuery(analysis)) return true;
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

function securityConfiguration(value: string, cwd: string): boolean {
  const target = literalPath(value, cwd);
  return !!target && (/^\/etc\/(?:ssh\/|sudoers(?:\.d\/|$)|sysctl\.d\/|iptables\/)/u.test(target)
    || /^\/root\/\.ssh\//u.test(target) || /\/\.ssh\/authorized_keys$/u.test(target));
}

function highImpactCommand(analysis: CommandAnalysis, cwd: string): string | null {
  const names = analysis.calls.map((call) => path.posix.basename(call.name));
  if (analysis.redirectTargets.some((target) => securityConfiguration(target, cwd))
    || analysis.calls.some((call) => !isQuery(call) && call.args.some((arg) => securityConfiguration(arg, cwd)))) {
    return 'Changes SSH, sudo, or host security configuration';
  }
  if (names.some((name) => HIGH_IMPACT_COMMANDS.has(name))) return 'Changes account access, firewall, or host availability';
  if (analysis.calls.some((call) => {
    const name = path.posix.basename(call.name);
    if (name === 'rm' && isRecursive(call.args)) return true;
    if (['chmod', 'chown'].includes(name) && isRecursive(call.args)) return true;
    if (name === 'rsync' && call.args.some((arg) => arg.startsWith('--delete'))) return true;
    if (name === 'git' && call.args[0] === 'reset' && call.args.includes('--hard')) return true;
    if (name === 'docker' && (call.args.includes('prune') || call.args.includes('--volumes') || call.args.includes('-v') && call.args.includes('down'))) return true;
    return ['apt', 'apt-get', 'dnf', 'yum'].includes(name) && call.args.some((arg) => ['remove', 'purge', 'autoremove', 'upgrade', 'dist-upgrade'].includes(arg));
  })) return 'Broad deletion, permission, package, or volume change';
  if (analysis.hasPipeline && names.some((name) => ['curl', 'wget'].includes(name))
    && names.some((name) => ['sh', 'bash', 'zsh'].includes(name))) return 'Downloads and executes code without a stable reviewed copy';
  return null;
}

function ordinaryCommand(analysis: CommandAnalysis): boolean {
  if (analysis.hasExpansion || analysis.hasPipeline || !analysis.calls.length) return false;
  if (analysis.hasRedirection) {
    return analysis.calls.length === 1 && ['echo', 'printf'].includes(path.posix.basename(analysis.calls[0]!.name))
      && analysis.redirectTargets.length === 1 && !analysis.calls[0]!.dynamic;
  }
  if (analysis.hasCompound && analysis.steps?.length !== 1) return false;
  if (analysis.calls.slice(0, -1).some((item) => !['sudo', 'env', 'command', 'exec', 'nohup', 'nice', 'time', 'timeout', 'setsid']
    .includes(path.posix.basename(item.name)))) return false;
  const call = analysis.calls.at(-1)!;
  const name = path.posix.basename(call.name);
  if (call.dynamic || !ORDINARY_COMMANDS.has(name)) return false;
  if (OPAQUE_COMMANDS.has(name) && call.args.some((arg) => ['-c', '-e', '--eval', '-m'].includes(arg)
    || /\.(?:py|js|sh|bash|pl|rb|php)$/u.test(arg))) return false;
  if (name === 'git' && ['clean', 'push', 'reset', 'rebase'].includes(call.args[0] ?? '')) return false;
  if (name === 'docker' && !['compose', 'build', 'pull', 'ps', 'logs', 'restart', 'start', 'stop'].includes(call.args[0] ?? '')) return false;
  return true;
}

/** A literal script file; dynamic arguments and shell snippets remain opaque. */
export function scriptFilePath(analysis: CommandAnalysis): string | undefined {
  if (analysis.hasError || analysis.hasExpansion || analysis.hasPipeline || analysis.hasRedirection
    || (analysis.hasCompound && analysis.steps?.length !== 1)) return undefined;
  const call = analysis.calls.find((item) => ['bash', 'sh', 'zsh'].includes(path.posix.basename(item.name))
    && !item.dynamic && item.args.length >= 1 && !item.args[0]?.startsWith('-'));
  if (call) return call.args[0];
  const direct = analysis.calls.length === 1 ? analysis.calls[0] : undefined;
  return direct && !direct.dynamic && /\.\w*sh$/u.test(direct.name) ? direct.name : undefined;
}

export function inspectScriptSafety(operation: Extract<ProposedOperation, { kind: 'command' }>, source: string,
  analysis: CommandAnalysis, settings: SafetySettings): SafetyDecision {
  const inspected = { ...operation, command: source };
  const base = decideSafety(inspected, { ...settings, mode: 'ask' }, analysis);
  if (base.verdict === 'deny' || base.verdict === 'error' || base.ruleId === 'high-impact-command') return base;
  if (analysis.hasExpansion || analysis.hasPipeline || analysis.calls.length === 0
    || analysis.calls.some((call) => call.dynamic || !['echo', 'printf'].includes(path.posix.basename(call.name))
      && !ordinaryCommand({ ...analysis, calls: [call], hasCompound: false, hasRedirection: false, hasPipeline: false }))) {
    return { verdict: 'ask', ruleId: 'script-uncertain', reason: 'Inspected script still has effects that cannot be determined confidently', impact: 'unknown' };
  }
  return { verdict: 'allow', ruleId: 'inspected-script', reason: 'The current script source contains only bounded recognized actions' };
}

function highImpactFile(operation: ProposedOperation): boolean {
  if (operation.kind === 'command') return false;
  const target = literalPath(operation.kind === 'upload' ? operation.remotePath : operation.path, operation.scope.cwd);
  return !!target && securityConfiguration(target, operation.scope.cwd);
}

export function decideSafety(operation: ProposedOperation, settings: SafetySettings, analysis?: CommandAnalysis): SafetyDecision {
  if (settings.revision !== operation.scope.policyRevision) return decision('error', 'policy-stale', 'Policy changed after this operation was proposed');
  if (operation.scope.conversationRevision !== undefined && settings.conversationRevision !== undefined
    && settings.conversationRevision !== operation.scope.conversationRevision) {
    return decision('error', 'conversation-policy-stale', 'Conversation review mode changed after this operation was proposed');
  }
  if (operation.scope.reviewerRevision !== undefined && settings.reviewerRevision !== undefined
    && settings.reviewerRevision !== operation.scope.reviewerRevision) {
    return decision('error', 'reviewer-stale', 'Reviewer configuration changed after this operation was proposed');
  }
  if (operation.kind === 'upload') {
    const localRoot = path.resolve(operation.localRoot);
    const localTarget = path.resolve(operation.localPath);
    const relative = path.relative(localRoot, localTarget);
    if (!path.isAbsolute(operation.localRoot) || !path.isAbsolute(operation.localPath)
      || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return decision('deny', 'local-scope', 'Upload source is outside the user-selected local directory');
    }
  }
  if (operation.kind !== 'command') {
    const target = operation.kind === 'upload' ? operation.remotePath : operation.path;
    if (!literalPath(target, operation.scope.cwd)) return decision('error', 'path-opaque', 'Structured file target is not a literal path');
    const absolute = literalPath(target, operation.scope.cwd)!;
    if (isBlockDevice(absolute) || CRITICAL_FILES.has(absolute)) return decision('deny', 'system-resource', 'Changing disks or essential system files is forbidden');
  }
  if (protectedTarget(operation)) return decision('deny', 'protected-resource', 'Target belongs to a user-protected resource');
  if (operation.kind === 'delete-path') {
    const target = literalPath(operation.path, operation.scope.cwd);
    if (target && CRITICAL_TREES.has(target)) return decision('deny', 'system-tree-delete', 'Deleting a system tree is forbidden');
  }
  if (operation.kind === 'command') {
    if (!analysis) return decision('error', 'analyzer-missing', 'Command analysis unavailable');
    if (analysis.hasError) return decision('error', 'parse-failed', 'Command could not be parsed completely');
    if (sensitiveRead(analysis, operation.scope.cwd)) return decision('deny', 'credential-resource', 'AI cannot read credential file contents');
    const hard = hardCommandReason(analysis, operation.scope.cwd);
    if (hard) return decision('deny', 'system-blacklist', hard);
    if (protectedCommandTarget(operation, analysis)) return decision('deny', 'protected-resource', 'Command accesses or removes a user-protected resource');
    if (isLowRiskCommand(analysis, operation)) return decision('allow', 'low-risk-command', 'Known low-risk command in the authorized context');
    const high = highImpactCommand(analysis, operation.scope.cwd);
    if (high && settings.mode !== 'permissive') return { ...decision('ask', 'high-impact-command', high), impact: 'high' };
    if (ordinaryCommand(analysis)) return decision('allow', 'ordinary-command', 'Bounded ordinary command');
  }
  if (highImpactFile(operation) && settings.mode !== 'permissive') return { ...decision('ask', 'high-impact-file', 'Changes host access or security configuration'), impact: 'high' };
  if (operation.kind !== 'command') return decision('allow', 'structured-file', 'Bounded file operation with a literal target');
  if (settings.mode === 'ask') return { ...decision('ask', 'uncertain-command', 'Command effects cannot be determined with enough confidence'), impact: 'unknown' };
  if (settings.mode === 'ai-review') return { ...decision('evaluate', 'uncertain-command', 'Independent AI review required for uncertain effects'), impact: 'unknown' };
  return decision('allow', 'permissive-mode', 'Allowed by the selected review mode');
}
