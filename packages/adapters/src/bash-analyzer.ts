import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { embeddedShell, findCommands, shellWord, wrappedCommand } from './shell-wrappers.js';
import { Language, Parser, type Node as SyntaxNode } from 'web-tree-sitter';
import type { CommandAnalysis, CommandCall, CommandAnalyzer } from '@cloudhelm/core';

const require = createRequire(import.meta.url);
const MAX_COMMAND_LENGTH = 65_536;
const MAX_NESTING = 4;
const GRAMMAR_FILE = 'tree-sitter-bash.wasm';

/**
 * The grammar is loaded from the first location that exists:
 * the packaged resources, the directory of the built bundle (or its parent when bundles are
 * code-split into chunks), and finally the installed grammar package used by tests and sources.
 * Relying on module resolution alone breaks every unpackaged run, because the bundle resolves
 * from the application output directory, which cannot see the adapter's own node_modules.
 */
export function grammarPathCandidates(locations: {
  resourcesPath?: string | undefined;
  bundleDirectory?: string | undefined;
  packageDirectory?: string | undefined;
}): string[] {
  const directories = [
    locations.resourcesPath,
    locations.bundleDirectory,
    locations.bundleDirectory && path.join(locations.bundleDirectory, '..'),
    locations.packageDirectory
  ];
  return [...new Set(directories.filter((directory): directory is string => !!directory)
    .map((directory) => path.join(directory, GRAMMAR_FILE)))];
}

/** Selection is pure so the deployment order stays testable without a packaged application. */
export function findGrammarPath(locations: Parameters<typeof grammarPathCandidates>[0],
  exists: (file: string) => boolean = existsSync): string | undefined {
  return grammarPathCandidates(locations).find((candidate) => exists(candidate));
}

function bundleDirectory(): string | undefined {
  try { return path.dirname(fileURLToPath(import.meta.url)); } catch { return undefined; }
}

function installedGrammarDirectory(): string | undefined {
  try { return path.dirname(require.resolve('tree-sitter-bash/package.json')); } catch { return undefined; }
}

function resolveGrammarPath(): string {
  const locations = {
    resourcesPath: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
    bundleDirectory: bundleDirectory(),
    packageDirectory: installedGrammarDirectory()
  };
  const found = findGrammarPath(locations);
  if (!found) throw new Error(`Bash grammar file is missing; checked ${grammarPathCandidates(locations).join(', ')}`);
  return found;
}

function isDynamic(node: SyntaxNode): boolean {
  // Bash parses --format="..." as a concatenation even when both pieces are
  // literal. Recognize only Docker's simple quoted field template here.
  if (node.type === 'concatenation' && /^--format="(?:table )?\{\{\.[A-Za-z][A-Za-z0-9]*\}\}(?:(?:\\t|\t)\{\{\.[A-Za-z][A-Za-z0-9]*\}\})*"$/u.test(node.text)) return false;
  if (/expansion|substitution|glob|concatenation|arithmetic/u.test(node.type)) return true;
  return node.namedChildren.some(isDynamic);
}

