import path from 'node:path';
import type { CommandAnalysis, CommandCall } from './model.js';
import type { QueryPipelineStatus } from './query-pipeline-policy.js';

/** Fixed metadata only: never echo argv, paths, source, parser errors or goals. */
const descriptions = {
  'parse-incomplete': '语法解析不完整，不能确认整条命令的实际行为',
  'dynamic-input': '包含变量展开、替换或运行时输入，实际参数尚未固定',
  'execution-context': '执行目录、身份、命名空间或启动环境未能可靠确定',
  'argument-semantics': '部分参数的路径或操作语义尚未完整解析',
  'output-redirection': '包含重定向，不能仅按查询判断读写目标及影响',
  'pipeline-topology': '没有完整的单一前台管道拓扑证明，不能按命令名列表放行',
  'pipeline-source': '管道首阶段未被证明为受限查询，来源可能执行代码或改变状态',
  'pipeline-filter': '后续过滤器或参数不满足只读stdin规则，不能排除额外文件访问、写入或执行',
  'code-execution': '包含解释器、脚本或代码执行入口，程序名称不足以界定影响',
  'privilege-review': '包含显式身份切换或提权，无变更证明不代表此次身份操作已获批准',
  'launcher-context': '包含启动包装器，环境、身份或执行目标需要额外核对',
  'compound-flow': '复合命令并非全部已证明的查询，需要核对各步骤及分支影响',
  'custom-executable': '执行路径不属于已识别的系统程序位置，不能仅凭同名程序推定行为',
  'unsupported-query-form': '已知查询程序使用了未覆盖的参数组合，不能推定仍为只读查询',
  'unrecognized-operation': '没有匹配到可自动确认的查询或普通有界操作语法'
} as const;
export type CommandReviewReasonCode = keyof typeof descriptions;

export function describeCommandReview(codes: readonly CommandReviewReasonCode[]): string {
  return [...new Set(codes)].slice(0, 4).filter((code) => Object.hasOwn(descriptions, code))
    .map((code) => `[${code}] ${descriptions[code]}`).join('；');
}

export function commandReviewReasons(analysis: CommandAnalysis, knownQuery: (call: CommandCall) => boolean,
  pipeline?: QueryPipelineStatus): CommandReviewReasonCode[] {
  const reasons: CommandReviewReasonCode[] = [];
  const add = (code: CommandReviewReasonCode) => { if (!reasons.includes(code)) reasons.push(code); };
  if (analysis.hasError) add('parse-incomplete');
  if (analysis.hasExpansion || analysis.calls.some((call) => call.dynamic)) add('dynamic-input');
  if (analysis.calls.some((call) => analysis.scopedContexts && !call.context
    || call.context?.cwd.state === 'unknown' || call.context?.identity.state === 'unknown'
    || call.context?.namespace === 'unknown' || !!call.context?.unknownReasons.length)) add('execution-context');
  if (analysis.calls.some((call) => call.semantics?.coverage === 'partial'
    || ['git', 'tar'].some((name) => path.posix.basename(call.name) === name && !call.semantics?.[name as 'git' | 'tar']))) add('argument-semantics');
  if (analysis.hasRedirection) add('output-redirection');
  if (analysis.hasPipeline) add(pipeline === 'source-unproven' ? 'pipeline-source'
    : pipeline === 'filter-unproven' ? 'pipeline-filter' : 'pipeline-topology');
  const names = analysis.calls.map((call) => path.posix.basename(call.name));
  if (names.some((name) => ['bash', 'sh', 'zsh', 'fish', 'python', 'python3', 'node', 'perl', 'ruby', 'php', 'awk', 'sed',
    'eval', 'source', '.', 'xargs'].includes(name)) || names.some((name) => /\.(?:sh|bash|py|js|pl|rb|php)$/u.test(name))) add('code-execution');
  if (names.some((name) => ['sudo', 'su', 'doas', 'pkexec'].includes(name))) add('privilege-review');
  if (names.some((name) => ['env', 'command', 'exec', 'nohup', 'nice', 'time', 'timeout', 'setsid'].includes(name))) add('launcher-context');
  if (analysis.hasCompound && !analysis.hasPipeline && !reasons.includes('privilege-review') && !reasons.includes('launcher-context')) add('compound-flow');
  if (analysis.calls.some((call) => call.name.includes('/') && !/^\/(?:usr\/)?s?bin\/[^/]+$/u.test(call.name))) add('custom-executable');
  if (!reasons.length) add(analysis.calls.some(knownQuery) ? 'unsupported-query-form' : 'unrecognized-operation');
  return reasons.slice(0, 4);
}
