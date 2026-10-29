import { expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { URL } from 'node:url';
import { CASES, METRICS, compareRuns, comparisonCli, comparisonTemplate } from './agent-task-comparison.mjs';
function run(revision = 'fixture-before') {
  const value = comparisonTemplate(); value.sourceRevision = revision;
  value.environment = { provider: 'cloudhelm-custom', modelId: 'fixture', effectiveThinking: 'off', reviewMode: 'ask',
    contextWindow: 32000, maxOutputTokens: 8192, hostSnapshot: 'same-disposable-snapshot', toolCount: 13 };
  value.results[0].status = 'completed';
  value.results[0].metrics = Object.fromEntries(METRICS.map((key) => [key, 0]));
  value.results[0].metrics.conversationAttempts = 2;
  return value;
}
it('generates only an unexecuted manual protocol with no invented counts or acceptance', async () => {
  const template = await comparisonCli([]);
  expect(template.executionPolicy).toContain('no model, SSH, network or shell execution');
  expect(template.cases).toEqual(CASES); expect(template.environment.provider).toBeNull();
  for (const result of template.results) {
    expect(result.status).toBe('not-run'); expect(Object.values(result.metrics).every((count) => count === null)).toBe(true);
    expect(result.evidenceAccuracy).toBe('not-reviewed');
  }
  await expect(comparisonCli(['--run'])).rejects.toThrow('No execution mode');
});
it('compares fixed-environment manual metrics without equating lower counts with semantic success', () => {
  const before = run(), after = run('fixture-after'); after.results[0].metrics.conversationAttempts = 1;
  after.results[0].evidenceAccuracy = 'fail';
  const result = compareRuns(before, after);
  expect(result.results[0].delta.conversationAttempts).toBe(-1);
  expect(result.results[0].afterEvidenceAccuracy).toBe('fail'); expect(result.semanticAcceptance).toContain('manual-review-required');
  expect(result.results[1].delta.conversationAttempts).toBeNull(); expect(before.results[0].metrics.conversationAttempts).toBe(2);
});
it('keeps unknown completed-case measurements unknown, not zero', () => {
  const before = run(), after = run('fixture-after'); after.results[0].metrics.remoteCommands = null;
  expect(compareRuns(before, after).results[0].delta.remoteCommands).toBeNull();
});
it.each(['provider', 'modelId', 'effectiveThinking', 'reviewMode', 'contextWindow', 'maxOutputTokens', 'hostSnapshot'])(
  'rejects environment drift in %s instead of claiming a comparable run', (field) => {
    const before = run(), after = run('fixture-after');
    after.environment[field] = { provider: 'other', modelId: 'other', effectiveThinking: 'high', reviewMode: 'permissive',
      contextWindow: 64000, maxOutputTokens: 16000, hostSnapshot: 'changed-snapshot' }[field];
    expect(() => compareRuns(before, after)).toThrow('must match');
  });
it('rejects unknown fields/credentials, grades for unexecuted cases, changed prompts and invented counts', () => {
  const before = run(); let after = run('fixture-after'); after.environment.apiKey = 'private-never-echo';
  expect(() => compareRuns(before, after)).toThrow('unsupported fields');
  after = run('fixture-after'); after.results[1].evidenceAccuracy = 'pass'; expect(() => compareRuns(before, after)).toThrow('cannot be graded');
  after = run('fixture-after'); after.cases[0].prompt = 'changed'; expect(() => compareRuns(before, after)).toThrow('unchanged');
  for (const count of [-1, 1.5, NaN, Infinity, 1_000_001]) {
    after = run('fixture-after'); after.results[0].metrics.conversationAttempts = count;
    expect(() => compareRuns(before, after)).toThrow('bounded nonnegative');
  }
  after = run('fixture-after'); after.results[1].metrics.conversationAttempts = 0;
  expect(() => compareRuns(before, after)).toThrow('unexecuted');
});
it('reads only explicitly provided bounded UTF-8 metadata files and never echoes invalid file bodies', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cloudhelm-comparison-'));
  try {
    const before = path.join(directory, 'before.json'), after = path.join(directory, 'after.json');
    await writeFile(before, JSON.stringify(run())); await writeFile(after, JSON.stringify(run('fixture-after')));
    expect((await comparisonCli(['--compare', before, after])).results).toHaveLength(5);
    await writeFile(after, 'private-file-body-not-JSON');
    await expect(comparisonCli(['--compare', before, after])).rejects.toThrow('no file body is printed');
    await writeFile(after, 'x'.repeat(70000));
    await expect(comparisonCli(['--compare', before, after])).rejects.toThrow('64 KiB');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it('has no networking, SSH, model or command-runner imports', async () => {
  const source = await readFile(new URL('./agent-task-comparison.mjs', import.meta.url), 'utf8');
  expect(source).not.toMatch(/from ['"](?:node:(?:https?|net|child_process)|ssh2|@cloudhelm\/adapters|@earendil-works[^'"]*)['"]/u);
});
