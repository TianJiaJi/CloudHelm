import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CHANGELOG_ENTRY, defaultEntryMarkdown, extractReleaseNotes, checkChangelog,
  formatDate, hasVersionEntry, parseChangelogSections, withDefaultEntry
} from './changelog.mjs';

const run = promisify(execFile);
const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'changelog.mjs');

const changelogText = [
  '# 更新日志',
  '',
  '编写约定……',
  '',
  '<!-- 小节模板',
  '## 0.9.9 - 2099-01-01',
  '- 模板假条目',
  '-->',
  '',
  '## 0.3.1 - 2026-03-01',
  '',
  '### 新增',
  '',
  '- 新功能甲',
  '',
  '## 0.3.0 - 2026-02-14',
  '',
  '### 修复',
  '',
  '- 修复乙',
  ''
].join('\n');

describe('parseChangelogSections', () => {
  it('按倒序解析版本小节与正文，忽略 HTML 注释里的模板标题', () => {
    const sections = parseChangelogSections(changelogText);
    expect(sections.map((section) => section.version)).toEqual(['0.3.1', '0.3.0']);
    expect(sections[0].body).toBe('### 新增\n\n- 新功能甲');
    expect(sections[1].body).toBe('### 修复\n\n- 修复乙');
  });

  it('容忍 v 前缀、方括号和省略日期的标题', () => {
    const text = '## v0.4.0\n\n- 甲\n\n## [0.4.1] - 2026-04-01\n\n- 乙\n';
    expect(parseChangelogSections(text).map((section) => section.version)).toEqual(['0.4.0', '0.4.1']);
  });

  it('空文本与无小节文本返回空列表', () => {
    expect(parseChangelogSections('')).toEqual([]);
    expect(parseChangelogSections('# 只有说明\n\n- 没有版本小节\n')).toEqual([]);
  });
});

describe('extractReleaseNotes', () => {
  it('提取指定版本正文，支持 v 前缀查询', () => {
    expect(extractReleaseNotes(changelogText, '0.3.1')).toBe('### 新增\n\n- 新功能甲');
    expect(extractReleaseNotes(changelogText, 'v0.3.0')).toBe('### 修复\n\n- 修复乙');
  });

  it('缺条目或小节为空时返回空字符串，交给调用方回退默认说明', () => {
    expect(extractReleaseNotes(changelogText, '0.9.0')).toBe('');
    expect(extractReleaseNotes('## 1.0.0 - 2026-01-01\n\n', '1.0.0')).toBe('');
    expect(extractReleaseNotes('', '1.0.0')).toBe('');
  });

  it('正文尾部的小节模板注释不进入发布正文', () => {
    const text = '## 0.3.0 - 2026-02-14\n\n### 修复\n\n- 修复乙\n\n<!-- 模板\n## 0.9.9 - 2099-01-01\n- 假\n-->\n';
    expect(extractReleaseNotes(text, '0.3.0')).toBe('### 修复\n\n- 修复乙');
  });
});

describe('checkChangelog', () => {
  it('条目齐全时没有提醒', () => {
    expect(checkChangelog('0.3.1', changelogText)).toEqual([]);
    expect(checkChangelog('v0.3.0', changelogText)).toEqual([]);
  });

  it('缺条目或小节为空只给提醒，不抛错', () => {
    expect(checkChangelog('0.4.0', changelogText)).toHaveLength(1);
    expect(checkChangelog('0.4.0', changelogText)[0]).toContain('0.4.0');
    expect(checkChangelog('1.0.0', '## 1.0.0 - 2026-01-01\n\n')).toHaveLength(1);
  });
});

describe('withDefaultEntry', () => {
  it('缺条目时把默认小节插到已有小节之前', () => {
    const updated = withDefaultEntry(changelogText, '0.4.0', new Date('2026-05-01T12:00:00'));
    const sections = parseChangelogSections(updated);
    expect(sections.map((section) => section.version)).toEqual(['0.4.0', '0.3.1', '0.3.0']);
    expect(sections[0].body).toBe(`### 修复\n\n- ${DEFAULT_CHANGELOG_ENTRY}`);
    expect(updated).toContain('## 0.4.0 - 2026-05-01');
    // 默认小节插在注释模板之后、真实小节之前，不能落进模板注释里。
    expect(updated.indexOf('## 0.4.0')).toBeGreaterThan(updated.indexOf('-->'));
  });

  it('没有已有小节时追加到文件末尾，且不覆盖已有条目', () => {
    const appended = withDefaultEntry('# 更新日志\n\n说明\n', '0.3.0', new Date('2026-05-01T12:00:00'));
    expect(appended.endsWith(`## 0.3.0 - 2026-05-01\n\n### 修复\n\n- ${DEFAULT_CHANGELOG_ENTRY}\n`)).toBe(true);
    expect(withDefaultEntry(changelogText, '0.3.1', new Date('2026-05-01T12:00:00'))).toBe(changelogText);
    expect(hasVersionEntry(appended, '0.3.0')).toBe(true);
  });
});

describe('defaultEntryMarkdown / formatDate', () => {
  it('默认小节是「修复」分类加默认条目，日期为 YYYY-MM-DD', () => {
    expect(defaultEntryMarkdown('0.3.0', new Date('2026-02-14T12:00:00')))
      .toBe(`## 0.3.0 - 2026-02-14\n\n### 修复\n\n- ${DEFAULT_CHANGELOG_ENTRY}\n`);
    expect(formatDate(new Date('2026-01-02T12:00:00'))).toBe('2026-01-02');
  });
});

describe('CLI', () => {
  it('--check 只提醒不拦截（退出码恒为 0）', async () => {
    const { stdout } = await run(process.execPath, [scriptPath, '--check']).catch((error) => error);
    expect(stdout.trim().length).toBeGreaterThan(0);
  });

  it('缺条目版本输出空正文且退出码为 0', async () => {
    const { stdout, code } = await run(process.execPath, [scriptPath, '9.9.9']).catch((error) => error);
    expect(stdout).toBe('');
    expect(code ?? 0).toBe(0);
  });

  it('缺少参数时报用法并退出码为 1', async () => {
    const { code, stderr } = await run(process.execPath, [scriptPath]).catch((error) => error);
    expect(code ?? 0).toBe(1);
    expect(stderr).toContain('用法');
  });
});
