import { createElement, type ReactNode } from 'react';
import { createLowlight, type LanguageFn } from 'lowlight';
import bash from 'highlight.js/lib/languages/bash';
import diff from 'highlight.js/lib/languages/diff';
import ini from 'highlight.js/lib/languages/ini';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import typescript from 'highlight.js/lib/languages/typescript';
import yaml from 'highlight.js/lib/languages/yaml';

/** Only the grammars below are bundled; every other fence stays plain text. */
const grammars: Record<string, LanguageFn> = { bash, diff, ini, javascript, json, python, typescript, yaml };
const lowlight = createLowlight();
for (const [name, grammar] of Object.entries(grammars)) lowlight.register(name, grammar);

/** Highlighting cost stays bounded; oversized blocks fall back to plain text. */
export const HIGHLIGHT_CHAR_LIMIT = 100_000;

interface HighlightToken {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HighlightToken[];
}

function tokenToReact(token: HighlightToken, path: string): ReactNode {
  if (token.type === 'text') return token.value ?? '';
  if (token.type !== 'element') return null;
  const classNames = Array.isArray(token.properties?.className)
    ? token.properties.className.filter((name: unknown): name is string => typeof name === 'string').join(' ')
    : '';
  return createElement(token.tagName ?? 'span', { key: path, className: classNames },
    ...(token.children ?? []).map((child, index) => tokenToReact(child, `${path}.${index}`)));
}

/**
 * Highlights code into React nodes without ever producing HTML strings.
 * Returns null for unknown languages, oversized input or highlighter
 * failures; callers then render the literal source text.
 */
export function highlightCode(language: string, code: string): ReactNode[] | null {
  if (!code || code.length > HIGHLIGHT_CHAR_LIMIT || !lowlight.registered(language)) return null;
  try {
    const root = lowlight.highlight(language, code);
    return root.children.map((child, index) => tokenToReact(child, String(index)));
  } catch {
    return null;
  }
}
