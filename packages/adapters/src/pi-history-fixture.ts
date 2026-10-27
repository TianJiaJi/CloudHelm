import { SessionManager } from '@earendil-works/pi-coding-agent';

/** Test-only native transcript, never a migration or production history rewrite. */
export function seedNativeHistory(directory: string, id: string, singleLarge = false): void {
  const manager = SessionManager.create(directory, directory, { id });
  // Real CloudHelm sessions persist the native structured system entry before
  // their first user input. Omission is correctly refused by dynamic authority projection.
  manager.appendMessage({ role: 'system', content: '', sections: { preamble: 'Stale native CloudHelm fixture prompt' }, timestamp: 0 });
  manager.appendMessage({ role: 'user', content: 'Original inspect-only goal', timestamp: 1 });
  const assistant = (text: string) => ({ role: 'assistant' as const, content: [{ type: 'text' as const, text }],
    api: 'openai-completions' as const, provider: 'cloudhelm-custom', model: 'fixture', timestamp: 2, stopReason: 'stop' as const,
    usage: { input: 60000, output: 100, totalTokens: 60100, cacheRead: 0, cacheWrite: 0,
      cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } } });
  if (singleLarge) manager.appendMessage(assistant('Old bounded observation. '.repeat(10000)));
  else for (let i = 0; i < 30; i++) {
    manager.appendMessage({ role: 'user', content: `Old selection ${i}: ${'Bounded old evidence. '.repeat(200)}`, timestamp: 2 });
    manager.appendMessage(assistant('Old bounded observation.'));
  }
  manager.appendMessage({ role: 'user', content: 'Recent inspect-only input', timestamp: 3 });
  manager.appendMessage(assistant('Recent answer.'));
}
