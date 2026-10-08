import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';

import { VERSION_FILE, parseVersionFile } from './set-version.mjs';

/**
 * CHANGELOG.md 是版本更新说明的唯一来源（见文件内编写约定）。
 * - 提取：发布时取指定版本小节正文作为 GitHub Release 说明（附加自动提交清单）；
 * - 提醒：版本缺少条目只提醒不拦截，提取不到正文时由调用方回退默认说明；
 * - 补写：pre-commit 钩子在升版提交缺条目时用 DEFAULT_CHANGELOG_ENTRY 自动补默认条目。
 */

export const CHANGELOG_FILE = 'CHANGELOG.md';
export const DEFAULT_CHANGELOG_ENTRY = '修复了一些已知问题';

/** 版本小节标题：`## 0.3.0 - YYYY-MM-DD`（日期可省略，允许 v 前缀与方括号）。 */
export const SECTION_HEADING = /^## \[?v?(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\]?(?:\s+-\s+.*)?$/u;

/** 去掉 HTML 注释（CHANGELOG.md 末尾的小节模板），避免模板内容混入发布正文。 */
export function stripHtmlComments(text) {
  return String(text ?? '').replace(/<!--[\s\S]*?-->/gu, '');
}

/**
 * 按行扫描出版本小节（忽略 HTML 注释内的标题），返回
 * [{ version, headingLine, body }]，body 为标题到下一小节之间的正文（去注释后 trim）。
 */
export function parseChangelogSections(text) {
  const lines = String(text ?? '').split('\n');
  const headings = [];
  let inComment = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (inComment) {
      if (line.includes('-->')) inComment = false;
      continue;
    }
    if (/^\s*<!--/u.test(line)) {
      // 单行注释直接跳过；跨行注释进入注释状态。
      if (!line.includes('-->')) inComment = true;
      continue;
    }
    const matched = SECTION_HEADING.exec(line.trim());
    if (matched) headings.push({ version: matched.groups.version, headingLine: i });
  }
  return headings.map((heading, index) => {
    const bodyStart = heading.headingLine + 1;
    const bodyEnd = index + 1 < headings.length ? headings[index + 1].headingLine : lines.length;
    return { version: heading.version, headingLine: heading.headingLine, body: stripHtmlComments(lines.slice(bodyStart, bodyEnd).join('\n')).trim() };
  });
}

/** 指定版本是否有非空小节。 */
export function hasVersionEntry(text, version) {
  const wanted = String(version ?? '').trim().replace(/^v/u, '');
  return parseChangelogSections(text).some((section) => section.version === wanted && section.body);
}

/** 提取指定版本小节正文；缺失或为空时返回空字符串（调用方回退默认说明）。 */
export function extractReleaseNotes(text, version) {
  const wanted = String(version ?? '').trim().replace(/^v/u, '');
  const section = parseChangelogSections(text).find((item) => item.version === wanted);
  return section?.body ?? '';
}

/** 缺条目提醒列表；条目齐全时为空数组。只提醒，不作为失败依据。 */
export function checkChangelog(version, text) {
  const wanted = String(version ?? '').trim();
  const sections = parseChangelogSections(text);
  const section = sections.find((item) => item.version === wanted.replace(/^v/u, ''));
  if (!section) return [`CHANGELOG.md 缺少版本 ${wanted} 的更新条目（发布说明将回退为自动生成；提交升版时钩子会自动补默认条目）`];
  if (!section.body) return [`CHANGELOG.md 中版本 ${wanted} 的小节为空（发布说明将回退为自动生成）`];
  return [];
}

/** `YYYY-MM-DD`（本地日期）。 */
export function formatDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 默认小节正文：`## <版本> - 日期` + 修复分类 + 默认条目。 */
export function defaultEntryMarkdown(version, date = new Date()) {
  return `## ${version} - ${formatDate(date)}\n\n### 修复\n\n- ${DEFAULT_CHANGELOG_ENTRY}\n`;
}

/** 缺条目时把默认小节插到已有版本小节之前（倒序最新在上）；无小节时追加到文件末尾。 */
export function withDefaultEntry(text, version, date = new Date()) {
  const wanted = String(version ?? '').trim().replace(/^v/u, '');
  if (hasVersionEntry(text, version)) return String(text ?? '');
  const section = defaultEntryMarkdown(wanted, date);
  const normalized = String(text ?? '');
  const lines = normalized.split('\n');
  const firstHeadingLine = parseChangelogSections(normalized)[0]?.headingLine;
  if (firstHeadingLine === undefined) {
    const base = normalized.endsWith('\n') || normalized === '' ? normalized : `${normalized}\n`;
    return `${base}\n${section}`;
  }
  return `${lines.slice(0, firstHeadingLine).join('\n')}\n${section}\n${lines.slice(firstHeadingLine).join('\n')}`;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const [argument] = process.argv.slice(2);
  const text = await readFile(path.join(root, CHANGELOG_FILE), 'utf8');
  if (argument === '--check') {
    const version = parseVersionFile(await readFile(path.join(root, VERSION_FILE), 'utf8'));
    const reminders = checkChangelog(version, text);
    if (reminders.length) {
      for (const reminder of reminders) console.log(reminder);
      return;
    }
    console.log(`更新日志条目齐全：${version}`);
    return;
  }
  if (!argument) {
    console.error('用法：node scripts/changelog.mjs <版本>（输出该版本小节正文）或 --check（提醒缺条目）');
    process.exitCode = 1;
    return;
  }
  // 发布用：正文写入 stdout；缺条目时输出为空，由 CI 回退默认说明。
  process.stdout.write(extractReleaseNotes(text, argument));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
