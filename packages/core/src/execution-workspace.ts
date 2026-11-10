/** An execution location belongs to one task/login/connection, not a model turn. */
export interface ExecutionTerminalBinding {
  hostId: string;
  loginAs: string;
  connectionId: string;
}
export interface ExecutionTerminalView extends ExecutionTerminalBinding {
  terminalId: string;
  taskId: string;
  generation: number;
  owner: 'agent' | 'human' | 'suspended' | 'closed';
  busy: boolean;
}
