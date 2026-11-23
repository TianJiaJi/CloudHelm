/** Named observation budgets for host access. Bounded observation is a safety
 * property: every wait has a limit, no liveness is fabricated from silence, and
 * an expired window releases the caller with unknown while late transport facts
 * stay recorded. */
export const OBSERVATION_LIMITS = {
  /** Startup window from tool-call start to business dispatch. */
  startupWindowMs: 180_000,
  /** Bounded foreground run observation: waiting for a dispatched command's
   * exit ends here with unknown, never with a fabricated result. The command
   * itself keeps running and a late exit observation stays authoritative. */
  runWindowMs: 180_000,
  /** SSH channel allocation budget per native exec/PTY request. */
  channelAllocationMs: 15_000,
  /** Combined raw stdout+stderr cap for one native exec channel. */
  execOutputLimitBytes: 1_048_576,
  /** Backend parsing buffer for one background probe command. */
  backgroundProbeBytes: 65_536
} as const;
