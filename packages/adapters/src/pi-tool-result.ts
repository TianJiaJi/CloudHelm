import { Type } from 'typebox';
import type { BusinessTool } from '@cloudhelm/core';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const businessOutputSchema = Type.Object({ version: Type.Literal(1), tool: Type.String(),
  isError: Type.Boolean(), data: Type.Unknown(), text: Type.String() }, { additionalProperties: false });

/** No inference from rendered text and no promotion of renderer-only details. */
export function structuredToolResult(name: string, result: Awaited<ReturnType<BusinessTool['execute']>>) {
  let nodes = 0;
  const ancestors = new Set<object>();
  const clone = (value: unknown, depth = 0): Json => {
    if (++nodes > 16384 || depth > 24) throw new Error('Structured tool result exceeds its structural bound');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || ancestors.has(value)
      || !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      throw new Error('Structured tool result must contain finite JSON data');
    ancestors.add(value);
    try {
      if (Array.isArray(value)) return value.map((item) => clone(item, depth + 1));
      const entries = Object.entries(value).filter(([, item]) => item !== undefined);
      return Object.fromEntries(entries.map(([key, item]) => [key, clone(item, depth + 1)]));
    } finally { ancestors.delete(value); }
  };
  const structuredContent = { version: 1, tool: name, isError: result.isError === true,
    data: result.structuredContent === undefined ? null : clone(result.structuredContent),
    text: result.content.map((part: { type: 'text'; text: string }) => part.text).join('\n') };
  if (Buffer.byteLength(JSON.stringify(structuredContent), 'utf8') > 128 * 1024)
    throw new Error('Structured tool result exceeds 128 KiB; inspect the original observation, never replay an operation for output');
  return { ...result, structuredContent };
}
