import { expect, it } from 'vitest';
import { isEffectFreeQuery, isReadOnlyQuery, sudoContextCommand } from '@cloudhelm/core';
import { BashAnalyzer } from '../../packages/adapters/src/bash-analyzer.js';
const parser = new BashAnalyzer();
it.each(['id -u', 'cat /root/demo', 'stat /root/demo', 'docker images --format "{{.Repository}}:{{.Tag}}"',
  'systemctl show --no-pager --property=Id,LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,InvocationID,Job,CanStart,NeedDaemonReload -- demo.service'])('normalizes a real literal query before review without minting automatic approval: %s', async (command) => {
  const prepared = sudoContextCommand(await parser.analyze(command));
  expect(prepared).toBe(`sudo -- ${command}`);
  const analysis = await parser.analyze(prepared);
  expect(sudoContextCommand(analysis)).toBe(prepared);
  expect(isEffectFreeQuery(analysis)).toBe(true); expect(isReadOnlyQuery(analysis)).toBe(false);
});
it('keeps privileged ping conservative rather than inheriting the bare diagnostic capability', async () => {
  const command = sudoContextCommand(await parser.analyze('ping -c 1 -W 2 192.0.2.1'));
  expect(isEffectFreeQuery(await parser.analyze(command))).toBe(false);
});
it.each(['id; whoami', 'sudo -u other id', 'sudo -n true', 'sudo -l', 'su root', 'echo "$HOME"',
  'sudo id | cat', 'id > /tmp/probe'])('rejects unsupported context forms before review: %s', async (command) => {
  const analysis = await parser.analyze(command);
  expect(() => sudoContextCommand(analysis)).toThrow();
});
it.each(['date 010112002027', 'date -s 2027-01-01', 'hostname changed-host', 'hostname -F /tmp/new-host'])('does not mistake privileged setters for queries: %s', async (command) => {
  expect(isEffectFreeQuery(await parser.analyze(command))).toBe(false);
  expect(isEffectFreeQuery(await parser.analyze(`sudo -- ${command}`))).toBe(false);
});
