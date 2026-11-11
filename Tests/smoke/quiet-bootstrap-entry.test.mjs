import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { quietBootstrapEntry } from './quiet-bootstrap-entry.mjs';

const bootstrap = resolve('synthetic quiet bootstrap.mjs');
const entry = resolve('synthetic application/index.js');
describe('quiet Electron bootstrap argument identity', () => {
  it('finds the entry after its own script, with or without Playwright debug switches', () => {
    expect(quietBootstrapEntry(['electron', bootstrap, entry], bootstrap)).toBe(entry);
    expect(quietBootstrapEntry(['electron', '--inspect=0', '--remote-debugging-port=0', bootstrap, entry], bootstrap)).toBe(entry);
  });
  it('does not confuse unrelated switches or executable paths with the application entry', () => {
    expect(() => quietBootstrapEntry(['electron', bootstrap, '--remote-debugging-port=0'], bootstrap)).toThrow('absolute');
    expect(() => quietBootstrapEntry(['electron', entry], bootstrap)).toThrow('missing');
    expect(() => quietBootstrapEntry(['electron', bootstrap, entry, 'unexpected'], bootstrap)).toThrow('exactly one');
  });
  it('rejects missing, duplicated and self-referential entries', () => {
    expect(() => quietBootstrapEntry(['electron', bootstrap], bootstrap)).toThrow('exactly one');
    expect(() => quietBootstrapEntry(['electron', bootstrap, bootstrap, entry], bootstrap)).toThrow('ambiguous');
    expect(() => quietBootstrapEntry(['electron', bootstrap, bootstrap], bootstrap)).toThrow();
  });
});
