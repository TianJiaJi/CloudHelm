import { app, dialog } from 'electron';
import { dirname } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { quietBootstrapEntry } from './quiet-bootstrap-entry.mjs';
import { installQuietStartupGuards } from './quiet-desktop-runtime.mjs';

installQuietStartupGuards({ app, dialog });
const entry = quietBootstrapEntry(process.argv, fileURLToPath(import.meta.url));
// Preserve production resource resolution despite this test-only launcher.
app.setAppPath(dirname(entry));
await import(pathToFileURL(entry).href);
