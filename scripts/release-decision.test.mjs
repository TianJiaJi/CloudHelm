import { describe, expect, it } from 'vitest';
import { decideRelease, parseFlag } from './release-decision.mjs';

describe('release decision', () => {
  it('publishes only when version.json changed and the tag is still new', () => {
    expect(decideRelease({ version: '0.2.0', versionFileChanged: true, tagExists: false }))
      .toMatchObject({ shouldPublish: true, tag: 'v0.2.0', reason: expect.stringContaining('发布 v0.2.0') });
    expect(decideRelease({ version: '0.2.0', versionFileChanged: false, tagExists: false }))
      .toMatchObject({ shouldPublish: false, reason: expect.stringContaining('未更新 version.json') });
    expect(decideRelease({ version: '0.2.0', versionFileChanged: true, tagExists: true }))
      .toMatchObject({ shouldPublish: false, reason: expect.stringContaining('已存在') });
    expect(decideRelease({ version: '0.2.0', versionFileChanged: false, tagExists: true }))
      .toMatchObject({ shouldPublish: false });
  });

  it('never publishes without a usable version', () => {
    expect(decideRelease({ version: '', versionFileChanged: true, tagExists: false })).toMatchObject({ shouldPublish: false, reason: '缺少版本号' });
  });

  it('tags prerelease versions under their own name', () => {
    expect(decideRelease({ version: '0.2.0-beta.1', versionFileChanged: true, tagExists: false }).tag).toBe('v0.2.0-beta.1');
  });

  it('reads boolean flags the way GitHub Actions writes them', () => {
    expect(parseFlag('true')).toBe(true);
    expect(parseFlag('TRUE')).toBe(true);
    expect(parseFlag('false')).toBe(false);
    expect(parseFlag('')).toBe(false);
    expect(parseFlag(undefined)).toBe(false);
  });
});
