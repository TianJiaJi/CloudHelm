/** These arguments only list metadata on the current Docker daemon.
 * The caller must separately establish literal shell syntax, executable identity,
 * authorization and absence of redirection/expansion. This is not an approval.
 */
export function isDockerMetadataQuery(args: readonly string[]): boolean {
  if (args.length === 1 && args[0] === 'version') return true;
  const listing = args[0] === 'images' ? { kind: 'images', offset: 1 }
    : args[0] === 'image' && args[1] === 'ls' ? { kind: 'images', offset: 2 }
      : args[0] === 'ps' ? { kind: 'containers', offset: 1 }
        : args[0] === 'container' && args[1] === 'ls' ? { kind: 'containers', offset: 2 }
          : args[0] === 'network' && args[1] === 'ls' ? { kind: 'networks', offset: 2 } : undefined;
  if (!listing) return false;
  const flags = listing.kind === 'images' ? ['-a', '--all', '--digests', '--no-trunc', '-q', '--quiet']
    : listing.kind === 'containers' ? ['-a', '--all', '--no-trunc', '-q', '--quiet', '-s', '--size']
      : ['--no-trunc', '-q', '--quiet'];
  let formatted = false;
  for (let index = listing.offset; index < args.length; index++) {
    const arg = args[index]!;
    if (flags.includes(arg)) continue;
    if (formatted || (arg !== '--format' && !arg.startsWith('--format='))) return false;
    const format = arg === '--format' ? args[++index] : arg.slice('--format='.length);
    if (!format || !literalFieldFormat(format)) return false;
    formatted = true;
  }
  return true;
}

/** Field interpolation and literal labels/separators only, never template code.
 * A quoted pipe/colon/space is display text, not a shell operator. Shell safety
 * comes from the AST, not this formatter grammar.
 */
function literalFieldFormat(format: string): boolean {
  if (format.length > 4096 || !/\{\{\.[A-Za-z][A-Za-z0-9]*\}\}/u.test(format)) return false;
  const literals = format.replace(/\{\{\.[A-Za-z][A-Za-z0-9]*\}\}/gu, '').replace(/\\t/gu, '\t');
  return !/[{}\\\u0000-\u0008\u000a-\u001f\u007f]/u.test(literals);
}
