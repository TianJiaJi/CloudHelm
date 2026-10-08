import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { parseVersionFile } from './set-version.mjs';

/**
 * Decides whether a CI run should publish the built installers to GitHub
 * Releases: only when the matching tag does not exist yet and either this push
 * changed version.json or the run was dispatched with force_publish (补发).
 * Every other push builds without publishing.
 */

export function parseFlag(value) {
  return String(value ?? '').trim().toLowerCase() === 'true';
}

export function decideRelease({ version, versionFileChanged, tagExists, forcePublish }) {
  const normalized = String(version ?? '').trim();
  const tag = `v${normalized}`;
  if (!normalized) return { shouldPublish: false, tag, version: normalized, reason: '缺少版本号' };
  if (tagExists) return { shouldPublish: false, tag, version: normalized, reason: `标签 ${tag} 已存在，只构建不发布` };
  if (forcePublish) return { shouldPublish: true, tag, version: normalized, reason: `补发 ${tag}（预发布）` };
  if (!versionFileChanged) return { shouldPublish: false, tag, version: normalized, reason: '本次推送未更新 version.json，只构建不发布' };
  return { shouldPublish: true, tag, version: normalized, reason: `发布 ${tag}（预发布）` };
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const version = parseVersionFile(readFileSync(path.join(root, 'version.json'), 'utf8'));
  const decision = decideRelease({
    version,
    versionFileChanged: parseFlag(process.env.VERSION_FILE_CHANGED),
    tagExists: parseFlag(process.env.TAG_EXISTS),
    forcePublish: parseFlag(process.env.FORCE_PUBLISH)
  });
  const lines = [`should-publish=${decision.shouldPublish}`, `tag=${decision.tag}`, `version=${decision.version}`, `reason=${decision.reason}`];
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
