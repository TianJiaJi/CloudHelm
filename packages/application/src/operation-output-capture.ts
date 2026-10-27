import { OutputRedactor } from '@cloudhelm/core';

function tail(value: string, limit: number): string {
  let start = Math.max(0, value.length - limit);
  if (start > 0 && value.charCodeAt(start) >= 0xdc00 && value.charCodeAt(start) <= 0xdfff
    && value.charCodeAt(start - 1) >= 0xd800 && value.charCodeAt(start - 1) <= 0xdbff) start++;
  return value.slice(start);
}

/** Bounded redacted observation only; this never decides process exit, effects,
 * liveness or log retention. Counts refer to emitted redacted UTF-16 characters. */
export class OperationOutputCapture {
  private readonly redactor = new OutputRedactor();
  private retained = '';
  private totalChars = 0;

  get text(): string { return this.retained; }
  push(value: string): void { this.append(this.redactor.push(value)); }
  finish(): void { this.append(this.redactor.finish()); }
  private append(value: string): void {
    this.totalChars += value.length;
    this.retained = tail(this.retained + value, 65_536);
  }
  snapshot() {
    const stdoutTail = tail(this.retained, 16_384);
    return { stdoutTail, outputCapture: { totalChars: this.totalChars, tailChars: stdoutTail.length,
      truncated: this.totalChars > stdoutTail.length } };
  }
}
