import { randomUUID } from 'node:crypto';

/** One self-adjudication receipt minted by a gate 'adjudication-required' decision.
 * State transitions: pending → consumed (a verification passed and the operation
 * was dispatched on that confirmation) or pending → denied (a verification
 * failed; the binding can never authorize anything again). Terminal records are
 * kept until capacity eviction so a consumed or denied receipt cannot be
 * quietly re-minted and re-confirmed. */
export interface AdjudicationBinding {
  readonly id: string;
  /** Exact operation content/identity/policy fingerprint this receipt was minted for. */
  readonly fingerprint: string;
  readonly taskId: string;
  readonly hostId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  state: 'pending' | 'consumed' | 'denied';
}

const ADJUDICATION_TTL_MS = 10 * 60_000;
const ADJUDICATION_CAPACITY = 16;

/** Task-scoped store of self-adjudication bindings, shared by every gate a task
 * creates so a receipt minted through one tool call survives the next one. */
export class AdjudicationRegistry {
  private readonly bindings = new Map<string, AdjudicationBinding>();

  /** Idempotent mint: re-proposing the same pending fingerprint reuses its receipt. */
  pending(fingerprint: string, taskId: string, hostId: string, now = Date.now()): AdjudicationBinding {
    for (const binding of this.bindings.values())
      if (binding.state === 'pending' && binding.expiresAt <= now) this.bindings.delete(binding.id);
    const existing = [...this.bindings.values()].find((binding) => binding.state === 'pending' && binding.fingerprint === fingerprint);
    if (existing) return existing;
    if (this.bindings.size >= ADJUDICATION_CAPACITY) {
      // Terminal records are evicted first so a recent pending receipt always fits.
      const terminal = [...this.bindings.values()].find((binding) => binding.state !== 'pending');
      this.bindings.delete((terminal ?? [...this.bindings.values()][0])!.id);
    }
    const binding: AdjudicationBinding = { id: randomUUID(), fingerprint, taskId, hostId,
      createdAt: now, expiresAt: now + ADJUDICATION_TTL_MS, state: 'pending' };
    this.bindings.set(binding.id, binding);
    return binding;
  }

  find(id: string): AdjudicationBinding | undefined { return this.bindings.get(id); }

  consume(id: string): boolean {
    const binding = this.bindings.get(id);
    if (!binding || binding.state !== 'pending') return false;
    binding.state = 'consumed';
    return true;
  }

  deny(id: string): void {
    const binding = this.bindings.get(id);
    if (binding) binding.state = 'denied';
  }
}
