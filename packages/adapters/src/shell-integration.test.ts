import { describe, expect, it } from 'vitest';
import { ShellMarkerParser } from './shell-integration.js';
describe('shell command markers', () => {
  it('keeps command boundaries across every possible byte split without exposing private markers', () => {
    const input = '\x1b]777;cloudhelm;nonce;start;6c73202d616c6c\x07one\n\x1b]777;cloudhelm;nonce;end;0\x07prompt';
    for (let split = 0; split <= input.length; split++) {
      let output = ''; const events: unknown[] = [];
      const parser = new ShellMarkerParser('nonce', (text) => { output += text; }, (event) => events.push(event));
      parser.push(input.slice(0, split)); parser.push(input.slice(split));
      expect(output).toBe('one\nprompt');
      expect(events).toEqual([{ phase: 'start', command: 'ls -all' }, { phase: 'end', exitCode: 0 }]);
    }
  });
  it('does not treat other sessions or arbitrary prompt-looking output as command boundaries', () => {
    const events: unknown[] = []; let output = '';
    const parser = new ShellMarkerParser('a', (text) => { output += text; }, (event) => events.push(event));
    parser.push('\x1b]777;cloudhelm;b;start;6c73\x07user@host$ whoami\n');
    expect(events).toEqual([]); expect(output).toContain('whoami');
  });
});
