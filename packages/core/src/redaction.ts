import { RedactionAnsiFilter } from './redaction-ansi.js';

const SECRET_KEY = '(?:[\\w.-]*(?:password|passwd|api[_-]?key|token|secret|sendkey|authorization|cookie|otp|verification[_-]?code)[\\w.-]*|密码|验证码)';
const QUOTED_SECRET = `(?<![\\w.-])["']?${SECRET_KEY}["']?\\s*[=:：]\\s*(["'])`;

/** Best-effort masking for stored and model-visible remote output. */
export function redactOutput(input: string): string {
  return new RedactionAnsiFilter().push(input)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu, '[REDACTED PRIVATE KEY]')
    .replace(/(Authorization:\s*(?:Bearer|Basic)\s+)[^\s\r\n]+/giu, '$1[REDACTED]')
    .replace(new RegExp(`(?<![\\w.-])(["']?${SECRET_KEY}["']?\\s*[=:：]\\s*)("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,;}\\r\\n]+)`, 'giu'), (match, prefix: string, value: string) => {
      if (/(?:max|input|output|digest|completion)[_-]tokens["']?\s*[=:：]/iu.test(prefix)
        && /^(?:\d+|"\d+"|'\d+')$/u.test(value)) return match;
      const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : '';
      return prefix + quote + '[REDACTED]' + quote;
    })
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/gu, '[REDACTED KEY]');
}

function closingQuote(text: string, quote: string, escaped = false): { index: number; escaped: boolean } {
  for (let index = 0; index < text.length; index++) {
    if (!escaped && text[index] === quote) return { index, escaped: false };
    escaped = !escaped && text[index] === '\\';
  }
  return { index: -1, escaped };
}

/** Line masking with chunk-invariant ANSI, quotation and overflow state. */
export class OutputRedactor {
  constructor(private readonly maxPendingLength = 8192) {
    // Infinity is retained for legacy reference capture; its bounded-storage migration is separate.
    if (!(maxPendingLength > 0) || (maxPendingLength !== Infinity && !Number.isSafeInteger(maxPendingLength))) {
      throw new Error('Invalid redaction buffer limit');
    }
  }
  private readonly ansi = new RedactionAnsiFilter();
  private pending = '';
  private inPrivateKey = false;
  private quotedSecret?: string;
  private quoteEscaped = false;
  private discarding = false;
  private markerTail = '';
  private markerKind?: 'begin' | 'end';

  push(chunk: string): string {
    let safe = '';
    for (const character of this.ansi.push(chunk)) {
      if (this.discarding) {
        this.discard(character);
      } else if (character === '\n') {
        safe += this.line(this.pending + character);
        this.pending = '';
      } else if (this.pending.length + character.length > this.maxPendingLength) {
        this.beginDiscard();
        this.discard(character);
        safe += '[REDACTED LONG UNTERMINATED OUTPUT]\n';
      } else {
        this.pending += character;
      }
    }
    return safe;
  }

  snapshotTail(): string {
    if (this.inPrivateKey || this.quotedSecret) return '[REDACTED]';
    if (this.discarding) return '';
    // Preview the same parser without consuming its state. An incomplete quoted value
    // cannot fall back to the unquoted token matcher and expose its remaining words.
    return new OutputRedactor(this.maxPendingLength).line(this.pending);
  }

  finish(): string {
    const safe = this.pending ? this.line(this.pending) : '';
    this.pending = '';
    return safe;
  }

  private line(input: string): string {
    let line = input;
    if (this.quotedSecret) {
      const end = closingQuote(line, this.quotedSecret, this.quoteEscaped);
      this.quoteEscaped = end.escaped;
      if (end.index < 0) return '';
      this.quotedSecret = undefined;
      line = line.slice(end.index + 1);
    }
    if (this.inPrivateKey) {
      if (/-----END [A-Z ]*PRIVATE KEY-----/u.test(line)) this.inPrivateKey = false;
      return '';
    }
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(line)) {
      this.inPrivateKey = !/-----END [A-Z ]*PRIVATE KEY-----/u.test(line);
      return '[REDACTED PRIVATE KEY]\n';
    }
    const starts = new RegExp(QUOTED_SECRET, 'giu');
    for (let start = starts.exec(line); start; start = starts.exec(line)) {
      const offset = start.index + start[0].length;
      const end = closingQuote(line.slice(offset), start[1]!);
      if (end.index < 0) {
        this.quotedSecret = start[1]; this.quoteEscaped = end.escaped;
        return redactOutput(line.slice(0, offset - 1) + '[REDACTED]') + (line.endsWith('\n') ? '\n' : '');
      }
      // Credential-looking text inside an already closed value is not another field.
      starts.lastIndex = offset + end.index + 1;
    }
    return redactOutput(line);
  }

  private beginDiscard(): void {
    const prefix = this.pending;
    const previousQuote = this.quotedSecret, previousEscape = this.quoteEscaped;
    this.line(prefix); // Preserve any secret/private-key state discovered before the limit.
    if (!this.quotedSecret && !this.inPrivateKey) {
      this.quotedSecret = previousQuote; this.quoteEscaped = previousEscape;
      // After discarding a line we cannot know which later quote belongs to a secret.
      // Conservatively track all quotes, rather than revealing a continuation.
      for (const character of prefix) this.trackQuote(character);
    }
    for (const character of prefix) this.trackMarker(character);
    this.pending = '';
    this.discarding = true;
  }

  private discard(character: string): void {
    this.trackMarker(character);
    if (!this.inPrivateKey) this.trackQuote(character);
    if (character === '\n') {
      this.discarding = false;
      this.markerTail = ''; this.markerKind = undefined;
    }
  }

  private trackQuote(character: string): void {
    if (this.quotedSecret) {
      if (!this.quoteEscaped && character === this.quotedSecret) this.quotedSecret = undefined;
      this.quoteEscaped = !this.quoteEscaped && character === '\\';
    } else if (character === '"' || character === "'") {
      this.quotedSecret = character; this.quoteEscaped = false;
    }
  }

  private trackMarker(character: string): void {
    // The type between BEGIN/END and PRIVATE KEY may be long; retain only a suffix,
    // not the entire discarded line, while keeping the header direction as a fact.
    this.markerTail = (this.markerTail + character).slice(-32);
    if (this.markerTail.endsWith('-----BEGIN ')) this.markerKind = 'begin';
    else if (this.markerTail.endsWith('-----END ')) this.markerKind = 'end';
    if (!/[A-Z -]/u.test(character)) this.markerKind = undefined;
    if (this.markerKind && this.markerTail.endsWith('PRIVATE KEY-----')) {
      this.inPrivateKey = this.markerKind === 'begin';
      this.markerKind = undefined;
    }
  }
}
