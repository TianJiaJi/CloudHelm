import { describe, expect, it } from 'vitest';
import { agentPrompt } from './agent-prompt.js';
import { BashAnalyzer } from '@cloudhelm/adapters';
import { inputPlan } from './operation-input-plan.js';

describe('single action operating guidance', () => {
  it('includes grounded permissions and examples without requiring internal reasoning', () => {
    const prompt = agentPrompt([{ id: 'h', label: 'Linux', username: 'deploy', auth: 'password', secret: 'never-serialize',
      address: 'test', port: 22, status: 'connected', defaultMode: 'ask', protectedPaths: [], policyRevision: 1 }], [], 'extension');
    expect(prompt).toContain('"account":"deploy"'); expect(prompt).not.toContain('never-serialize');
    for (const text of ['ONE logical action', 'run_remote.cwd', 'Docker', 'nginx', 'sudo install -m 0600', 'request_root_session', 'verify first', 'Do not output thought tags']) expect(prompt).toContain(text);
    expect(prompt).not.toContain('lists joined by semicolons');
  });
  it.each(['sudo mkdir -p /opt/myapp', 'sudo install -m 0600 /tmp/staging /opt/myapp/.env', 'sudo stat /opt/myapp/.env', 'sudo docker ps'])(
    'keeps privileged examples inside the existing private auth capability: %s', async (command) => {
      expect(inputPlan(await new BashAnalyzer().analyze(command))?.auth).toBe('sudo');
    });
});
