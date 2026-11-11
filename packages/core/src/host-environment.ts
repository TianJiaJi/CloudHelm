/** A time-scoped observation, never a privilege grant or permanent host truth. */
export interface HostEnvironmentData {
  os: string | null; distribution: string | null; version: string | null;
  architecture: string | null; kernel: string | null;
  username: string | null; uid: number | null; directory: string | null;
  tools: Record<string, boolean>;
  /** Which bootstrap produced these facts. A shell fallback is real evidence,
   * not a guess: it simply observes fewer fields than the Python probe. */
  source: 'python' | 'shell';
}

/** Why basic facts are unavailable. Distinct causes produce distinct decisions;
 * a single "unavailable" hides whether to retry, degrade, or never retry. */
export type HostProbeFailure =
  | 'python-missing' | 'timeout' | 'unsupported' | 'unavailable' | 'invalid' | 'too-large' | 'cancelled';

export interface HostEnvironmentObservation {
  version: 1; hostId: string; loginAs: string; connectionId: string | null;
  observedAt: number | null; status: 'observed' | 'unknown';
  reason?: 'not-observed' | 'unavailable' | 'connection-changed' | HostProbeFailure;
  /** Three independent facts: the SSH session, the metadata probe, the exec channel. */
  readiness: {
    ssh: 'connected' | 'disconnected';
    metadata: 'ready' | 'degraded' | 'unknown';
    /** Evidence that one command channel actually opened and completed. */
    execution: 'ready' | 'unknown';
  };
  data?: HostEnvironmentData;
}
export interface HostEnvironmentReader {
  /** Includes a worker-instance nonce: reconnects and process restarts never alias. */
  connectionId(hostId: string): string | null;
  read(hostId: string, loginAs: string, signal?: AbortSignal): Promise<HostEnvironmentData>;
}
export interface HostEnvironmentAccess {
  /** Pure local projection. Must never connect, probe or reserve a model request. */
  snapshot(hostId: string, loginAs: string): HostEnvironmentObservation;
  refresh(hostId: string, loginAs: string, signal?: AbortSignal): Promise<HostEnvironmentObservation>;
}
export const HOST_ENVIRONMENT_MAX_AGE_MS = 5 * 60_000;
