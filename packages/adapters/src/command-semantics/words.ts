import type { Node as SyntaxNode } from 'web-tree-sitter';
import { shellWord } from '../shell-wrappers.js';

export function isDynamic(node: SyntaxNode): boolean {
  if (node.type === 'concatenation' && node.namedChildren.length === 2) {
    const [prefix, value] = node.namedChildren;
    if (prefix?.type === 'word' && prefix.text === '--format=' && value
      && ['string', 'raw_string'].includes(value.type) && !isDynamic(value)) return false;
  }
  if (/expansion|substitution|glob|concatenation|arithmetic/u.test(node.type)) return true;
  return node.namedChildren.some(isDynamic);
}

/** Decode quoting and only the existing trivial literal substitutions, never evaluate text. */
export function literalArgument(node: SyntaxNode): string {
  let source = node.text;
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const visit = (child: SyntaxNode) => {
    if (child.type === 'command_substitution') {
      const match = child.text.match(/^\$\(\s*(?:echo\s+|printf\s+(?:["']?%s["']?\s+)?)(["']?)([\w/.-]+)\1\s*\)$/u);
      if (match) replacements.push({ start: child.startIndex - node.startIndex, end: child.endIndex - node.startIndex, value: match[2]! });
      return;
    }
    for (const nested of child.namedChildren) visit(nested);
  };
  visit(node);
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    source = source.slice(0, replacement.start) + replacement.value + source.slice(replacement.end);
  }
  return shellWord(source);
}
