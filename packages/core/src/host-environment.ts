import type { ToolReadinessFact } from './tool-readiness.js';

/** A time-scoped observation, never a privilege grant or permanent host truth. */
export interface HostEnvironmentData {
  os: string | null; distribution: string | null; version: string | null;
  /** Raw kernel architecture (uname -m). Userspace/distribution ABI is a separate
   * on-demand fact and is never inferred from this value. */
  architecture: string | null; kernel: string | null;
  /** Normalized family of `architecture` via a fixed alias table; unknown stays unknown. */
  architectureFamily: string | null;
  username: string | null; uid: number | null;
  /** Login shell start directory. Not the current operation cwd. */
  loginDirectory: string | null;
  /** Fixed PATH the presence facts were resolved against; identical to command execution. */
  path: string | null;
  /** Executable presence under `path` for the probed identity. Presence is not
   * run-readiness: docker present does not mean the daemon is usable. */
  toolPresence: Record<string, boolean>;
  /** Which bootstrap produced these facts. A shell fallback is real evidence,
   * not a guess: it simply observes fewer fields than the Python probe. */
  source: 'python' | 'shell';
}

const ARCHITECTURE_FAMILIES = new Map<string, string>([
  ['x86_64', 'x86_64'], ['amd64', 'x86_64'],
  ['aarch64', 'aarch64'], ['arm64', 'aarch64'],
  ['armv8l', 'arm32'], ['armv7l', 'arm32'], ['armv6l', 'arm32'], ['armv5tel', 'arm32'],
  ['armhf', 'arm32'], ['arm', 'arm32'],
  ['i386', 'x86'], ['i486', 'x86'], ['i586', 'x86'], ['i686', 'x86'], ['x86', 'x86'],
  ['riscv64', 'riscv64'], ['ppc64le', 'ppc64le'], ['s390x', 's390x'],
  ['loongarch64', 'loongarch64'], ['loong64', 'loongarch64'],
  ['mips64el', 'mips64el'], ['mipsel', 'mipsel'],
]);

/** Fixed alias table only. Unknown raw values map to null instead of being guessed. */
export function architectureFamilyOf(raw: string | null): string | null {
  return raw === null ? null : ARCHITECTURE_FAMILIES.get(raw) ?? null;
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
  /** Command-backfilled run-readiness for tracked tools; positive evidence only. */
  toolReadiness?: ToolReadinessFact[];
  /** A dispatched mutation invalidated the cached presence facts; next refresh re-probes. */
  presenceStale?: boolean;
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
