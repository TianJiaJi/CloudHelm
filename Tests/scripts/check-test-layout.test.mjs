import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { findMisplacedTests } from '../../scripts/check-test-layout.mjs';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(files) {
  const root = await mkdtemp(path.join(tmpdir(), 'cloudhelm-test-layout-'));
  roots.push(root);
  for (const file of files) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), '');
  }
  return root;
}

it('allows centralized tests, smoke scripts and test fixtures', async () => {
  const root = await fixture(['Tests/core/safety.test.ts', 'Tests/smoke/ui-fixture/main.tsx']);
  expect(await findMisplacedTests(root)).toEqual([]);
});
it('finds misplaced tests and test fixtures without reading their contents', async () => {
  const root = await fixture(['packages/core/src/safety.test.ts', 'apps/desktop/src/worker/model-fixture.ts', 'scripts/version.spec.mjs']);
  expect(await findMisplacedTests(root)).toEqual(['apps/desktop/src/worker/model-fixture.ts', 'packages/core/src/safety.test.ts', 'scripts/version.spec.mjs']);
});
it('finds legacy test-only directories and root tests', async () => {
  const root = await fixture(['apps/desktop/__tests__/case.ts', 'scripts/ui-fixture/main.tsx', 'stray.test.ts']);
  expect(await findMisplacedTests(root)).toEqual(['apps/desktop/__tests__/', 'scripts/ui-fixture/', 'stray.test.ts']);
});
it('does not confuse the product connection-test feature or engineering checks with tests', async () => {
  const root = await fixture(['apps/desktop/src/main/host-connection-test.ts', 'scripts/check-test-layout.mjs', 'scripts/check-lines.mjs']);
  expect(await findMisplacedTests(root)).toEqual([]);
});
it('ignores dependencies, local state and generated artifacts', async () => {
  const root = await fixture(['node_modules/pkg/a.test.ts', '.cache/probe.test.ts', '.pi/check.test.ts', 'apps/desktop/out/b.test.js', 'apps/desktop/dist/c.spec.js']);
  expect(await findMisplacedTests(root)).toEqual([]);
});
