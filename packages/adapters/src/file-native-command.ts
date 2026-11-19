import type { SshCommandTerminal } from './ssh-command-terminal.js';

export type FileCommandOutcome =
  | { state: 'exited'; exitCode: number; output: string }
  | { state: 'not-dispatched' }
  | { state: 'unknown' };

const OUTPUT_LIMIT = 1_048_576;

/** One literal file command over the private native-exec channel. The terminal
 * is caller-owned and commands run strictly sequentially: every call rebinds
 * the terminal's single listeners and classifies the outcome from its
 * not-dispatched/exit evidence. Unknown never assumes the command did not run. */
export async function runFileCommand(terminal: SshCommandTerminal, command: string, cwd: string,
  current: () => boolean, timeoutMs = 60_000): Promise<FileCommandOutcome> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) throw new Error('Invalid file command deadline');
  let output = '', exitCode: number | undefined, notDispatched = false;
  const classify = (): FileCommandOutcome =>
    Number.isInteger(exitCode) && exitCode !== undefined && exitCode >= 0 && exitCode <= 255
      ? { state: 'exited', exitCode, output }
      : notDispatched && exitCode === undefined ? { state: 'not-dispatched' } : { state: 'unknown' };
  terminal.onDisplay(() => {});
  terminal.onData((text) => { if (Buffer.byteLength(output) <= OUTPUT_LIMIT) output += text; });
  terminal.onExecutionFailure((failure) => {
    if (failure.failureKind === 'not-dispatched' && failure.effects === 'none') notDispatched = true;
  });
  terminal.onExit((code) => { if (exitCode === undefined) exitCode = code; });
  const execution = (async (): Promise<FileCommandOutcome> => {
    try { await terminal.execute(command, cwd, current, { executionChannel: 'native-exec' }); }
    catch { /* A local refusal before dispatch stays not-dispatched; anything
      observed after a dispatch attempt keeps the unknown classification. */ }
    return classify();
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
    const outcome = await Promise.race([execution, deadline]);
    if (outcome !== 'timeout') return outcome;
    // The command may still be running; revoke the channel and report unknown. Never retry.
    terminal.close();
    return { state: 'unknown' };
  } finally { clearTimeout(timer); }
}
