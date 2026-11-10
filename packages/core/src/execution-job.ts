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
export interface ExecutionJobSnapshot extends ExecutionJobBinding {
  version: 1;
  status: ExecutionJobStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  /** Last observed supervised process, not service readiness or an arbitrary kill target. */
  pid?: number;
  processSequence: number;
  exitObserved: boolean;
  exitCode?: number;
  endedAt?: number;
  notStarted?: 'denied' | 'expired' | 'unsupported' | 'cancelled';
  unknownReason?: ExecutionJobUnknownReason;
  stopRequestId?: string;
  stopRequestedAt?: number;
}
