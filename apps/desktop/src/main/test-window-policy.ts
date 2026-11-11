import { isAbsolute, resolve } from 'node:path';
import type { App, BrowserWindowConstructorOptions, Dialog, MessageBoxOptions } from 'electron';

/** Process-local test configuration, never a renderer-controlled preference. */
export const QUIET_DESKTOP_PROTOCOL = 'cloudhelm-quiet-desktop-v1';

export function testWindowPolicy(env: Readonly<Record<string, string | undefined>>, normalProfile: string): {
  hidden: boolean; options: BrowserWindowConstructorOptions;
} {
  if (env.CLOUDHELM_TEST_WINDOW === undefined) {
    return { hidden: false, options: {} as BrowserWindowConstructorOptions };
  }
  if (env.CLOUDHELM_TEST_WINDOW !== QUIET_DESKTOP_PROTOCOL) throw new Error('Invalid quiet desktop test mode');
  const profile = env.CLOUDHELM_USER_DATA;
  if (!profile || !isAbsolute(profile) || resolve(profile).toLowerCase() === resolve(normalProfile).toLowerCase()) {
    throw new Error('Quiet desktop tests require a separate absolute profile');
  }
  return { hidden: true, options: {
    show: false, focusable: false, skipTaskbar: true,
    fullscreenable: false, maximizable: false, minimizable: false,
    paintWhenInitiallyHidden: true
  } satisfies BrowserWindowConstructorOptions };
}

/** A bootstrap may already have set userData; that is not the application's default profile. */
export function applicationTestWindowPolicy(env: Readonly<Record<string, string | undefined>>, app: Pick<App, 'getPath' | 'getName'>) {
  return testWindowPolicy(env, resolve(app.getPath('appData'), app.getName()));
}

/** Unstubbed native UI fails/cancels; a test may explicitly replace these with synthetic results. */
export function silenceTestDialogs(dialog: Pick<Dialog, 'showOpenDialog' | 'showOpenDialogSync' | 'showSaveDialog'
  | 'showSaveDialogSync' | 'showMessageBox' | 'showMessageBoxSync' | 'showErrorBox'>): void {
  dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  dialog.showOpenDialogSync = () => undefined;
  dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' });
  dialog.showSaveDialogSync = () => '';
  const cancel = (args: unknown[]) => {
    const options = args.at(-1) as MessageBoxOptions | undefined;
    const id = options?.cancelId;
    if (!Number.isInteger(id) || id! < 0 || id! >= (options?.buttons?.length ?? 0)) {
      throw new Error('Native confirmation without explicit cancellation is forbidden in quiet tests');
    }
    return id!;
  };
  dialog.showMessageBox = async (...args: unknown[]) => ({ response: cancel(args), checkboxChecked: false });
  dialog.showMessageBoxSync = (...args: unknown[]) => cancel(args);
  dialog.showErrorBox = () => { throw new Error('Native error dialogs are forbidden in quiet tests'); };
}
