import { execFile } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('loads SSH authentication under native Node ESM, without Vitest CommonJS interop', async () => {
  const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, '../../packages/adapters/src/ssh-authentication.ts')).href;
  // Node 24's type transform handles parameter properties but preserves native
  // package linking. A named import of ssh2.utils must fail this regression.
  const { stdout } = await promisify(execFile)(process.execPath,
    ['--experimental-transform-types', '--input-type=module', '--eval',
      `const module = await import(${JSON.stringify(moduleUrl)}); if (typeof module.onDemandAuthHandler !== 'function') throw new Error('Missing handler'); console.log('native-esm-ready');`],
    { timeout: 10000, maxBuffer: 65536 });
  expect(stdout.trim()).toBe('native-esm-ready');
});
