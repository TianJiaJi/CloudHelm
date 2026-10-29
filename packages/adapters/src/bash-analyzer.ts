import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectCommands } from './command-semantics/collect.js';
import { isDynamic, literalArgument } from './command-semantics/words.js';
import { Language, Parser, type Node as SyntaxNode } from 'web-tree-sitter';
import type { CommandAnalysis, CommandCall, CommandAnalyzer } from '@cloudhelm/core';

const require = createRequire(import.meta.url);
const MAX_COMMAND_LENGTH = 65_536;
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
      calls: [], redirectTargets: [], redirectEffects: [], scopedContexts: true, hasExpansion: false, hasPipeline: false, hasCompound: false,
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
      collectCommands(tree.rootNode, analysis, 0, parser);
      analysis.steps = literalSteps(tree.rootNode);
      if (analysis.calls.length > 1) analysis.hasCompound = true;
      return analysis;
    } finally {
      tree.delete();
    }
  }
}
