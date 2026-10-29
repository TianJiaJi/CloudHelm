import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { sudoTarget, type CommandAnalyzer, type ProposedOperation } from '@cloudhelm/core';
import type { VerificationSource } from '@cloudhelm/contracts';
import { hasJournalCredentials } from './journal-secrets.js';

/** A narrow byte-comparison binding, not a remote realpath or absence-of-effects claim. */
export async function verificationSource(operation: ProposedOperation, analyzer: CommandAnalyzer): Promise<VerificationSource | undefined> {
  const path = (value: string) => posix.resolve(operation.scope.cwd, value);
  if (operation.kind === 'write-file') {
    if (hasJournalCredentials(operation.path)) return;
    return { kind: 'file-write', path: path(operation.path), sha256: createHash('sha256').update(operation.content).digest('hex'),
      textSha256: createHash('sha256').update(operation.content.replace(/\r\n/gu, '\n')).digest('hex') };
  }
  if (operation.kind !== 'command') return;
  const analysis = await analyzer.analyze(operation.command).catch(() => undefined);
  if (!analysis || analysis.hasError || analysis.hasExpansion || analysis.hasPipeline || analysis.hasRedirection || analysis.steps?.length !== 1) return;
  const call = analysis.steps[0]!.call;
  if (call.dynamic || call.redirects) return;
  const target = sudoTarget(call) ?? call;
  if (['python', 'python3', '/usr/bin/python', '/usr/bin/python3', '/usr/local/bin/python3'].includes(target.name)
    && target.args[0] && !target.args[0].startsWith('-') && !/[*?\[\]{}~]/u.test(target.args[0])
    && !hasJournalCredentials(JSON.stringify(target.args))) {
    const script = path(target.args[0]);
    return { kind: 'program-run', path: script,
      identity: createHash('sha256').update(JSON.stringify([target.name, script, target.args.slice(1), operation.scope.loginAs, operation.scope.runAs])).digest('hex') };
  }
  if (!['cat', '/bin/cat', '/usr/bin/cat'].includes(target.name)) return;
  const args = target.args[0] === '--' ? target.args.slice(1) : target.args;
  if (args.length !== 1 || !args[0] || args[0] === '-' || args[0].startsWith('-') || /[*?\[\]{}~]/u.test(args[0]) || hasJournalCredentials(args[0])) return;
  return { kind: 'file-read', path: path(args[0]) };
}
