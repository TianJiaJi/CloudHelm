import { expect, it } from 'vitest';
import { loadClarificationExtension } from './pi-clarification-extension.js';
it('loads a real Pi extension independently after each host restart and returns host answers', async () => {
  const calls: string[] = [];
  for (let restart = 0; restart < 2; restart++) {
    const loaded = await loadClarificationExtension({ ask: async (id) => { calls.push(id); return [{ id: 'scope', value: 'test', custom: true }]; } });
    expect(loaded.tools.map((tool) => tool.name)).toEqual(['ask_user']);
    expect(loaded.prompt).toContain('Investigate available context first');
    expect(loaded.prompt).toContain('SafetyGate');
    const result = await loaded.tools[0]!.execute(`tool-${restart}`, { questions: [{ id: 'scope', prompt: '环境？' }] });
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ questions: [{ id: 'scope', prompt: '环境？' }], answers: [{ id: 'scope', value: 'test', custom: true }] }) }]);
  }
  expect(calls).toEqual(['tool-0', 'tool-1']);
});
