import { isAgentLifecycleObservation, type AgentActivityView, type AgentLifecycleObservation, type RequestObservation, type ToolObservation } from '@cloudhelm/contracts';

/** Transient observations only; this store has no operation, approval, terminal or budget mutation ports. */
export class AgentActivityStore {
  private readonly tasks = new Map<string, AgentActivityView>();
  accept(taskId: string, raw: AgentLifecycleObservation): boolean {
    if (!isAgentLifecycleObservation(raw)) return false;
    const value = structuredClone(raw);
    const state: AgentActivityView = this.tasks.get(taskId) ?? { version: 1, tools: [], requests: [], omittedTools: 0, omittedRequests: 0 };
    if (value.kind === 'run') {
      const previous = state.run;
      if (value.status === 'running') {
        if (previous?.runId === value.runId || (previous && value.startedAt < previous.startedAt)) return false;
        for (const tool of state.tools) if (tool.status === 'running') tool.status = 'interrupted';
        state.run = value; state.runtimeLost = false;
      } else {
        if (!previous || previous.runId !== value.runId || previous.status !== 'running' || value.observedAt < previous.observedAt) return false;
        state.run = value;
        for (const tool of state.tools) if (tool.runId === value.runId && tool.status === 'running') tool.status = 'interrupted';
      }
    } else if (value.kind === 'tool') {
      if (state.runtimeLost || state.run?.runId !== value.runId || state.run.status !== 'running') return false;
      const previous = state.tools.find((tool) => tool.callId === value.callId);
      if (previous) {
        if (previous.status !== 'running' || value.observedAt < previous.observedAt || value.updates < previous.updates
          || !sameTool(previous, value)) return false;
        Object.assign(previous, value);
      } else {
        if (value.status !== 'running' || (value.parentCallId && !state.tools.some((tool) => tool.callId === value.parentCallId && tool.runId === value.runId))) return false;
        if (state.tools.length >= 256) {
          const index = state.tools.findIndex((tool) => tool.status !== 'running');
          if (index < 0) return false;
          state.tools.splice(index, 1); state.omittedTools++;
        }
        state.tools.push(value);
      }
    } else {
      const previous = state.requests.find((request) => request.logicalRequestId === value.logicalRequestId && request.attempt === value.attempt);
      if (previous) {
        if (previous.status !== 'running' || value.observedAt < previous.observedAt || !sameRequest(previous, value)) return false;
        Object.assign(previous, value);
      } else {
        if (value.status !== 'running') return false;
        if (state.requests.length >= 64) {
          const index = state.requests.findIndex((request) => request.status !== 'running');
          if (index < 0) return false;
          state.requests.splice(index, 1); state.omittedRequests++;
        }
        state.requests.push(value);
      }
    }
    this.tasks.set(taskId, state); return true;
  }
  runtimeStopped(): void {
    for (const state of this.tasks.values()) {
      state.runtimeLost = true;
      for (const tool of state.tools) if (tool.status === 'running') tool.status = 'interrupted';
      for (const request of state.requests) if (request.status === 'running') {
        request.status = 'unknown'; request.cost = { source: 'unknown', usd: null };
      }
    }
  }
  remove(taskId: string): void { this.tasks.delete(taskId); }
  snapshot(): Record<string, AgentActivityView> { return Object.fromEntries([...this.tasks].map(([id, state]) => [id, structuredClone(state)])); }
}
function sameTool(a: ToolObservation, b: ToolObservation): boolean {
  return a.runId === b.runId && a.nativeId === b.nativeId && a.name === b.name && a.startedAt === b.startedAt
    && a.parentCallId === b.parentCallId && a.parentToolCallId === b.parentToolCallId;
}
function sameRequest(a: RequestObservation, b: RequestObservation): boolean {
  return a.provider === b.provider && a.modelId === b.modelId && a.purpose === b.purpose && a.startedAt === b.startedAt;
}
