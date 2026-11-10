import { openManualChannel } from './ssh-manual-channel.js';
import { prepareX11Forwarding } from './x11-forwarding.js';
import { manualSessionStartup } from './manual-session.js';
import type { SshConnectionSettings } from '@cloudhelm/core';
import { randomBytes } from 'node:crypto';
import type { Client, ClientChannel } from 'ssh2';

export interface ShellCommandEvent { phase: 'start' | 'end' | 'unavailable'; command?: string; exitCode?: number }
const quote = (text: string): string => `'${text.replace(/'/gu, `'"'"'`)}'`;

/** Private per-session markers; split escape sequences are buffered before display. */
export class ShellMarkerParser {
  private pending = '';
  constructor(private readonly nonce: string, private readonly output: (text: string) => void,
    private readonly command: (event: ShellCommandEvent) => void,
    private readonly cwd: (directory: string) => void = () => {},
    private readonly decode: (bytes: Buffer) => string = (bytes) => bytes.toString('utf8')) {}
  push(text: string): void {
    this.pending += text;
    const prefix = `\x1b]777;cloudhelm;${this.nonce};`;
    while (this.pending) {
      const start = this.pending.indexOf('\x1b]');
      if (start < 0) {
        const keep = this.pending.endsWith('\x1b') ? 1 : 0;
        this.output(this.pending.slice(0, this.pending.length - keep)); this.pending = this.pending.slice(this.pending.length - keep); return;
      }
      if (start > 0) { this.output(this.pending.slice(0, start)); this.pending = this.pending.slice(start); }
      const bell = this.pending.indexOf('\x07');
      const st = this.pending.indexOf('\x1b\\');
      const end = bell < 0 ? st : st < 0 ? bell : Math.min(bell, st);
      if (end < 0) {
        if (this.pending.length > 131072) { this.command({ phase: 'unavailable' }); this.output(this.pending); this.pending = ''; }
        return;
      }
      const marker = this.pending.slice(0, end);
      this.pending = this.pending.slice(end + (end === st ? 2 : 1));
      if (!marker.startsWith(prefix)) { this.output(marker + '\x07'); continue; }
      const value = marker.slice(prefix.length);
      if (value.startsWith('start;')) {
        const hex = value.slice(6);
        if (!/^(?:[\da-f]{2})*$/u.test(hex)) { this.command({ phase: 'unavailable' }); continue; }
        this.command({ phase: 'start', command: this.decode(Buffer.from(hex, 'hex')).trim() });
      } else if (value.startsWith('cwd;')) {
        const hex = value.slice(4);
        if (/^(?:[\da-f]{2}){1,8192}$/u.test(hex)) {
          const directory = this.decode(Buffer.from(hex, 'hex'));
          if (directory.startsWith('/') && directory.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(directory)) this.cwd(directory);
        }
      } else if (/^end;\d+$/u.test(value)) this.command({ phase: 'end', exitCode: Number(value.slice(4)) });
      else this.command({ phase: 'unavailable' });
    }
  }
  finish(): void { if (this.pending) this.output(this.pending); this.pending = ''; this.command({ phase: 'unavailable' }); }
}

