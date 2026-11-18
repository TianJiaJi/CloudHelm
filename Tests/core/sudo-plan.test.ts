import { expect, it } from 'vitest';
import { BashAnalyzer } from '../../packages/adapters/src/bash-analyzer.js';
import { sudoMarkerPrompt, sudoPtyCommand, sudoTarget } from '../../packages/core/src/sudo-plan.js';

it.each([
  [['-u', 'deploy', '--', 'id'], 'deploy'],
  [['-H', '-g', 'admin', 'id'], 'root'],
  [['printf', '--user', 'not-an-identity'], 'root']
])('derives effective identity from sudo options, never payload flags', (args, runAs) => {
  expect(sudoTarget({ name: 'sudo', args: args as string[], dynamic: false, redirects: false })?.runAs).toBe(runAs);
});

const NONCE = '0123456789abcdef0123456789abcdef';
const analyzer = new BashAnalyzer();
const rebuild = async (command: string): Promise<string | undefined> =>
  sudoPtyCommand(await analyzer.analyze(command), sudoMarkerPrompt(NONCE));

it('pins the client-owned marker prompt to an unguessable per-dispatch nonce', () => {
  expect(sudoMarkerPrompt(NONCE)).toBe(`\rcloudhelm:${NONCE} password: `);
  expect(() => sudoMarkerPrompt(''), 'empty').toThrow('Invalid sudo marker nonce');
  expect(() => sudoMarkerPrompt(NONCE.toUpperCase()), 'uppercase').toThrow('Invalid sudo marker nonce');
  expect(() => sudoMarkerPrompt(NONCE.slice(0, 31)), 'short').toThrow('Invalid sudo marker nonce');
  expect(() => sudoMarkerPrompt(`${NONCE}\n`), 'newline').toThrow('Invalid sudo marker nonce');
  expect(() => sudoMarkerPrompt('X'.repeat(32)), 'non-hex').toThrow('Invalid sudo marker nonce');
});

it('rebuilds one literal sudo command with the marker prompt and a forced timestamp reset', async () => {
  const prompt = sudoMarkerPrompt(NONCE);
  expect(await rebuild('sudo id')).toBe(`sudo -k -p '${prompt}' 'id'`);
  expect(await rebuild('sudo -u deploy id')).toBe(`sudo -k -p '${prompt}' '-u' 'deploy' 'id'`);
  expect(await rebuild('sudo -k systemctl restart nginx')).toBe(`sudo -p '${prompt}' '-k' 'systemctl' 'restart' 'nginx'`);
});

it('refuses forms that would override the marker, move the password, or drop reviewed content', async () => {
  for (const command of ['sudo -p "x" id', 'sudo --prompt "x" id', 'sudo -A id', 'sudo --askpass id',
    'sudo $TARGET', 'sudo id | cat', 'sudo id > /tmp/out', 'id -u', 'sudo id; sudo whoami']) {
    expect(await rebuild(command), command).toBeUndefined();
  }
  const analysis = await analyzer.analyze('sudo id');
  expect(sudoPtyCommand(analysis, `${sudoMarkerPrompt(NONCE)}\n`), 'newline in marker').toBeUndefined();
  expect(sudoPtyCommand(analysis, 'x'.repeat(129)), 'marker too long').toBeUndefined();
});
