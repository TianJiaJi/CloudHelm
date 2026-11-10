import { expect, it } from 'vitest';
import { PiQueryPolicy, validateQueryStore } from '../../packages/adapters/src/pi-query-policy.js';
import type { SessionOptions, BusinessTool } from '@cloudhelm/core';
const tool = (name: string, extra: Partial<BusinessTool> = {}): BusinessTool => ({ name, label: name, description: name,
  replay: 'never', parameters: {}, execute: async () => ({ content: [], details: undefined }), ...extra });
it('uses explicit query capabilities and current authorization rather than names or hints', () => {
  let allowed = true;
  const policy = new PiQueryPolicy({ tools: [tool('run_remote'), tool('query', { access: 'query', deferred: true, available: () => allowed })] } as SessionOptions);
  expect(policy.queryAllowed('run_remote')).toBe(false); expect(policy.queryAllowed('query')).toBe(true);
  expect(policy.activeNames()).not.toContain('query'); expect(policy.activeNames(['query'])).toContain('query');
  allowed = false; expect(policy.activeNames(['query'])).not.toContain('query'); expect(policy.queryAllowed('query')).toBe(false);
});
it('fails closed on discovery errors and reserved/duplicate names', () => {
  const options = { tools: [tool('query', { access: 'query', available: () => { throw new Error('scope unavailable'); } })] } as SessionOptions;
  expect(new PiQueryPolicy(options).queryAllowed('query')).toBe(false);
  expect(() => new PiQueryPolicy({ ...options, tools: [tool('codemode')] })).toThrow();
  expect(() => new PiQueryPolicy({ ...options, tools: [tool('query'), tool('query')] })).toThrow();
});
it('permits only small owned-reference/cursor cache records, never arbitrary text or unknown identifiers', () => {
  const allowed = (id: string) => id === 'owned-operation';
  expect(() => validateQueryStore({ set: { page: { operationId: 'owned-operation', cursor: 0 } }, delete: ['cursor'] }, allowed)).not.toThrow();
  for (const set of [{ private: { cursor: 0 } }, { page: { operationId: 'foreign' } }, { page: { text: 'secret' } },
    { page: { cursor: -1 } }, { page: 'arbitrary body' }, { page: { operationId: 'x'.repeat(5000) } }])
    expect(() => validateQueryStore({ set, delete: [] }, allowed)).toThrow('bounded authorized references');
});
