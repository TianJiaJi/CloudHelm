import path from 'node:path';
import { changeCommandDirectory, type CommandAnalysis, type CommandCall, type CommandContext } from '@cloudhelm/core';
import type { Node as SyntaxNode, Parser } from 'web-tree-sitter';
import { embeddedShell, findCommands, wrappedCommand } from '../shell-wrappers.js';
import { gitSemantics } from './git.js';
import { tarSemantics } from './tar.js';
import { embeddedContext, entryContext, unknownContext } from './wrappers.js';
import { isDynamic, literalArgument } from './words.js';

const MAX_NESTING = 4;
const CONTROL = new Set(['if_statement', 'elif_clause', 'else_clause', 'while_statement', 'for_statement',
  'c_style_for_statement', 'case_statement', 'case_item', 'function_definition', 'negated_command']);
const LOCAL = new Set(['subshell', 'command_substitution', 'process_substitution']);

function afterBuiltin(call: CommandCall, context: CommandContext): CommandContext {
  if (['cd', 'pushd'].includes(call.name)) {
    const args = call.args[0] === '--' ? call.args.slice(1) : call.args;
    return args.length === 1 && !args[0]!.startsWith('-') && !call.dynamic
      ? { ...context, cwd: changeCommandDirectory(context.cwd, args[0]!) }
      : unknownContext(context, 'Shell directory change cannot be resolved');
  }
  if (['popd', 'source', '.', 'eval', 'export', 'unset', 'alias', 'unalias', 'set', 'read'].includes(call.name)) {
    return unknownContext(context, 'Shell state may change outside the bounded context model');
  }
  return context;
}

/** Context traversal is separate from execution steps: never execute, flatten or rewrite a branch. */
export function collectCommands(node: SyntaxNode, analysis: CommandAnalysis, depth: number, parser: Parser,
  context: CommandContext = entryContext()): CommandContext {
  if (depth > MAX_NESTING) { analysis.hasError = true; return context; }
  const walk = (child: SyntaxNode, next = context) => collectCommands(child, analysis, depth, parser, next);
  if (/expansion|substitution|glob|arithmetic/u.test(node.type)) analysis.hasExpansion = true;
  if (node.type === 'pipeline') analysis.hasPipeline = true;
  if (['redirected_statement', 'file_redirect', 'herestring_redirect', 'heredoc_redirect'].includes(node.type)) analysis.hasRedirection = true;
  if (node.type === 'file_redirect') {
    const destination = node.childForFieldName('destination');
    if (destination && !/^\d*</u.test(node.text.trimStart())) {
      const target = literalArgument(destination);
      analysis.redirectTargets.push(target);
      analysis.redirectEffects!.push({ target, context });
    }
  }
  if (node.type === 'command') {
    const nameNode = node.childForFieldName('name');
    const call: CommandCall = { name: nameNode ? literalArgument(nameNode) : '',
      args: node.children.flatMap((child, index) => node.fieldNameForChild(index) === 'argument' ? [literalArgument(child)] : []),
      dynamic: !nameNode || isDynamic(nameNode) || node.namedChildren.some((child) => child.type === 'variable_assignment' || isDynamic(child)),
      redirects: node.namedChildren.some((child) => /redirect/u.test(child.type)) || node.parent?.type === 'redirected_statement',
      context, source: { start: node.startIndex, end: node.endIndex, depth } };
    const pending = [call];
    let wrappers = 0;
    while (pending.length) {
      const current = pending.shift()!;
      if (++wrappers > 16) { analysis.hasError = true; break; }
      const name = path.posix.basename(current.name);
      if (name === 'git') current.semantics = gitSemantics(current);
      if (name === 'tar') current.semantics = tarSemantics(current);
      analysis.calls.push(current);
      const source = embeddedShell(current);
      if (source !== undefined) {
        if (depth >= MAX_NESTING) analysis.hasError = true;
        else {
          const nested = parser.parse(source);
          try {
            if (!nested || nested.rootNode.hasError) analysis.hasError = true;
            else collectCommands(nested.rootNode, analysis, depth + 1, parser, embeddedContext(current));
          } finally { nested?.delete(); }
        }
      }
      const wrapped = wrappedCommand(current);
      if (wrapped) pending.push(wrapped);
      pending.push(...findCommands(current));
    }
    // Expansions and redirects run in the calling shell, not a launcher's -C/-D cwd.
    for (const child of node.namedChildren) walk(child);
    return afterBuiltin(call, context);
  }
  if (LOCAL.has(node.type)) {
    let local = context;
    for (const child of node.namedChildren) local = walk(child, local);
    return context;
  }
  if (CONTROL.has(node.type)) {
    const unknown = unknownContext(context, `Unresolved control-flow context: ${node.type}`);
    for (const child of node.namedChildren) walk(child, unknown);
    return unknown;
  }
  if (node.type === 'pipeline') {
    for (const child of node.namedChildren) walk(child);
    return unknownContext(context, 'Pipeline shell-state propagation is unresolved');
  }
  if (['program', 'list', 'compound_statement'].includes(node.type)) {
    let current = context;
    let before = context;
    for (const child of node.children) {
      if (child.type === '||') {
        if (current !== context) current = unknownContext(context, 'Failure branch has unresolved directory');
      }
      else if (child.type === '&') current = before;
      else if (child.isNamed) { before = current; current = walk(child, current); }
    }
    // Only the && right side can assume success of the preceding cd. After the
    // whole conditional list, either branch may have run, so do not leak that cwd.
    return node.type === 'list' && current !== context
      ? unknownContext(context, 'Conditional list has multiple possible final contexts') : current;
  }
  if (node.type === 'redirected_statement') {
    let result = context;
    for (const child of node.namedChildren) {
      const next = walk(child);
      if (!/redirect/u.test(child.type)) result = next;
    }
    return result;
  }
  for (const child of node.namedChildren) walk(child);
  return context;
}
