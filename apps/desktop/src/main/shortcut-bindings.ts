const SHORTCUT_ACTION_LIMIT = 128;
const SHORTCUT_BINDING_PATTERN = /^[a-z0-9+]{0,40}$/u;

export function validBindings(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > SHORTCUT_ACTION_LIMIT) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!/^[a-z][a-z0-9.]{1,40}$/u.test(key) || typeof value !== 'string' || !SHORTCUT_BINDING_PATTERN.test(value)) continue;
    result[key] = value;
  }
  return result;
}