/** Resolve only trivially literal echo/printf substitutions; never execute shell text. */
function literalArgument(node: SyntaxNode): string {
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

/** Flatten only foreground literal lists. Never split shell source on punctuation. */
function literalSteps(root: SyntaxNode): CommandAnalysis['steps'] {
  const steps: NonNullable<CommandAnalysis['steps']> = [];
  let condition: 'always' | 'success' | 'failure' = 'always';
  const visit = (node: SyntaxNode): boolean => {
    if (node.type === 'program' || node.type === 'list') return node.children.every(visit);
    if ([';', '&&', '||', '\n'].includes(node.type)) {
      condition = node.type === '&&' ? 'success' : node.type === '||' ? 'failure' : 'always';
      return true;
    }
    if (node.type === 'comment') return true;
    if (node.type !== 'command') return false;
    const name = node.childForFieldName('name');
    if (!name || node.namedChildren.some((child) => isDynamic(child) || /assignment|redirect/u.test(child.type))) return false;
    const call: CommandCall = { name: literalArgument(name),
      args: node.children.flatMap((child, index) => node.fieldNameForChild(index) === 'argument' ? [literalArgument(child)] : []),
      dynamic: false, redirects: false };
    // Builtins can change shell state; these must retain native shell evaluation.
    if (['cd', 'export', 'unset', 'source', '.', 'ulimit', 'umask', 'alias', 'unalias', 'type', 'command', 'eval', 'exec', 'exit', 'read', 'set'].includes(call.name)) return false;
    steps.push({ call, condition });
    condition = 'always';
    return true;
  };
  return visit(root) && steps.length ? steps : undefined;
}

function collect(node: SyntaxNode, analysis: CommandAnalysis, depth: number, parser: Parser): void {
  if (depth > MAX_NESTING) {
    analysis.hasError = true;
    return;
  }
  if (/expansion|substitution|glob|arithmetic/u.test(node.type)) analysis.hasExpansion = true;
  if (node.type === 'pipeline') analysis.hasPipeline = true;
  if (node.type === 'redirected_statement' || node.type === 'file_redirect' || node.type === 'herestring_redirect' || node.type === 'heredoc_redirect') analysis.hasRedirection = true;
  if (node.type === 'file_redirect') {
    const destination = node.childForFieldName('destination');
    if (destination && !/^\d*</u.test(node.text.trimStart())) analysis.redirectTargets.push(literalArgument(destination));
  }
  if (node.type === 'command') {
    const nameNode = node.childForFieldName('name');
    const name = nameNode ? literalArgument(nameNode) : '';
    const args = node.children.flatMap((child, index) => node.fieldNameForChild(index) === 'argument' ? [literalArgument(child)] : []);
    const call: CommandCall = {
      name,
      args,
      dynamic: !nameNode || isDynamic(nameNode) || node.namedChildren.some((child) => child.type === 'variable_assignment' || isDynamic(child)),
      redirects: node.namedChildren.some((child) => /redirect/u.test(child.type)) || node.parent?.type === 'redirected_statement'
    };
    const pending = [call];
    let wrappers = 0;
    while (pending.length) {
      const current = pending.shift()!;
      if (++wrappers > 16) { analysis.hasError = true; break; }
      analysis.calls.push(current);
      const source = embeddedShell(current);
      if (source !== undefined) {
        const nested = parser.parse(source);
        if (!nested || nested.rootNode.hasError) analysis.hasError = true;
        else collect(nested.rootNode, analysis, depth + 1, parser);
        nested?.delete();
      }
      const wrapped = wrappedCommand(current);
      if (wrapped) pending.push(wrapped);
      pending.push(...findCommands(current));
    }
  }
  for (const child of node.namedChildren) collect(child, analysis, depth, parser);
}

export class BashAnalyzer implements CommandAnalyzer {
  private parser: Parser | null = null;
  private initializing: Promise<Parser> | null = null;

  private async getParser(): Promise<Parser> {
    if (this.parser) return this.parser;
    if (!this.initializing) {
      // A failed initialization must not be cached: a later retry can succeed once the grammar is in place.
      this.initializing = this.createParser().catch((error: unknown) => {
        this.initializing = null;
        throw error;
      });
    }
    return this.initializing;
  }

  private async createParser(): Promise<Parser> {
    await Parser.init();
    const grammar = await Language.load(resolveGrammarPath());
    const parser = new Parser().setLanguage(grammar);
    this.parser = parser;
    return parser;
  }

  async analyze(command: string): Promise<CommandAnalysis> {
    const analysis: CommandAnalysis = {
      calls: [], redirectTargets: [], hasExpansion: false, hasPipeline: false, hasCompound: false,
      hasRedirection: false, hasError: command.length > MAX_COMMAND_LENGTH || command.includes('\u0000'), raw: command
    };
    if (analysis.hasError) return analysis;
    const parser = await this.getParser();
    const tree = parser.parse(command);
    if (!tree) return { ...analysis, hasError: true };
    try {
      analysis.hasError = tree.rootNode.hasError;
      analysis.hasCompound = tree.rootNode.namedChildren.length !== 1
        || tree.rootNode.namedChildren.some((node) => node.type !== 'command')
        || tree.rootNode.children.some((node) => ['&', ';', '&&', '||'].includes(node.type));
      collect(tree.rootNode, analysis, 0, parser);
      analysis.steps = literalSteps(tree.rootNode);
      if (analysis.calls.length > 1) analysis.hasCompound = true;
      return analysis;
    } finally {
      tree.delete();
    }
  }
}
