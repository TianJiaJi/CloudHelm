import { app, dialog } from 'electron';
import { existsSync, watch } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { installQuietStartupGuards } from './quiet-desktop-runtime.mjs';

installQuietStartupGuards({ app, dialog });

// Isolated data before readiness; an event-driven file gate permits birth-identity capture.
if (!process.env.CLOUDHELM_USER_DATA || !process.argv[2] || !process.argv[3]) throw new Error('Missing synthetic profile fixture arguments');
if (process.env.CLOUDHELM_TEST_APP_NAME) app.setName(process.env.CLOUDHELM_TEST_APP_NAME);
app.setPath('userData', process.env.CLOUDHELM_USER_DATA);
const mark = (value) => process.stdout.write(`PROFILE_${value}\n`);
app.on('will-quit', () => mark('QUIT'));
app.on('browser-window-created', () => mark('WINDOW'));
let started = false;
const gate = process.argv[3];
const watcher = watch(dirname(gate), () => start());
function start() {
  if (started || !existsSync(gate)) return;
  started = true; watcher.close(); mark('IMPORT_STARTED');
  void import(pathToFileURL(process.argv[2]).href).then(() => mark('IMPORTED')).catch(() => { mark('IMPORT_FAILED'); app.exit(1); });
}
mark('READY'); start();
