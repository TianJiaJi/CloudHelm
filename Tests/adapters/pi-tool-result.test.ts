import { expect, it, vi } from 'vitest';
import { Type } from 'typebox';
import { structuredToolResult } from '../../packages/adapters/src/pi-tool-result.js';
import { toPiTool } from '../../packages/adapters/src/pi-tool-validation.js';
const result = { content: [{ type: 'text' as const, text: 'public observation' }], details: { private: 'renderer-only' } };
it('never promotes private details or interprets rendered text as structured authority', () => {
  const value = structuredToolResult('query', result);
  expect(value.structuredContent).toEqual({ version: 1, tool: 'query', isError: false, data: null, text: 'public observation' });
  expect(JSON.stringify(value.structuredContent)).not.toContain('renderer-only');
});
it('preserves unknown states, zero exit codes and explicit error status in detached JSON data', () => {
  const data = { operationId: 'op', terminalId: null, exitCode: 0, state: 'unknown', cursor: 0 };
  const value = structuredToolResult('query', { ...result, isError: true, structuredContent: data });
  data.state = 'changed';
  expect(value.structuredContent).toMatchObject({ isError: true, data: { state: 'unknown', exitCode: 0, terminalId: null, cursor: 0 } });
});
it.each([NaN, Infinity, 1n, () => {}, new Date(), { text: 'x'.repeat(128 * 1024) }])('rejects non-JSON or oversized data', (data) => {
  expect(() => structuredToolResult('query', { ...result, structuredContent: data })).toThrow();
});
it('defaults to model-only and rechecks availability before invoking the business tool', async () => {
  const execute = vi.fn(async () => result), base = { name: 'tool', label: 'Tool', description: 'Test', replay: 'never' as const,
    parameters: Type.Object({}, { additionalProperties: false }), execute };
  expect(toPiTool(base).exposure).toBe('model-only');
  const tool = toPiTool({ ...base, access: 'query', deferred: true, available: () => false });
  expect(tool.exposure).toBe('deferred');
  await expect(tool.execute('call', {}, undefined, undefined, {} as never)).rejects.toThrow('authorization');
  expect(execute).not.toHaveBeenCalled();
});
