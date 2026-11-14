import path from 'node:path';
import type { CommandAnalysis, ProposedOperation } from './model.js';
import { analyzeQueryImpact, PROJECT_CODE_COMMANDS } from './command-query-impact.js';
import { hasIncompleteCommandSemantics } from './command-semantics.js';
import { hasSensitiveCommandRead } from './command-sensitive-read.js';
import { isSensitiveReadPath } from './sensitive-read.js';
import { commandTransfer } from './command-transfer.js';
import type { CommandReviewReasonCode } from './command-review-reasons.js';

export type ImpactSignal = 'detected' | 'not-detected' | 'unknown';
/** Metadata, never an approval token or proof that a process ran. not-detected
 * means no matching syntax, not a guarantee against arbitrary hidden effects. */
export interface OperationImpact {
  version: 1;
  mutation: 'none' | 'possible';
  sensitiveRead: ImpactSignal;
  externalTransfer: ImpactSignal;
  codeExecution: ImpactSignal;
  evidence: 'query-proof' | 'structured-file' | 'known-mutation' | 'unproven';
  uncertaintyCodes: CommandReviewReasonCode[];
}
const MUTATORS = new Set(['mkdir', 'touch', 'cp', 'mv', 'install', 'tee', 'truncate', 'chmod', 'chown', 'ln', 'rm', 'rmdir']);
const CODE = new Set(['bash', 'sh', 'zsh', 'fish', 'python', 'python3', 'node', 'perl', 'ruby', 'php', 'awk', 'sed', 'eval', 'source', '.', 'xargs']);

export function analyzeOperationImpact(operation: ProposedOperation, analysis?: CommandAnalysis): OperationImpact {
  if (operation.kind !== 'command') return { version: 1, mutation: 'possible', evidence: 'structured-file',
    sensitiveRead: operation.kind === 'upload' && isSensitiveReadPath(operation.localPath.replace(/\\/gu, '/')) ? 'detected' : 'not-detected',
    externalTransfer: operation.kind === 'upload' ? 'detected' : 'not-detected', codeExecution: 'not-detected', uncertaintyCodes: [] };
  if (!analysis) return { version: 1, mutation: 'possible', sensitiveRead: 'unknown', externalTransfer: 'unknown',
    codeExecution: 'unknown', evidence: 'unproven', uncertaintyCodes: ['parse-incomplete'] };
  const query = analyzeQueryImpact(analysis), readOnly = query.effects === 'none';
  const knownMutation = !analysis.hasError && !analysis.hasExpansion && !analysis.hasPipeline && !analysis.hasCompound
    && !analysis.hasRedirection && !hasIncompleteCommandSemantics(analysis) && analysis.calls.length === 1
    && !analysis.calls[0]!.dynamic && !analysis.calls[0]!.redirects && MUTATORS.has(path.posix.basename(analysis.calls[0]!.name))
    && /^(?:(?:\/usr)?\/bin\/)?[^/]+$/u.test(analysis.calls[0]!.name);
  const fallback: ImpactSignal = readOnly || knownMutation ? 'not-detected' : 'unknown';
  return { version: 1, mutation: readOnly ? 'none' : 'possible',
    sensitiveRead: hasSensitiveCommandRead(analysis, operation.scope.cwd) ? 'detected' : fallback,
    externalTransfer: analysis.calls.some((call) => commandTransfer(call).sendsData) ? 'detected' : fallback,
    codeExecution: !readOnly && analysis.calls.some((call) => CODE.has(path.posix.basename(call.name))
      || PROJECT_CODE_COMMANDS.has(path.posix.basename(call.name))) ? 'detected' : fallback,
    evidence: readOnly ? 'query-proof' : knownMutation ? 'known-mutation' : 'unproven',
    uncertaintyCodes: knownMutation ? [] : query.reviewReasons ?? (readOnly ? [] : ['unrecognized-operation']) };
}
