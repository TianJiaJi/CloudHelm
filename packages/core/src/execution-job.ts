/** Immutable operation/recipient binding. A PID is observation, never a stop capability. */
export interface ExecutionJobBinding {
  jobId: string;
  operationId: string;
  taskId: string;
  hostId: string;
  terminalId: string;
  terminalGeneration: number;
  connectionId: string;
  loginAs: string;
  runAs: string;
}
export type ExecutionJobStatus = 'starting' | 'running' | 'stop-requested' | 'exited' | 'failed' | 'unknown';
export type ExecutionJobUnknownReason = 'disconnected' | 'transport-lost' | 'ownership-lost' | 'stop-delivery-unknown' | 'recovered';
/** Backend-rendered private background log path; its shape is fixed so neither
 * the model nor the transport can substitute an arbitrary stop/read target. */
export const BACKGROUND_LOG_PATH_PATTERN = /^\/tmp\/\.cloudhelm-bg-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.log$/u;
export function validBackgroundLogPath(value: string): boolean {
  return value.length <= 128 && BACKGROUND_LOG_PATH_PATTERN.test(value);
}

export interface ExecutionJobSnapshot extends ExecutionJobBinding {
  version: 1;
  status: ExecutionJobStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  /** Last observed supervised process, not service readiness or an arbitrary kill target. */
  pid?: number;
  /** Private 0600 log of the native-background launch; observation target only. */
  logPath?: string;
  /** /proc/<pid>/stat starttime bound to the observed PID against reuse. */
  processStartTime?: number;
  processSequence: number;
  exitObserved: boolean;
  exitCode?: number;
  endedAt?: number;
  notStarted?: 'denied' | 'expired' | 'unsupported' | 'cancelled';
  unknownReason?: ExecutionJobUnknownReason;
  stopRequestId?: string;
  stopRequestedAt?: number;
}
