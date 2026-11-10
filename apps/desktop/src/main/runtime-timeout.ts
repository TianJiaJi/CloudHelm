import type { RuntimeCall, RuntimeHost } from '@cloudhelm/contracts/runtime';

function connectionBudget(host: RuntimeHost): number {
  const value = host.connection?.timeoutMs;
  const configured = value !== undefined && Number.isInteger(value) && value >= 1000 && value <= 300000 ? value : undefined;
  return (configured ?? 150000) + (host.connection?.proxy?.enabled ? configured ?? 20000 : 0);
}

/** Outer RPC deadlines must contain the actual SSH/user-interaction deadlines.
 * This does not retry work or change any test timeout. SSH and private-input
 * handlers still enforce their own shorter, independently bounded deadlines. */
export function runtimeCallTimeout(call: RuntimeCall): number {
  if (call.method === 'prepare-message' || call.method === 'request-ai-denial-review') return 650000;
  if (call.method === 'connect') return Math.max(180000, 30000 + connectionBudget(call.host)
    + (call.jump && !call.host.connection?.proxy?.enabled ? connectionBudget(call.jump) : 0));
  if (call.method === 'open-terminal') return 180000; // 120s consent + bounded channel startup, never a command retry.
  if (call.method === 'test-host') return 60000;
  return 30000;
}
