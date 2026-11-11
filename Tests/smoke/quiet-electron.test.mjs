import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { URL } from 'node:url';
import { quietDesktopEnvironment, quietElectron, QUIET_DESKTOP_PROTOCOL } from './quiet-electron.mjs';
import { _electron } from '@playwright/test';

vi.mock('@playwright/test', () => ({ _electron: { launch: vi.fn(async (options) => options) } }));
const directories = [];
afterEach(async () => { vi.clearAllMocks(); await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture(source = QUIET_DESKTOP_PROTOCOL) {
  const directory = await mkdtemp(join(tmpdir(), 'cloudhelm-quiet-unit-')); directories.push(directory);
  const entry = join(directory, 'synthetic-main.js'); await writeFile(entry, source);
  const executablePath = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))('electron');
  return { entry, environment: { CLOUDHELM_USER_DATA: directory }, executablePath };
}

describe('quiet launch preflight without starting Electron', () => {
  it('rejects stale builds and packaged launches before calling the launcher', async () => {
    const f = await fixture('synthetic old build');
    await expect(quietElectron.launch({ executablePath: f.executablePath, args: [f.entry], env: f.environment })).rejects.toThrow('Rebuild');
    await expect(quietElectron.launch({ args: [], env: f.environment })).rejects.toThrow('development entry');
    expect(_electron.launch).not.toHaveBeenCalled();
  });
  it('rejects missing/relative profiles, entries and substituted executables', async () => {
    const f = await fixture();
    for (const profile of [undefined, '', 'relative']) {
      await expect(quietDesktopEnvironment({ CLOUDHELM_USER_DATA: profile }, f.entry)).rejects.toThrow('profile');
    }
    await expect(quietDesktopEnvironment(f.environment, 'relative.js')).rejects.toThrow('absolute');
    await expect(quietElectron.launch({ executablePath: f.entry, args: [f.entry], env: f.environment })).rejects.toThrow('development Electron');
    expect(_electron.launch).not.toHaveBeenCalled();
  });
  it('installs the startup guard before the entry and strips inherited injection/debug/secret settings', async () => {
    const f = await fixture();
    const options = await quietElectron.launch({ executablePath: f.executablePath, args: [f.entry], env: { ...f.environment,
      NODE_OPTIONS: 'synthetic-injection', ELECTRON_RENDERER_URL: 'synthetic-server', SYNTHETIC_API_KEY: 'synthetic-not-a-key', PATH: 'synthetic-path' }, timeout: 123 });
    expect(options.args[0].replaceAll('\\', '/')).toMatch(/Tests\/smoke\/quiet-desktop-bootstrap\.mjs$/u);
    expect(options.args[1]).toBe(f.entry); expect(options.timeout).toBe(123);
    expect(options.env).toEqual({ ...f.environment, CLOUDHELM_TEST_WINDOW: QUIET_DESKTOP_PROTOCOL, PATH: 'synthetic-path' });
    expect(_electron.launch).toHaveBeenCalledOnce(); // Mock only; no native process.
  });
});
