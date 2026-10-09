/** Best-effort masking for stored and model-visible remote output. */
export function redactOutput(input: string): string {
  const key = '(?:[\\w.-]*(?:password|passwd|api[_-]?key|token|secret|sendkey|authorization|cookie|otp|verification[_-]?code)[\\w.-]*|密码|验证码)';
  return input
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu, '[REDACTED PRIVATE KEY]')
    .replace(/(Authorization:\s*(?:Bearer|Basic)\s+)[^\s\r\n]+/giu, '$1[REDACTED]')
    .replace(new RegExp(`(?<![\\w.-])(["']?${key}["']?\\s*[=:：]\\s*)("(?:\\\\.|[^"\\\\])*"|'[^']*'|[^\\s,;}\\r\\n]+)`, 'giu'), (match, prefix: string, value: string) => {
      if (/(?:max|input|output|digest|completion)[_-]tokens["']?\s*[=:：]/iu.test(prefix)
        && /^(?:\d+|"\d+"|'\d+')$/u.test(value)) return match;
      const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : '';
      return prefix + quote + '[REDACTED]' + quote;
    })
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/gu, '[REDACTED KEY]');
}

/** Redacts complete lines across arbitrary SSH data-chunk boundaries. */
export class OutputRedactor {
  constructor(private readonly maxPendingLength = 8192) {}
  private pending = '';
  private inPrivateKey = false;
  private quotedSecret?: string;

  push(chunk: string): string {
    this.pending += chunk.replace(/\u001b\[[\d;?]*[ -/]*[@-~]/gu, '');
    let safe = '';
    while (true) {
      const newline = this.pending.indexOf('\n');
      if (newline < 0) break;
      const line = this.pending.slice(0, newline + 1);
      this.pending = this.pending.slice(newline + 1);
      safe += this.line(line);
    }
    if (this.pending.length > this.maxPendingLength) {
      this.pending = '';
      safe += '[REDACTED LONG UNTERMINATED OUTPUT]\n';
    }
    return safe;
  }

  snapshotTail(): string {
    if (this.inPrivateKey || this.quotedSecret) return '[REDACTED]';
    return redactOutput(this.pending);
  }

  finish(): string {
    const safe = this.pending ? this.line(this.pending) : '';
    this.pending = '';
    return safe;
  }

  private line(line: string): string {
    if (this.quotedSecret) {
      const end = this.closingQuote(line, this.quotedSecret);
      if (end < 0) return '';
      this.quotedSecret = undefined;
      line = line.slice(end + 1);
    }
    if (this.inPrivateKey) {
      if (/-----END [A-Z ]*PRIVATE KEY-----/u.test(line)) this.inPrivateKey = false;
      return '';
    }
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(line)) {
      this.inPrivateKey = !/-----END [A-Z ]*PRIVATE KEY-----/u.test(line);
      return '[REDACTED PRIVATE KEY]\n';
    }
    const start = line.match(/(?<![\w.-])(?:[\w.-]*(?:password|passwd|api[_-]?key|token|secret|sendkey|otp)[\w.-]*|密码|验证码)["']?\s*[=:：]\s*(["'])/iu);
    if (start) {
      const offset = start.index! + start[0].length;
      if (this.closingQuote(line.slice(offset), start[1]!) < 0) {
        this.quotedSecret = start[1];
        return redactOutput(line.slice(0, offset - 1) + '[REDACTED]') + '\n';
      }
    }
    return redactOutput(line);
  }
  private closingQuote(text: string, quote: string): number {
    let escaped = false;
    for (let index = 0; index < text.length; index++) {
      if (!escaped && text[index] === quote) return index;
      escaped = !escaped && text[index] === '\\';
    }
    return -1;
  }

}
