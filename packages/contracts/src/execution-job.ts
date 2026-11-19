/** Immutable operation/recipient binding. A PID is observation, never a stop capability. */
export interface ExecutionJobRecipientView {
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
export type ExecutionJobStatusView = 'starting' | 'running' | 'stop-requested' | 'exited' | 'failed' | 'unknown';
export type ExecutionJobUnknownReasonView = 'disconnected' | 'transport-lost' | 'ownership-lost' | 'stop-delivery-unknown' | 'recovered';
export interface ExecutionJobView extends ExecutionJobRecipientView {
  version: 1;
  status: ExecutionJobStatusView;
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
  unknownReason?: ExecutionJobUnknownReasonView;
  stopRequestId?: string;
  stopRequestedAt?: number;
}
