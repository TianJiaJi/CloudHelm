import path from 'node:path';
import type { CommandAnalysis, CommandCall } from './model.js';
import { hasIncompleteCommandSemantics } from './command-semantics.js';
import { isServiceQuery } from './service-observation.js';
import { isDockerMetadataQuery } from './docker-query-policy.js';
import { DIAGNOSTIC_QUERY_PROGRAMS, isBoundedDiagnosticCall } from './diagnostic-query-policy.js';
import { queryPipelineStatus, type QueryPipelineStatus } from './query-pipeline-policy.js';
import { commandReviewReasons, type CommandReviewReasonCode } from './command-review-reasons.js';

const QUERY_COMMANDS = new Set(['pwd', 'whoami', 'id', 'uname', 'uptime', 'date', 'df', 'free', 'hostname', 'ls', 'stat', 'cat']);
export const BAD_DISK_TOOLS: ReadonlySet<string> = new Set(['mkfs', 'mkfs.ext4', 'mkfs.xfs', 'mkswap', 'wipefs', 'sfdisk', 'fdisk', 'parted', 'blkdiscard']);
export const PROJECT_CODE_COMMANDS: ReadonlySet<string> = new Set(['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'pip', 'pip3', 'make', 'gmake', 'cmake', 'ninja', 'meson']);

export function isBlockDevice(value: string): boolean {
  return /^\/dev\/(?:[hsv]d[a-z]+\d*|xvd[a-z]+\d*|nvme\d+n\d+(?:p\d+)?|mmcblk\d+(?:p\d+)?|disk\d+(?:s\d+)?|(?:mapper|disk)\/.+|dm-\d+|loop\d+|md\d+|zram\d+)$/u.test(value);
}

export function isQuery(call: CommandCall): boolean {
  if (call.dynamic || call.redirects) return false;
  const name = path.posix.basename(call.name);
  if (![name, `/bin/${name}`, `/usr/bin/${name}`].includes(call.name)) return false;
  if (name === 'date') return call.args.every((arg) => arg.startsWith('+') || ['-u', '--utc', '--universal', '-R', '--rfc-email', '-I', '--iso-8601', '--help', '--version'].includes(arg));
  if (name === 'hostname') return call.args.every((arg) => ['-f', '--fqdn', '-s', '--short', '-I', '--all-ip-addresses', '-i', '--ip-address', '-d', '--domain', '-A', '--all-fqdns', '--help', '--version'].includes(arg));
  if (isServiceQuery(name, call.args)) return true;
  if (name === 'docker') return isDockerMetadataQuery(call.args);
  if (PROJECT_CODE_COMMANDS.has(name)) return call.args.length === 1 && call.args[0] === '--version';
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
function plainSudoQuery(analysis: CommandAnalysis, names: readonly string[], allowList = false): boolean {
  const steps = analysis.steps;
  if (analysis.hasError || analysis.hasExpansion || analysis.hasPipeline || analysis.hasRedirection
    || !analysis.hasCompound || !steps?.length || (!allowList && steps.length !== 1)
    || analysis.calls.length !== steps.length * 2) return false;
  return steps.every(({ call }, step) => {
    const wrapper = analysis.calls[step * 2];
    const inner = analysis.calls[step * 2 + 1];
    return wrapper?.name === 'sudo' && wrapper.name === call.name && !wrapper.dynamic && !wrapper.redirects
      && wrapper.args.length === call.args.length && wrapper.args.every((arg, index) => arg === call.args[index])
      && !!inner && names.includes(path.posix.basename(inner.name)) && isQuery(inner)
      && wrapper.args.length === inner.args.length + 1 && wrapper.args[0] === inner.name
      && wrapper.args.slice(1).every((arg, index) => arg === inner.args[index]);
  });
}

/** Legacy single-query recognizer; review uses the shared impact proof below. */
export function isReadOnlyQuery(analysis: CommandAnalysis): boolean {
  if (analysis.hasError || analysis.hasExpansion || analysis.hasPipeline || analysis.hasRedirection || hasIncompleteCommandSemantics(analysis)) return false;
  if (!analysis.hasCompound && analysis.calls.length === 1) return isQuery(analysis.calls[0]!);
  return plainSudoQuery(analysis, ['docker']);
}

/** Literal query lists share one structural proof; path policy is checked separately. */
function literalReadList(analysis: CommandAnalysis): boolean {
  return !analysis.hasError && !analysis.hasExpansion && !analysis.hasPipeline && !analysis.hasRedirection
    && !!analysis.steps && analysis.steps.length > 1 && analysis.calls.length === analysis.steps.length
    && analysis.steps.every(({ call }, index) => !call.dynamic && !call.redirects && (isQuery(call) || isBoundedDiagnosticCall(call))
      && analysis.calls[index]?.name === call.name && analysis.calls[index]?.args.length === call.args.length
      && call.args.every((arg, argIndex) => analysis.calls[index]?.args[argIndex] === arg));
}

/** A literal sudo wrapper (optional -- only) preserves a proven query's effects,
 * not its auto-approval. Never accept identity/options, scripts or extra calls. */
function singleSudoEffectFree(analysis: CommandAnalysis): boolean {
  const wrapper = analysis.steps?.[0]?.call;
  const inner = analysis.calls[1];
  if (analysis.hasError || analysis.hasExpansion || analysis.hasPipeline || analysis.hasRedirection || analysis.steps?.length !== 1
    || analysis.calls.length !== 2 || !wrapper || !['sudo', '/usr/bin/sudo'].includes(wrapper.name)
    || wrapper.dynamic || wrapper.redirects || !inner || analysis.steps[0]?.condition !== 'always' || analysis.calls[0]?.name !== wrapper.name
    || analysis.calls[0].args.length !== wrapper.args.length || !wrapper.args.every((arg, i) => arg === analysis.calls[0]?.args[i])) return false;
  const args = wrapper.args[0] === '--' ? wrapper.args.slice(1) : wrapper.args;
  return args.length === inner.args.length + 1 && args[0] === inner.name
    && args.slice(1).every((arg, index) => arg === inner.args[index]) && isQuery(inner);
}

/** Shared query facts for review and replay/effect classification. This is not
 * access authorization: callers must still apply sensitive/protected paths,
 * scope, identity, current leases and durable audit before executing anything. */
export interface QueryImpact {
  /** Fixed explanations only, not permissions or model-supplied instructions. */
  reviewReasons?: CommandReviewReasonCode[];
  effects: 'none' | 'unknown';
  autoApproval: 'eligible' | 'review-required';
  evidence: 'known-query' | 'bounded-diagnostic' | 'literal-query-list' | 'query-pipeline' | 'privileged-query' | 'unproven';
}

export function analyzeQueryImpact(analysis: CommandAnalysis): QueryImpact {
  const known = (evidence: QueryImpact['evidence'], eligible = true): QueryImpact => ({
    effects: 'none', autoApproval: eligible ? 'eligible' : 'review-required', evidence });
  let pipeline: QueryPipelineStatus | undefined;
  if (!hasIncompleteCommandSemantics(analysis)) {
    if (isReadOnlyQuery(analysis)) return known('known-query');
    const diagnostic = !analysis.hasError && !analysis.hasExpansion && !analysis.hasPipeline && !analysis.hasRedirection
      && !analysis.hasCompound && analysis.calls.length === 1 && isBoundedDiagnosticCall(analysis.calls[0]!);
    if (diagnostic) return known('bounded-diagnostic');
    if (literalReadList(analysis)) return known('literal-query-list');
    if (analysis.hasPipeline) pipeline = queryPipelineStatus(analysis, (call) => isQuery(call) || isBoundedDiagnosticCall(call));
    if (pipeline === 'proven') return known('query-pipeline');
    if (plainSudoQuery(analysis, ['cat', 'ls', 'stat'], true) || singleSudoEffectFree(analysis))
      return { ...known('privileged-query', false), reviewReasons: ['privilege-review'] };
  }
  const reviewReasons = commandReviewReasons(analysis, (call) => {
    const name = path.posix.basename(call.name);
    return QUERY_COMMANDS.has(name) || DIAGNOSTIC_QUERY_PROGRAMS.has(name) || BAD_DISK_TOOLS.has(name)
      || PROJECT_CODE_COMMANDS.has(name) || ['docker', 'systemctl', 'journalctl', 'ifconfig'].includes(name);
  }, pipeline);
  return { effects: 'unknown', autoApproval: 'review-required', evidence: 'unproven', reviewReasons };
}

/** Effect-free does not imply permission, process exit, or automatic approval. */
export function isEffectFreeQuery(analysis: CommandAnalysis): boolean {
  return analyzeQueryImpact(analysis).effects === 'none';
}
