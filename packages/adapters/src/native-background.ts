import { randomUUID } from 'node:crypto';
import { validBackgroundLogPath } from '@cloudhelm/core';

/** /proc disappearance marker for the bounded existence check; never business output. */
export const NATIVE_BACKGROUND_PROC_GONE = '__CLOUDHELM_PROC_GONE__';
/** Private shell-reported exit marker appended by the launch body, read from the log tail only. */
const EXIT_MARKER = '__CLOUDHELM_EXIT__';
/** The reviewed business text plus the backend exit marker, byte-bounded like every native dispatch. */
const MAX_COMMAND_BYTES = 8192;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Backend-owned private log path; the model never chooses or renames it. */
export function renderNativeBackgroundLogPath(): string {
  return `/tmp/.cloudhelm-bg-${randomUUID()}.log`;
}

/** Backend-rendered detached launch. The reviewed command is embedded once into a
 * setsid'd /bin/sh whose process group, session and pid coincide, so the observed
 * pid is exactly the signalable group. Output lands in a 0600 log the launch itself
 * creates via umask; stdin is detached so no prompt can strand the job. */
export function renderNativeBackgroundLaunch(input: { command: string; logPath: string }): string {
  if (!validBackgroundLogPath(input.logPath)) throw new Error('Native background requires a backend log path');
  if (!input.command.trim() || input.command.includes('\u0000'))
    throw new Error('Native background command is empty or contains NUL');
  const business = `${input.command}\nprintf '${EXIT_MARKER}%s\\n' "$?"`;
  const launch = `umask 077\nsetsid /bin/sh -c ${quote(business)} > ${quote(input.logPath)} 2>&1 < /dev/null &\necho $!`;
  if (Buffer.byteLength(launch, 'utf8') > MAX_COMMAND_BYTES)
    throw new Error('Native background command exceeds the dispatch limit');
  return launch;
}

/** The launch reports the setsid'd pid on stdout; only a trailing integer is accepted. */
export function parseNativeBackgroundPid(output: string): number | undefined {
  const lines = output.trim().split(/\r?\n/u).filter((line) => /^\d{1,10}$/u.test(line));
  const pid = Number(lines.at(-1));
  return Number.isSafeInteger(pid) && pid >= 1 && pid <= 2147483647 ? pid : undefined;
}

/** Existence check that never confuses an unreadable stat with a vanished process:
 * exit 0 plus the gone marker means /proc/<pid>/stat is absent, nothing else. */
export function renderNativeBackgroundStatCheck(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid process identity');
  const reference = `/proc/${pid}/stat`;
  return `if [ -e ${quote(reference)} ]; then cat ${quote(reference)}; else printf '%s' ${quote(NATIVE_BACKGROUND_PROC_GONE)}; fi`;
}

/** /proc/<pid>/stat fields after the last ')': pgrp is field 5 (index 2), session
 * field 6 (index 3) and starttime field 22 (index 19). The launch invariant requires
 * pgrp and session to equal the pid; starttime binds the observation against reuse. */
export function parseNativeBackgroundStat(stat: string, pid: number): { processStartTime: number } | undefined {
  const close = stat.lastIndexOf(')');
  if (close < 0 || !stat.startsWith(`${pid} (`)) return undefined;
  const tokens = stat.slice(close + 1).trim().split(/\s+/u);
  const pgrp = Number(tokens[2]), session = Number(tokens[3]), processStartTime = Number(tokens[19]);
  if (!Number.isSafeInteger(pgrp) || pgrp !== pid || !Number.isSafeInteger(session) || session !== pid
    || !Number.isSafeInteger(processStartTime) || processStartTime < 0) return undefined;
  return { processStartTime };
}

/** Detached observation: poll /proc until the process disappears, then read the
 * bounded log tail. No exit is inferred from channel closure or the loop itself. */
export function renderNativeBackgroundWatcher(pid: number, logPath: string): string {
  if (!validBackgroundLogPath(logPath)) throw new Error('Native background requires a backend log path');
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid process identity');
  return `while [ -d ${quote(`/proc/${pid}`)} ]; do sleep 2; done\ntail -c 256 ${quote(logPath)}`;
}

/** The log tail is authoritative only for the backend marker; a tail without it
 * means the process died without a shell-reported code and stays unknown. */
export function parseNativeBackgroundExit(output: string): number | undefined {
  const matches = [...output.matchAll(new RegExp(`${EXIT_MARKER}(\\d{1,3})`, 'gu'))];
  const code = Number(matches.at(-1)?.[1]);
  return Number.isInteger(code) && code >= 0 && code <= 255 ? code : undefined;
}

/** Signal the exact process group created by the launch. Absolute path so a shell
 * builtin cannot reinterpret the arguments; the text matches the reviewed control. */
export function renderNativeBackgroundStop(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid process identity');
  return `/bin/kill -INT -- -${pid}`;
}
