import { expect, it } from 'vitest';
import { BashAnalyzer } from '../../packages/adapters/src/bash-analyzer.js';
import { SUDO_SESSION_PROMPT, sudoMarkerPrompt, sudoPtyCommand, sudoSessionCommand, sudoTarget } from '../../packages/core/src/sudo-plan.js';

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
const rebuildSession = async (command: string): Promise<string | undefined> =>
  sudoSessionCommand(await analyzer.analyze(command));

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
  // Options after `--` belong to the target command: mkdir's -p is not a sudo
  // prompt override and must not disqualify the whole command.
  expect(await rebuild('sudo -- mkdir -p /root/test'))
    .toBe(`sudo -k -p '${prompt}' '--' 'mkdir' '-p' '/root/test'`);
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

it('keeps the session stdin prompt fixed, ASCII and free of line breaks', () => {
  expect(SUDO_SESSION_PROMPT).toBe('[sudo] CloudHelm password: ');
  expect(SUDO_SESSION_PROMPT).toMatch(/^[\x20-\x7e]+ $/u);
});

it('rebuilds one literal root sudo command for the session stdin channel with the fixed prompt', async () => {
  expect(await rebuildSession('sudo id')).toBe(`sudo -k -S -p '${SUDO_SESSION_PROMPT}' 'id'`);
  expect(await rebuildSession('sudo -k systemctl restart nginx'))
    .toBe(`sudo -S -p '${SUDO_SESSION_PROMPT}' '-k' 'systemctl' 'restart' 'nginx'`);
  expect(await rebuildSession('sudo cat "root only"')).toBe(`sudo -k -S -p '${SUDO_SESSION_PROMPT}' 'cat' 'root only'`);
  expect(await rebuildSession('sudo -- mkdir -p /root/test'))
    .toBe(`sudo -k -S -p '${SUDO_SESSION_PROMPT}' '--' 'mkdir' '-p' '/root/test'`);
});

it('refuses session forms that would defeat stdin injection or drop reviewed content', async () => {
  for (const command of ['sudo -p "x" id', 'sudo --prompt "x" id', 'sudo -A id', 'sudo --askpass id',
    'sudo -S id', 'sudo --stdin id', 'sudo -n id', 'sudo --non-interactive id',
    'sudo $TARGET', 'sudo id | cat', 'sudo id > /tmp/out', 'id -u', 'sudo id; sudo whoami',
    'sudo -u deploy id', 'sudo true', 'sudo -k true', 'sudo sudo id', 'sudo su']) {
    expect(await rebuildSession(command), command).toBeUndefined();
  }
});
