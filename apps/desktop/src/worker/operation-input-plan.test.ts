import { describe, expect, it } from 'vitest';
import { BashAnalyzer } from '@cloudhelm/adapters';
import { inputPlan, aptHasNoRemovals } from './operation-input-plan.js';

describe('ordinary command input planning', () => {
  it.each(["sudo ls -la /root/test; echo '--- content ---'; sudo cat /root/test/test",
    'sudo ls /root && sudo cat /root/test', 'id; sudo id', 'sudo false || sudo id'])('accepts sudo lists: %s', async (command) => {
    expect(inputPlan(await new BashAnalyzer().analyze(command))).toEqual({ auth: 'sudo', aptInstall: false });
  });
  it.each(['sudo od -c /root/test/test', 'sudo mkdir -p /root/test', 'sudo -u root -- cat /root/test',
    'sudo -n id', 'sudo -H --user root -- id'])('accepts %s without generating a replacement script', async (command) => {
    expect(inputPlan(await new BashAnalyzer().analyze(command))).toEqual({ auth: 'sudo', aptInstall: false });
  });
  it.each(['sudo sh -c "cat /root/test"', 'sudo cat /root/test | cat', 'sudo -S cat /root/test'])('refuses opaque authentication %s', async (command) => {
    expect(inputPlan(await new BashAnalyzer().analyze(command))).toBeUndefined();
  });
  it('only confirms the latest bounded apt install summary', () => {
    expect(aptHasNoRemovals('0 upgraded, 1 newly installed, 0 to remove and 0 not upgraded.\n')).toBe(true);
    expect(aptHasNoRemovals('0 upgraded, 1 newly installed, 0 to remove and 0 not upgraded.\n0 upgraded, 1 newly installed, 1 to remove and 0 not upgraded.\n')).toBe(false);
  });
});
