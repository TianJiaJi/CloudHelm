import type { CommandAnalysis, CommandCall } from './model.js';

export function isSudo(call: CommandCall): boolean {
  return call.name === 'sudo' || call.name === '/usr/bin/sudo';
}

/** The password recipient is the literal sudo process, never a shell or stdin. */
export function sudoTarget(call: CommandCall): { name: string; args: string[]; runAs: string } | undefined {
  if (!isSudo(call)) return;
  const args = call.args;
  let index = 0;
  let runAs = 'root';
  while (index < args.length) {
    const option = args[index]!;
    if (['-n', '--non-interactive', '-k', '--reset-timestamp', '-H', '--set-home'].includes(option)) { index++; continue; }
    if (['-u', '--user', '-g', '--group'].includes(option) && /^[a-z_][a-z0-9_-]*[$]?$/iu.test(args[index + 1] ?? '')) {
      if (option === '-u' || option === '--user') runAs = args[index + 1]!;
      index += 2; continue;
    }
    break;
  }
  if (args[index] === '--') index++;
  if (!args[index] || args[index]!.startsWith('-') || args[index]!.includes('=')) return;
  return { name: args[index]!, args: args.slice(index + 1), runAs };
}

/** Prepare the exact operation BEFORE approval; never add elevation in an executor. */
export function sudoContextCommand(analysis: CommandAnalysis): string {
  const step = analysis.steps?.[0]?.call;
  if (!step || analysis.steps?.length !== 1 || analysis.hasError || analysis.hasExpansion || analysis.hasPipeline
    || analysis.hasRedirection || (analysis.hasCompound && !isSudo(step)) || step.dynamic || step.redirects)
    throw new Error('sudo context requires one literal command without expansion, pipes or redirections; no command sent');
  if (isSudo(step)) {
    const target = sudoTarget(step);
    if (!target || target.runAs !== 'root' || !supportsSudo(analysis)
      || ['true', '/bin/true', '/usr/bin/true'].includes(target.name)
      || /(?:^|\/)(?:sudo|su)$/u.test(target.name)) throw new Error('Unsupported sudo identity, probe or nested authentication; no command sent');
    return analysis.raw;
  }
  if (analysis.calls.length !== 1 || ['true', '/bin/true', '/usr/bin/true'].includes(step.name) || /(?:^|\/)(?:sudo|su)$/u.test(step.name))
    throw new Error('Nested authentication or opaque command is unsupported; no command sent');
  return `sudo -- ${analysis.raw}`;
}

export function supportsSudo(analysis: CommandAnalysis): boolean {
  if (analysis.hasError || analysis.hasExpansion || analysis.hasPipeline || analysis.hasRedirection || !analysis.steps) return false;
  const sudo = analysis.steps.filter(({ call }) => isSudo(call));
  return sudo.length > 0 && sudo.every(({ call }) => !!sudoTarget(call))
    && analysis.calls.length === analysis.steps.length + sudo.length
    && !analysis.calls.some((call) => /(?:^|\/)su$/u.test(call.name));
}

/** Client-owned sudo marker prompt. The leading CR pins column 0 so the marker
 * never wraps on any sane width; the 32-hex nonce is unguessable per dispatch. */
export function sudoMarkerPrompt(nonce: string): string {
  if (!/^[a-f0-9]{32}$/u.test(nonce)) throw new Error('Invalid sudo marker nonce');
  return `\rcloudhelm:${nonce} password: `;
}

/** Rebuild one literal sudo command for the credential-bound native PTY with the
 * client-owned marker prompt. Returns undefined when the parsed form carries an
 * option that would override the marker or move the password to another helper;
 * the caller must then not dispatch on this route. */
export function sudoPtyCommand(analysis: CommandAnalysis, markerPrompt: string): string | undefined {
  const call = analysis.steps?.[0]?.call;
  if (!call || !isSudo(call) || call.dynamic || call.redirects) return undefined;
  // A rebuild that silently dropped pipe or redirection content would dispatch a
  // different command than the one reviewed; such forms never take this route.
  if (analysis.hasError || analysis.hasPipeline || analysis.hasRedirection || analysis.steps?.length !== 1) return undefined;
  if (call.args.some((arg) => ['-p', '--prompt', '-A', '--askpass'].includes(arg))) return undefined;
  if (/[\u0000\u000a]/u.test(markerPrompt) || markerPrompt.length > 128) return undefined;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const reset = call.args.includes('-k') || call.args.includes('--reset-timestamp') ? '' : '-k ';
  return `sudo ${reset}-p ${quote(markerPrompt)}${call.args.length ? ` ${call.args.map(quote).join(' ')}` : ''}`;
}
