import { expect, it } from 'vitest';
import { sudoTarget } from './sudo-plan.js';

it.each([
  [['-u', 'deploy', '--', 'id'], 'deploy'],
  [['-H', '-g', 'admin', 'id'], 'root'],
  [['printf', '--user', 'not-an-identity'], 'root']
])('derives effective identity from sudo options, never payload flags', (args, runAs) => {
  expect(sudoTarget({ name: 'sudo', args: args as string[], dynamic: false, redirects: false })?.runAs).toBe(runAs);
});
