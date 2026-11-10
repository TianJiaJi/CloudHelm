import type { HostEnvironmentAccess, HostEnvironmentObservation, HostEnvironmentReader } from '@cloudhelm/core';

/** Only an explicit connected-host read may refresh. Snapshots and recovery are offline. */
export class HostEnvironmentRegistry implements HostEnvironmentAccess {
  private readonly records = new Map<string, HostEnvironmentObservation>();
  private readonly inFlight = new Map<string, Promise<HostEnvironmentObservation>>();
  constructor(private readonly reader: HostEnvironmentReader, private readonly now = Date.now) {}

  snapshot(hostId: string, loginAs: string): HostEnvironmentObservation {
    const connectionId = this.reader.connectionId(hostId), record = this.records.get(hostId);
    if (connectionId && record?.connectionId === connectionId && record.loginAs === loginAs) return structuredClone(record);
    return { version: 1, hostId, loginAs, connectionId, observedAt: null, status: 'unknown', reason: 'not-observed' };
  }

  async refresh(hostId: string, loginAs: string, signal?: AbortSignal): Promise<HostEnvironmentObservation> {
    signal?.throwIfAborted();
    const connectionId = this.reader.connectionId(hostId);
    if (!connectionId) return this.snapshot(hostId, loginAs);
    const cached = this.snapshot(hostId, loginAs);
    if (cached.observedAt !== null && this.now() - cached.observedAt >= 0 && this.now() - cached.observedAt < 5000) return cached;
    const key = JSON.stringify([hostId, loginAs, connectionId]);
    let pending = this.inFlight.get(key);
    if (!pending) {
      const binding = { version: 1 as const, hostId, loginAs, connectionId };
      pending = (async (): Promise<HostEnvironmentObservation> => {
        let result: HostEnvironmentObservation;
        try {
          const data = await this.reader.read(hostId, loginAs, signal);
          signal?.throwIfAborted();
          result = { ...binding, observedAt: this.now(), status: 'observed', data };
        } catch {
          // Never publish raw server stderr/errors (they may contain private output).
          result = { ...binding, observedAt: this.now(), status: 'unknown', reason: 'unavailable' };
        }
        if (this.reader.connectionId(hostId) !== connectionId)
          return { ...binding, observedAt: null, status: 'unknown', reason: 'connection-changed' };
        if (!signal?.aborted) this.records.set(hostId, result);
        return result;
      })();
      this.inFlight.set(key, pending);
      void pending.finally(() => { if (this.inFlight.get(key) === pending) this.inFlight.delete(key); });
    }
    const result = await pending;
    signal?.throwIfAborted();
    return structuredClone(result);
  }
}
