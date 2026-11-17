import type { CommandAnalysis, OperationResult } from './model.js';
import type { ExecutionOptions } from './ports.js';
import { isSudo, sudoTarget } from './sudo-plan.js';

/** Positive run-readiness evidence for one tracked tool. Presence never implies this. */
export interface ToolReadinessFact {
  tool: string;
  /** Only positive evidence is recorded; absence of a fact stays unknown, never false. */
  state: 'responsive';
  /** Identity the successful invocation actually ran as (login user, or root via sudo). */
  observedAs: string;
  observedAt: number;
  /** Concrete evidence class, never inferred from presence or model claims. */
  evidence: 'exit-0';
}

/** Deliberately tiny: each entry is one operable service with a distinct failure mode. */
export const TRACKED_READINESS_TOOLS: readonly string[] = ['docker', 'systemctl'];

/** Facts one executed command contributes; empty values mean "no information". */
export interface CommandEnvironmentFacts {
  /** Exit-0 evidence for tracked tools this single invocation actually exercised. */
  readiness: ToolReadinessFact[];
  /** Tracked tools this command may have changed; their readiness facts drop first. */
  staleReadiness: string[];
  /** Any dispatched mutation can change binary presence; the next refresh re-probes it. */
  presenceStale: boolean;
}

function isTracked(name: string): boolean {
  return TRACKED_READINESS_TOOLS.includes(name);
}

/** Bare invocation name only, or one resolved sudo layer: evidence binds to the
 * exact command, never to a PATH guess or a flattened pipeline stage. */
function backfillableTool(analysis: CommandAnalysis, invokedAs: string): { tool: string; observedAs: string } | undefined {
  if (analysis.hasError || analysis.hasPipeline || analysis.hasExpansion) return;
  const step = analysis.steps?.length === 1 ? analysis.steps[0] : undefined;
  if (!step || step.condition !== 'always' || step.call.dynamic) return;
  if (isTracked(step.call.name)) return { tool: step.call.name, observedAs: invokedAs };
  if (isSudo(step.call)) {
    const target = sudoTarget(step.call);
    if (target && isTracked(target.name)) return { tool: target.name, observedAs: target.runAs };
  }
}

/** Pure extraction: never probes, never records negative readiness (unknown stays unknown).
 * Invalidation precedes backfill so `systemctl stop docker` yields a fresh systemctl fact
 * while dropping the docker fact it just falsified. */
export function commandEnvironmentFacts(analysis: CommandAnalysis, result: OperationResult,
  options: Pick<ExecutionOptions, 'readOnly'> | undefined, invokedAs: string, now: number): CommandEnvironmentFacts {
  // Failures that provably never reached the host change nothing on it.
  const dispatched = !(result.effects === 'none'
    && (result.failureKind === 'not-dispatched' || result.failureKind === 'unresolved-prior-operation'));
  const mentioned = new Set<string>();
  for (const call of analysis.calls) {
    for (const tool of TRACKED_READINESS_TOOLS) {
      if (call.name === tool || call.name.endsWith(`/${tool}`)
        || call.args.some((arg) => {
          // Argument basenames only: `docker`, `/usr/bin/docker`, `docker.io`, `docker.sock`.
          const base = arg.slice(arg.lastIndexOf('/') + 1);
          return base === tool || base.startsWith(`${tool}.`);
        })) mentioned.add(tool);
    }
  }
  const mutating = options?.readOnly !== true && dispatched;
  const backfill = result.status === 'succeeded' && result.exitCode === 0
    ? backfillableTool(analysis, invokedAs) : undefined;
  return {
    readiness: backfill ? [{ tool: backfill.tool, state: 'responsive', observedAs: backfill.observedAs,
      observedAt: now, evidence: 'exit-0' }] : [],
    staleReadiness: mutating ? [...mentioned] : [],
    presenceStale: mutating
  };
}
