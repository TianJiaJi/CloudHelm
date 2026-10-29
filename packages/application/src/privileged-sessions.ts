import { randomUUID } from 'node:crypto';
import type { PrivilegeMethod } from '@cloudhelm/core';

export interface PrivilegedSession {
  id: string; taskId: string; hostId: string; mode: PrivilegeMethod;
  status: 'pending' | 'prepared' | 'ready' | 'closed'; controller: AbortController;
}

/** Backend-owned grants; no renderer or model can mint or revive a session. */
export class PrivilegedSessions {
  private readonly sessions = new Map<string, PrivilegedSession>();
  begin(taskId: string, hostId: string, mode: PrivilegeMethod): PrivilegedSession {
    if ([...this.sessions.values()].some((s) => s.taskId === taskId && s.status === 'pending')) throw new Error('Root session request already pending');
    if ([...this.sessions.values()].filter((s) => s.taskId === taskId).length >= 8) throw new Error('Too many privilege contexts; pause to release old contexts');
    const session: PrivilegedSession = { id: randomUUID(), taskId, hostId, mode, status: mode === 'sudo' ? 'prepared' : 'pending', controller: new AbortController() };
    this.sessions.set(session.id, session);
    return session;
  }
  get(id: string, taskId: string, hostId: string, pending = false): PrivilegedSession {
    const session = this.sessions.get(id);
    if (!session || session.taskId !== taskId || session.hostId !== hostId || session.controller.signal.aborted
      || (!pending && session.status !== 'ready' && !(session.mode === 'sudo' && session.status === 'prepared')) || session.status === 'closed') throw new Error('Root session expired or outside task scope');
    return session;
  }
  activate(id: string, taskId: string, hostId: string): void {
    const session = this.get(id, taskId, hostId, true);
    if (session.mode === 'sudo') throw new Error('sudo contexts never become verified root logins');
    session.status = 'ready';
  }
  close(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.status = 'closed'; session.controller.abort(); this.sessions.delete(id);
  }
  closeTask(taskId: string): void {
    for (const session of this.sessions.values()) if (session.taskId === taskId) this.close(session.id);
  }
}
