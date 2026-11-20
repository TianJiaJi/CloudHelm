import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { BusinessTool } from '@cloudhelm/core';
import { businessOutputSchema, structuredToolResult } from './pi-tool-result.js';

const originalCalls = new AsyncLocalStorage<{ name: string; args: unknown }>();
/** Preserve script arguments before the SDK's nested-call coercion pipeline. */
export function withOriginalToolInput<T>(name: string, args: unknown, run: () => Promise<T>): Promise<T> {
  return originalCalls.run({ name, args: structuredClone(args) }, run);
}

const jsonTypes = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

/** Value.Check accepts unknown type keywords as unconstrained schemas. Reject
 * those, including nested schemas, rather than treating a malformed contract as allow-all. */
function supportedSchemaTypes(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (typeof value === 'boolean') return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const schema = value as Record<string, unknown>;
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.length || types.some((type) => typeof type !== 'string' || !jsonTypes.has(type))) return false;
  }
  const check = (item: unknown) => supportedSchemaTypes(item, depth + 1);
  for (const key of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']) {
    const map = schema[key];
    if (map !== undefined && (!map || typeof map !== 'object' || Array.isArray(map) || !Object.values(map).every(check))) return false;
  }
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    const list = schema[key];
    if (list !== undefined && (!Array.isArray(list) || !list.every(check))) return false;
  }
  for (const key of ['items', 'additionalProperties', 'additionalItems', 'contains', 'not', 'if', 'then', 'else', 'propertyNames', 'unevaluatedProperties', 'unevaluatedItems']) {
    const child = schema[key];
    if (child !== undefined && !(key === 'items' && Array.isArray(child) ? child.every(check) : check(child))) return false;
  }
  return true;
}

/** Received JSON type at a validation pointer; never the raw value, so
 * credentials in rejected arguments cannot leak into the model context. */
function receivedType(input: unknown, pointer: string): string {
  let current: unknown = input;
  if (pointer.startsWith('/')) {
    for (const token of pointer.slice(1).split('/')) {
      const key = token.replace(/~1/gu, '/').replace(/~0/gu, '~');
      current = current !== null && typeof current === 'object' && !Array.isArray(current)
        ? (current as Record<string, unknown>)[key] : undefined;
    }
  }
  return Array.isArray(current) ? 'array' : current === null ? 'null' : typeof current;
}

/** SDK 1.5 coerces JSON tool input. Business arguments must instead be valid as
 * submitted, including TypeBox refinements, before any review or dispatch. */
export function assertStrictToolArguments(schema: object, input: unknown): void {
  let valid = false;
  let issues: Array<{ path: string; constraint: string; received: string }> = [];
  try {
    const typed = schema as TSchema;
    valid = supportedSchemaTypes(typed) && Value.Check(typed, input);
    if (!valid) {
      // Field-level failure items only: pointer, failed constraint, received
      // type — at most three, never echoing submitted values.
      issues = Value.Errors(typed, input).slice(0, 3).map((error) => ({
        path: error.instancePath === '' ? '(root)' : error.instancePath,
        constraint: error.keyword, received: receivedType(input, error.instancePath)
      }));
    }
  } catch { /* Unknown schemas fail closed. */ }
  if (!valid) throw new Error(`工具参数不符合原始类型或约束，未执行；请提供正确类型，不依赖隐式转换。${issues.length ? `失败项：${JSON.stringify(issues)}` : ''}`);
}

export function assertUnchangedToolArguments(schema: object, original: unknown, prepared: unknown): void {
  assertStrictToolArguments(schema, original);
  assertStrictToolArguments(schema, prepared);
  if (!isDeepStrictEqual(original, prepared)) throw new Error('工具参数在准备过程中发生变化，未执行；请显式提供完整参数。');
}

/** Recheck at execute as well: extension hooks can mutate inputs after SDK validation. */
export function toPiTool(tool: BusinessTool): ToolDefinition {
  const { access, deferred, available, ...definition } = tool;
  return { ...definition, exposure: access === 'query' ? deferred ? 'deferred' : 'direct' : 'model-only',
    executionMode: access === 'query' ? undefined : 'sequential',
    outputSchema: businessOutputSchema, execute: async (id, input, signal) => {
    signal?.throwIfAborted();
    if (available?.() === false) throw new Error('Tool is outside the current authorization');
    assertStrictToolArguments(tool.parameters, input);
    const original = originalCalls.getStore();
    if (original) {
      if (original.name !== tool.name) throw new Error('Nested tool recipient changed');
      assertUnchangedToolArguments(tool.parameters, original.args, input);
    }
    // BusinessTool erases its generic in a heterogeneous list; the original
    // schema above is the runtime type boundary, not an unchecked SDK cast.
    return structuredToolResult(tool.name, await tool.execute(id, input as never, signal));
  } };
}