/** Temporary startup shims are removed after sourcing. User startup files are never rewritten. */
export function integratedShellCommand(nonce: string, startup = ''): string {
  const emit = `printf '\\033]777;cloudhelm;${nonce};`;
  const reportCwd = `${emit}cwd;%s\\007' "$(printf '%s' "$(pwd -P)" | od -An -v -tx1 | tr -d ' \\n')"`;
  const cleanup = `case "$CLOUDHELM_SHELL_DIR" in
*/cloudhelm-shell.${nonce}.????????)
  if [ -d "$CLOUDHELM_SHELL_DIR" ] && [ ! -L "$CLOUDHELM_SHELL_DIR" ]; then
    rm -f -- "$CLOUDHELM_SHELL_DIR/bashrc" "$CLOUDHELM_SHELL_DIR/.zshenv" "$CLOUDHELM_SHELL_DIR/.zshrc" "$CLOUDHELM_SHELL_DIR/.zprofile" "$CLOUDHELM_SHELL_DIR/.zlogin"
    rmdir -- "$CLOUDHELM_SHELL_DIR" 2>/dev/null
  fi;;
esac`;
  const bash = `
${cleanup}
unset CLOUDHELM_SHELL_DIR
# SSH shells traditionally load the login profile; preserve its startup setup.
[ ! -r /etc/profile ] || . /etc/profile
for __cloudhelm_profile in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
  if [ -r "$__cloudhelm_profile" ]; then . "$__cloudhelm_profile"; break; fi
done
unset __cloudhelm_profile
${startup}
__cloudhelm_start() {
  local cmd latest
  latest=$(HISTTIMEFORMAT= builtin history 1)
  if ! shopt -oq history || [[ -z "$latest" || "$latest" = "$__cloudhelm_history" ]]; then
    ${emit}unavailable\\007'; return
  fi
  cmd=$(builtin fc -ln -1 2>/dev/null) || cmd=''
  ${emit}start;%s\\007' "$(printf '%s' "$cmd" | od -An -v -tx1 | tr -d ' \\n')"
}
__cloudhelm_end() {
  local code=$?
  __cloudhelm_history=$(HISTTIMEFORMAT= builtin history 1)
  ${emit}end;%s\\007' "$code"
  ${reportCwd}
}
# PS0 marks a complete top-level input, including pipelines and compound commands.
if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then
  PS0='$(__cloudhelm_start)'"\${PS0-}"
  if declare -p PROMPT_COMMAND 2>/dev/null | command grep -q 'declare -a'; then
    PROMPT_COMMAND=(__cloudhelm_end "\${PROMPT_COMMAND[@]}")
  else
    PROMPT_COMMAND="__cloudhelm_end\${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
  fi
fi
`;
  const zshEnv = `
ZDOTDIR=$CLOUDHELM_ORIGINAL_ZDOTDIR
[ ! -r "$ZDOTDIR/.zshenv" ] || . "$ZDOTDIR/.zshenv"
CLOUDHELM_ORIGINAL_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$CLOUDHELM_SHELL_DIR
`;
  const zshRc = `
ZDOTDIR=$CLOUDHELM_ORIGINAL_ZDOTDIR
[ ! -r "$ZDOTDIR/.zshrc" ] || . "$ZDOTDIR/.zshrc"
__cloudhelm_start() { ${emit}start;%s\\007' "$(printf '%s' "$1" | od -An -v -tx1 | tr -d ' \\n')"; }
__cloudhelm_end() { local code=$?; ${emit}end;%s\\007' "$code"; ${reportCwd}; }
autoload -Uz add-zsh-hook
add-zsh-hook preexec __cloudhelm_start
add-zsh-hook precmd __cloudhelm_end
CLOUDHELM_ORIGINAL_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$CLOUDHELM_SHELL_DIR
`;
  const zshProfile = `ZDOTDIR=$CLOUDHELM_ORIGINAL_ZDOTDIR
[ ! -r "$ZDOTDIR/.zprofile" ] || . "$ZDOTDIR/.zprofile"
CLOUDHELM_ORIGINAL_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$CLOUDHELM_SHELL_DIR
`;
  const zshLogin = `ZDOTDIR=$CLOUDHELM_ORIGINAL_ZDOTDIR
${cleanup}
unset CLOUDHELM_SHELL_DIR CLOUDHELM_ORIGINAL_ZDOTDIR
[ ! -r "$ZDOTDIR/.zlogin" ] || . "$ZDOTDIR/.zlogin"
${startup}
`;
  const script = `case "\${SHELL##*/}" in
bash|zsh)
  CLOUDHELM_SHELL_DIR=$(mktemp -d "\${TMPDIR:-/tmp}/cloudhelm-shell.${nonce}.XXXXXXXX") || exec "$SHELL" -i
  chmod 700 "$CLOUDHELM_SHELL_DIR"
  export CLOUDHELM_SHELL_DIR
  trap ${quote(cleanup)} EXIT HUP INT TERM
  if [ "\${SHELL##*/}" = bash ]; then
    printf %s ${quote(bash)} > "$CLOUDHELM_SHELL_DIR/bashrc"
    exec "$SHELL" --rcfile "$CLOUDHELM_SHELL_DIR/bashrc" -i
  else
    CLOUDHELM_ORIGINAL_ZDOTDIR=\${ZDOTDIR:-$HOME}; export CLOUDHELM_ORIGINAL_ZDOTDIR
    printf %s ${quote(zshEnv)} > "$CLOUDHELM_SHELL_DIR/.zshenv"
    printf %s ${quote(zshRc)} > "$CLOUDHELM_SHELL_DIR/.zshrc"
    printf %s ${quote(zshProfile)} > "$CLOUDHELM_SHELL_DIR/.zprofile"
    printf %s ${quote(zshLogin)} > "$CLOUDHELM_SHELL_DIR/.zlogin"
    ZDOTDIR=$CLOUDHELM_SHELL_DIR; export ZDOTDIR
    exec "$SHELL" -il
  fi;;
*)
${startup}
${reportCwd}
exec "\${SHELL:-/bin/sh}" -i;;
esac`;
  return `/bin/sh -c ${quote(script)}`;
}

export interface ManualShellOptions { settings: SshConnectionSettings; assertAuthorized(): void; signal?: AbortSignal; x11Cookie?: string }
export async function openIntegratedShell(client: Client, cols: number, rows: number, options?: ManualShellOptions): Promise<{ channel: ClientChannel; nonce: string }> {
  const nonce = randomBytes(16).toString('hex');
  const command = integratedShellCommand(nonce, manualSessionStartup(options?.settings.session));
  options?.assertAuthorized();
  const x11 = options?.settings.x11?.enabled ? await prepareX11Forwarding(client, options.settings.x11, options.assertAuthorized, options.x11Cookie, options.signal) : undefined;
  let channel: ClientChannel | undefined;
  const cancel = () => { x11?.dispose(); channel?.close(); };
  const cleanup = () => { options?.signal?.removeEventListener('abort', cancel); x11?.dispose(); };
  options?.signal?.addEventListener('abort', cancel, { once: true });
  try {
    options?.assertAuthorized();
    channel = await openManualChannel(client, command,
      { pty: { term: options?.settings.terminal?.term ?? 'xterm-256color', cols, rows }, ...(x11 ? { x11: x11.request } : {}) },
      options?.assertAuthorized ?? (() => {}), options?.signal);
    options?.assertAuthorized();
    if (channel.destroyed || channel.readableEnded) cleanup();
    else channel.once('close', cleanup);
    return { channel, nonce };
  } catch (error) { cancel(); cleanup(); throw error; }
}
