import type { CommandAnalysis } from '@cloudhelm/core';
import type { Node as SyntaxNode } from 'web-tree-sitter';

/** Only topology evidence. Permission is decided in core, never by this adapter.
 * No source splitting: quoted pipes, background jobs, lists, subshells, redirects,
 * stderr pipes and embedded programs must not impersonate a simple pipeline. */
export function literalPipeline(root: SyntaxNode): CommandAnalysis['literalPipeline'] {
  const nodes = root.children.filter((node) => node.type !== 'comment' && node.type !== '\n');
  if (nodes.length !== 1 || nodes[0]!.type !== 'pipeline') return undefined;
  const children = nodes[0]!.children;
  if (children.length < 3 || children.length > 11 || children.length % 2 !== 1
    || children.some((node, index) => node.type !== (index % 2 === 0 ? 'command' : '|'))) return undefined;
  return { stages: children.filter((_, index) => index % 2 === 0)
    .map((node) => ({ start: node.startIndex, end: node.endIndex })) };
}
