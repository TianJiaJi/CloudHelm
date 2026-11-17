import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const document = (name: string) => readFileSync(new URL(`../../docs/${name}.md`, import.meta.url), 'utf8');
const ids = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((match) => match[1]);
const parents = Object.entries({ A: 7, B: 8, C: 7, D: 3, E: 4, F: 6, G: 2, H: 5 })
  .flatMap(([prefix, count]) => Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1).padStart(2, '0')}`));
const packages = Array.from({ length: 12 }, (_, index) => `U${String(index + 1).padStart(2, '0')}`);

describe('complete remediation tracking (not proof of product acceptance)', () => {
  it('keeps exactly all 42 parent IDs in both the audit and implementation ledger', () => {
    for (const name of ['PROJECT_REMEDIATION_SUMMARY', 'REPAIR_PROGRESS', 'REPAIR_STATUS_OVERVIEW']) {
      expect(ids(document(name), /^\| ([A-H]\d{2}) \|/gmu), name).toEqual(parents);
    }
  });

  it('keeps exactly all 12 UI packages in both the plan and implementation ledger', () => {
    for (const name of ['AI_UI_REMEDIATION_PLAN', 'REPAIR_PROGRESS', 'REPAIR_STATUS_OVERVIEW']) {
      expect(ids(document(name), /^\| (U\d{2}) \|/gmu), name).toEqual(packages);
    }
  });

  it('keeps the concise overview statuses and totals identical to the detailed ledger', () => {
    const ledger = document('REPAIR_PROGRESS'), overview = document('REPAIR_STATUS_OVERVIEW');
    const statuses = (text: string, pattern: RegExp, column: number) => new Map(text.split('\n')
      .filter((row) => pattern.test(row)).map((row) => {
        const cells = row.split('|').map((cell) => cell.trim());
        return [cells[1]!, cells[column]!] as const;
      }));
    const expected = statuses(ledger, /^\| [A-H]\d{2} \|/u, 4);
    expect([...statuses(overview, /^\| [A-H]\d{2} \|/u, 3)]).toEqual([...expected]);
    expect([...statuses(overview, /^\| U\d{2} \|/u, 3)])
      .toEqual([...statuses(ledger, /^\| U\d{2} \|/u, 3)]);
    for (const status of ['已完成', '已实现待验收', '进行中', '待开始', '延期转新版']) {
      const count = [...expected.values()].filter((value) => value === status).length;
      expect(overview).toContain(`| ${status} | ${count} |`);
    }
  });

  it('excludes transferred scope from old-version remaining work without counting it as completed', () => {
    const ledger = document('REPAIR_PROGRESS'), overview = document('REPAIR_STATUS_OVERVIEW');
    const rows = ledger.split('\n').filter((row) => /^\| [A-H]\d{2} \|/u.test(row))
      .map((row) => row.split('|').map((cell) => cell.trim()));
    const transferred = rows.filter((row) => row[4] === '延期转新版');
    expect(transferred.map((row) => row[1])).toEqual(['F05', 'G01', 'G02']);
    const active = rows.filter((row) => row[4] !== '延期转新版');
    expect(active).toHaveLength(39);
    expect(active.filter((row) => row[4] === '已完成')).toHaveLength(4);
    expect(active.filter((row) => row[4] === '已实现待验收')).toHaveLength(33);
    const remaining = active.filter((row) => ['进行中', '待开始'].includes(row[4]!));
    expect(remaining.map((row) => row[1])).toEqual([
      'H02', 'H03'
    ]);
    expect(ids(overview, /^\| \d+ \| ([A-H]\d{2}) \|/gmu)).toEqual(remaining.map((row) => row[1]));
    const uiRows = ledger.split('\n').filter((row) => /^\| U\d{2} \|/u.test(row))
      .map((row) => row.split('|').map((cell) => cell.trim()));
    expect(uiRows.filter((row) => row[3] === '延期转新版').map((row) => row[1])).toEqual(['U06']);
    expect(uiRows.filter((row) => row[3] !== '延期转新版')).toHaveLength(11);
    expect(overview).toContain('仍需推进2项');
    expect(overview).toContain('不计旧版剩余，不算完成');
  });

  it('does not label unaccepted parent items or UI packages as completed', () => {
    for (const row of document('REPAIR_PROGRESS').split('\n').filter((line) => /^\| [A-HU]\d{2} \|/u.test(line))) {
      const cells = row.split('|').map((value) => value.trim());
      if (!cells.includes('已完成')) continue;
      expect(cells.at(-2), row).not.toMatch(/未验收|待验证|待实现/u);
      expect(cells.at(-2), row).toContain('Tests/');
    }
  });
});
