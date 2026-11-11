import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { _electron } from '@playwright/test';

export const QUIET_DESKTOP_PROTOCOL = 'cloudhelm-quiet-desktop-v1';
const bootstrap = fileURLToPath(new URL('./quiet-desktop-bootstrap.mjs', import.meta.url));
const developmentElectron = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))('electron');

/** Reject stale development bundles BEFORE launching. This is not artifact authentication. */
export async function quietDesktopEnvironment(environment, entry) {
  if (!entry || !isAbsolute(entry)) throw new Error('Quiet desktop tests require an absolute development entry; packaged testing is not enabled');
  if (!environment?.CLOUDHELM_USER_DATA || !isAbsolute(environment.CLOUDHELM_USER_DATA)) {
    throw new Error('Quiet desktop tests require an isolated absolute profile');
  }
  const built = await readFile(entry, 'utf8');
  if (!built.includes(QUIET_DESKTOP_PROTOCOL)) throw new Error('Rebuild CloudHelm with quiet desktop support before testing');
  const env = { ...environment, CLOUDHELM_TEST_WINDOW: QUIET_DESKTOP_PROTOCOL };
  for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD/u.test(key)
    || ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS', 'NODE_DEBUG', 'DEBUG'].includes(key)) delete env[key];
  return env;
}

export const quietElectron = {
  async launch(options) {
    if (options.args?.length !== 1) throw new Error('Only a checked development entry is supported by quiet desktop tests');
    if (await realpath(options.executablePath) !== await realpath(developmentElectron)) {
      throw new Error('Quiet tests only support the workspace development Electron executable');
    }
    const entry = options.args[0];
    const env = await quietDesktopEnvironment(options.env, entry);
    return _electron.launch({ ...options, args: [bootstrap, entry], env });
  }
};
