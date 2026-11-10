/** Constant-space ANSI filtering. A partial control sequence never enters the secret matcher. */
export class RedactionAnsiFilter {
  private state: 'text' | 'escape' | 'csi' | 'osc' | 'osc-escape' = 'text';

  push(chunk: string): string {
    let output = '';
    for (const character of chunk) {
      if (this.state === 'osc') {
        if (character === '\u0007') this.state = 'text';
        else if (character === '\u001b') this.state = 'osc-escape';
        continue;
      }
      if (this.state === 'osc-escape') {
        this.state = character === '\\' || character === '\u0007' ? 'text' : character === '\u001b' ? 'osc-escape' : 'osc';
        continue;
      }
      if (character === '\u001b') { this.state = 'escape'; continue; }
      if (this.state === 'escape') {
        if (character === '[') { this.state = 'csi'; continue; }
        if (character === ']') { this.state = 'osc'; continue; }
        this.state = 'text';
        // Unknown ESC forms must not eat a credential-name character.
      } else if (this.state === 'csi') {
        if (character >= '@' && character <= '~') this.state = 'text';
        else if (character === '\n' || character === '\r') { this.state = 'text'; output += character; }
        continue;
      }
      output += character;
    }
    return output;
  }
}
