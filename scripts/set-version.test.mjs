import { describe, expect, it } from 'vitest';
import {
  buildSyncedFiles, findInconsistencies, normalizeVersion, packageWithVersion, parseVersionFile, readmeWithVersion
} from './set-version.mjs';

const packageText = (version) => JSON.stringify({ name: 'cloudhelm', private: true, version, scripts: { dev: 'x' } }, null, 2);

describe('version file synchronisation', () => {
  it('accepts semver versions and rejects anything else', () => {
    expect(normalizeVersion('0.2.0')).toBe('0.2.0');
    expect(normalizeVersion(' 1.0.0-beta.1 ')).toBe('1.0.0-beta.1');
    for (const value of ['v0.2.0', '0.2', '0.2.0.1', '', 'latest', 42]) {
      expect(() => normalizeVersion(value)).toThrow();
    }
  });

  it('reads the version from version.json and rejects malformed files', () => {
    expect(parseVersionFile('{"version": "2.3.4"}')).toBe('2.3.4');
    expect(() => parseVersionFile('{ nope')).toThrow('version.json 不是合法 JSON');
    expect(() => parseVersionFile('{"version": "two"}')).toThrow();
    expect(() => parseVersionFile('{}')).toThrow();
  });

  it('rewrites only the version field of package.json without reformatting', () => {
    const updated = packageWithVersion(packageText('0.1.0'), '0.2.0');
    const parsed = JSON.parse(updated);
    expect(parsed.version).toBe('0.2.0');
    expect(parsed.name).toBe('cloudhelm');
    expect(parsed.scripts).toEqual({ dev: 'x' });
    expect(updated.replace('0.2.0', '0.1.0')).toBe(packageText('0.1.0'));
    const compact = '{ "name": "x", "version": "0.1.0", "exports": { ".": "./src/index.ts" } }\n';
    expect(packageWithVersion(compact, '0.2.0'))
      .toBe('{ "name": "x", "version": "0.2.0", "exports": { ".": "./src/index.ts" } }\n');
    expect(() => packageWithVersion('{ "name": "x" }', '0.2.0')).toThrow();
  });

  it('updates the README version note while keeping the suffix wording', () => {
    const readme = '# CloudHelm\n\n当前版本为 **0.1.0，开发中**，采用 AGPL。\n';
    expect(readmeWithVersion(readme, '0.2.0')).toContain('当前版本为 **0.2.0，开发中**');
    expect(readmeWithVersion(readme, '0.2.0')).toContain('采用 AGPL。');
  });

  it('reports package and README drift in check mode', () => {
    const good = new Map([['package.json', packageText('0.2.0')]]);
    const readme = '当前版本为 **0.2.0，开发中**';
    expect(findInconsistencies('0.2.0', good, readme)).toEqual([]);
    expect(findInconsistencies('0.2.0', new Map([['package.json', packageText('0.1.0')]]), readme))
      .toEqual(['package.json 的版本 0.1.0 与 0.2.0 不一致']);
    expect(findInconsistencies('0.2.0', good, '当前版本为 **0.1.0，开发中**')).toEqual(['README.md 的版本说明不是 0.2.0']);
    expect(findInconsistencies('0.2.0', good, '# 无版本说明')).toEqual(['README.md 未找到版本说明文字']);
    expect(findInconsistencies('0.2.0', good, undefined)).toEqual([]);
  });

  it('builds the full synchronised file set', () => {
    const files = buildSyncedFiles('0.3.0', new Map([['package.json', packageText('0.1.0')]]), '当前版本为 **0.1.0，开发中**');
    expect([...files.keys()]).toEqual(['package.json', 'README.md']);
    expect(JSON.parse(files.get('package.json')).version).toBe('0.3.0');
    expect(files.get('README.md')).toContain('当前版本为 **0.3.0');
  });
});
