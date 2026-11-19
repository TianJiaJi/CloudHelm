import { expect, it } from 'vitest';
import { BashAnalyzer } from '../../packages/adapters/src/bash-analyzer.js';
import { isSu, suPtyCommand } from '../../packages/core/src/su-plan.js';

const analyzer = new BashAnalyzer();

it('recognizes only su itself, never sudo or other tools', async () => {
  for (const command of ['su', '/bin/su', '/usr/bin/su']) {
    const analysis = await analyzer.analyze(`${command} root -c 'id'`);
    expect(isSu(analysis.steps![0]!.call), command).toBe(true);
  }
  for (const command of ['sudo id', 'sudo su', 'doas sh', 'sum 1 2']) {
    const analysis = await analyzer.analyze(command);
    expect(isSu(analysis.steps![0]!.call), command).toBe(false);
  }
});

it('wraps one literal reviewed action with the working directory inside the -c body', async () => {
  const wrapped = suPtyCommand(await analyzer.analyze('systemctl restart nginx'), '/srv/app');
  expect(wrapped).toBe(`su -l -s /bin/sh root -c 'cd '\\''/srv/app'\\'' || exit 125\nsystemctl restart nginx'`);
  // A quoted directory and embedded business quotes survive the single rebuild.
  const quoted = suPtyCommand(await analyzer.analyze(`echo 'a b'`), "/opt/it's");
  expect(quoted).toBe(`su -l -s /bin/sh root -c 'cd '\\''/opt/it'\\''\\'\\'''\\''s'\\'' || exit 125\necho '\\''a b'\\'''`);
});

it('refuses anything that is not one literal foreground action or a usable directory', async () => {
  for (const command of ['id -u | cat', 'id; whoami', 'id && whoami', 'echo $HOME', 'id > /tmp/out',
    'true', '/bin/true', 'sudo id', 'su root', 'id $(date)', 'cd /srv && systemctl restart nginx']) {
    expect(suPtyCommand(await analyzer.analyze(command), '/'), command).toBeUndefined();
  }
  const analysis = await analyzer.analyze('id -u');
  expect(suPtyCommand(analysis, 'srv/relative')).toBeUndefined();
  expect(suPtyCommand(analysis, '/srv/\u0001')).toBeUndefined();
  expect(suPtyCommand(analysis, `/${'a'.repeat(4096)}`)).toBeUndefined();
  // Valid pieces but a wrapped size beyond the transport's dispatch bound.
  const long = await analyzer.analyze(`echo '${'b'.repeat(5000)}'`);
  expect(suPtyCommand(long, `/${'a'.repeat(3000)}`)).toBeUndefined();
});
