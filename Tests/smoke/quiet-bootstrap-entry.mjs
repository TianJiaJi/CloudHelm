import { isAbsolute, resolve } from 'node:path';
import process from 'node:process';

/** Playwright may retain debug switches in Electron argv; never assume a fixed offset. */
export function quietBootstrapEntry(argv, bootstrap, platform = process.platform) {
  const normalize = (value) => platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  const expected = normalize(bootstrap);
  const positions = argv.flatMap((value, index) => index > 0 && isAbsolute(value) && normalize(value) === expected ? [index] : []);
  if (positions.length !== 1) throw new Error('Quiet bootstrap identity is missing or ambiguous');
  const tail = argv.slice(positions[0] + 1);
  if (tail.length !== 1 || !isAbsolute(tail[0]) || normalize(tail[0]) === expected) {
    throw new Error('Quiet bootstrap requires exactly one absolute application entry');
  }
  return tail[0];
}
