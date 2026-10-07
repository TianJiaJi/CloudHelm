import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';

/**
 * version.json is the single source of truth for the application version.
 * This script writes it and synchronises every workspace package.json plus the
 * README version note, so a release only ever needs one edited file.
 */

export const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
export const VERSION_FILE = 'version.json';
export const README_FILE = 'README.md';
export const PACKAGE_FILES = [
  'package.json',
  'apps/desktop/package.json',
  'packages/adapters/package.json',
  'packages/application/package.json',
  'packages/contracts/package.json',
  'packages/core/package.json'
];
const README_VERSION = /当前版本为 \*\*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u;

export function normalizeVersion(value) {
  const version = String(value ?? '').trim();
  if (!SEMVER_PATTERN.test(version)) throw new Error(`版本号不符合 semver：${version || '(空)'}`);
  return version;
}

export function parseVersionFile(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('version.json 不是合法 JSON'); }
  return normalizeVersion(parsed?.version);
}

export function packageWithVersion(text, version) {
  const parsed = JSON.parse(text);
  if (typeof parsed.version !== 'string') throw new Error('package.json 缺少 version 字段');
  // Surgical replacement keeps the original formatting of every other field;
  // the re-parse below proves the right field was rewritten.
  const updated = text.replace(/"version"\s*:\s*"[^"]*"/u, `"version": "${version}"`);
  if (JSON.parse(updated).version !== version) throw new Error('package.json 版本替换失败');
  return updated;
}

export function readmeWithVersion(text, version) {
  return text.replace(README_VERSION, `当前版本为 **${version}`);
}

/** Consistency report for --check; an empty array means everything matches. */
export function findInconsistencies(version, packageTexts, readmeText) {
  const problems = [];
  for (const [file, text] of packageTexts) {
    const parsed = JSON.parse(text);
    if (parsed.version !== version) problems.push(`${file} 的版本 ${parsed.version ?? '(缺失)'} 与 ${version} 不一致`);
  }
  if (readmeText !== undefined) {
    if (!README_VERSION.test(readmeText)) problems.push('README.md 未找到版本说明文字');
    else if (!readmeText.includes(`当前版本为 **${version}`)) problems.push(`README.md 的版本说明不是 ${version}`);
  }
  return problems;
}

/** File contents after synchronisation, keyed by repository-relative path. */
export function buildSyncedFiles(version, packageTexts, readmeText) {
  const files = new Map();
  for (const [file, text] of packageTexts) files.set(file, packageWithVersion(text, version));
  if (readmeText !== undefined) files.set(README_FILE, readmeWithVersion(readmeText, version));
  return files;
}

async function readInputs(root) {
  const packageTexts = new Map();
  for (const file of PACKAGE_FILES) packageTexts.set(file, await readFile(path.join(root, file), 'utf8'));
  const readmeText = await readFile(path.join(root, README_FILE), 'utf8');
  return { packageTexts, readmeText };
}

async function writeChanged(root, files) {
  const changed = [];
  for (const [file, text] of files) {
    const previous = await readFile(path.join(root, file), 'utf8');
    if (previous === text) continue;
    await writeFile(path.join(root, file), text);
    changed.push(file);
  }
  return changed;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const [argument] = process.argv.slice(2);
  const { packageTexts, readmeText } = await readInputs(root);
  const version = argument && argument !== '--check' ? normalizeVersion(argument) : parseVersionFile(await readFile(path.join(root, VERSION_FILE), 'utf8'));
  if (argument === '--check') {
    const problems = findInconsistencies(version, packageTexts, readmeText);
    if (problems.length) {
      for (const problem of problems) console.error(problem);
      console.error('运行 node scripts/set-version.mjs 同步版本号');
      process.exitCode = 1;
      return;
    }
    console.log(`版本一致：${version}`);
    return;
  }
  if (argument) {
    await writeFile(path.join(root, VERSION_FILE), `${JSON.stringify({ version }, null, 2)}\n`);
    console.log(`${VERSION_FILE} 已更新为 ${version}`);
  }
  const changed = await writeChanged(root, buildSyncedFiles(version, packageTexts, readmeText));
  console.log(changed.length ? `已同步：${changed.join('、')}` : '无需同步，版本已一致');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
