import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const here = import.meta.dirname;
const workspacePackages = ['@cloudhelm/contracts', '@cloudhelm/core', '@cloudhelm/application', '@cloudhelm/adapters'];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePackages }), { name: 'pi-extension-notices', generateBundle() {
      for (const name of ['LICENSE', 'NOTICE']) this.emitFile({ type: 'asset', fileName: `pi-extensions/ask-user/${name}`,
        source: readFileSync(resolve(here, '../../packages/adapters/src/pi-extensions/ask-user', name), 'utf8') });
    } }],
    build: { rollupOptions: { input: {
      index: resolve(here, 'src/main/index.ts'),
      runtime: resolve(here, 'src/worker/runtime.ts')
    } } }
  },
  preload: { plugins: [externalizeDepsPlugin()], build: { rollupOptions: { input: resolve(here, 'src/preload/index.ts'), output: { format: 'cjs', entryFileNames: '[name].cjs' } } } },
  renderer: { root: resolve(here, 'src/renderer'), build: { rollupOptions: { input: resolve(here, 'src/renderer/index.html') } } }
});
