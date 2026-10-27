import { redactOutput } from '@cloudhelm/core';

/** Journal narratives are persisted verbatim, so reject recognizable credentials rather than echo them. */
export function hasJournalCredentials(text: string): boolean {
  return redactOutput(text) !== text || /\b[a-z][a-z\d+.-]*:\/\/[^\s/?#@]*:(?:[^\s/?#@]*)@/iu.test(text)
    || /\b[a-z][a-z\d+.-]*:\/\/[^\s/?#@]*%3a[^\s/?#@]*@/iu.test(text);
}
