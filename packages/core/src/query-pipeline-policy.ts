import type { CommandAnalysis, CommandCall } from './model.js';
import { hasIncompleteCommandSemantics } from './command-semantics.js';

/** Restrict downstream stages to stdin-only transforms: never file operands,
 * recursive reads, external helpers, output files, scripts or follow mode. */
function stdinFilter(call: CommandCall): boolean {
  if (call.dynamic || call.redirects) return false;
  const name = call.name.split('/').at(-1)!;
  if (![name, `/bin/${name}`, `/usr/bin/${name}`].includes(call.name)) return false;
  const args = call.args;
  if (args.length > 8 || args.some((arg) => /[\u0000-\u001f\u007f]/u.test(arg))) return false;
  if (name === 'head' || name === 'tail') {
    if (!args.length) return true;
    const count = args.length === 2 && ['-n', '--lines'].includes(args[0]!) ? args[1]
      : args.length === 1 ? /^(?:-n|--lines=|-)(\d+)$/u.exec(args[0]!)?.[1] : undefined;
    return !!count && /^[1-9]\d{0,3}$/u.test(count) && Number(count) <= 1000;
  }
  if (name === 'wc') return args.every((arg) => /^-[lwcmL]+$/u.test(arg)
    || ['--lines', '--words', '--bytes', '--chars', '--max-line-length'].includes(arg));
  if (name === 'uniq') return args.every((arg) => /^-[cdu]+$/u.test(arg));
  if (name !== 'grep') return false;
  let index = 0;
  while (index < args.length && args[index]!.startsWith('-') && args[index] !== '--') {
    if (!/^-[EFivnwcq]+$/u.test(args[index]!)) return false;
    index++;
  }
  if (args[index] === '--') index++;
  const pattern = args[index];
  return index === args.length - 1 && !!pattern && pattern.length <= 256;
}

/** This proves absence of business mutation only under the existing command
 * grammar. It neither grants path access nor authenticates remote executables. */
export type QueryPipelineStatus = 'proven' | 'topology-unproven' | 'source-unproven' | 'filter-unproven';
export function queryPipelineStatus(analysis: CommandAnalysis, sourceQuery: (call: CommandCall) => boolean): QueryPipelineStatus {
  const stages = analysis.literalPipeline?.stages;
  if (analysis.hasError || analysis.hasExpansion || analysis.hasRedirection || !analysis.hasPipeline
    || analysis.scopedContexts !== true || hasIncompleteCommandSemantics(analysis)
    || !stages || stages.length < 2 || stages.length > 6 || stages.length !== analysis.calls.length) return 'topology-unproven';
  if (!stages.every((span, index) => {
    const call = analysis.calls[index]!;
    return Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end) && span.start >= 0
      && span.end > span.start && span.end <= analysis.raw.length
      && (index === 0 || stages[index - 1]!.end < span.start)
      && call.source?.depth === 0 && call.source.start === span.start && call.source.end === span.end;
  })) return 'topology-unproven';
  if (!sourceQuery(analysis.calls[0]!)) return 'source-unproven';
  return analysis.calls.slice(1).every(stdinFilter) ? 'proven' : 'filter-unproven';
}
