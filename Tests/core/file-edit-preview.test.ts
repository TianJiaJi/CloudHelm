import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { prepareFileEdit } from '../../packages/core/src/file-edit.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const prepare = (source: string, oldText: string, newText: string) => prepareFileEdit({ content: source,
  sha256: hash(source), truncated: false }, hash(source), oldText, newText);

it('binds the exact source and target bytes to a complete single-hunk preview', () => {
  const result = prepare('port=80\nname=app\n', '80', '90');
  expect(result).toMatchObject({ kind: 'prepared', sourceSha256: hash('port=80\nname=app\n'),
    targetSha256: hash('port=90\nname=app\n'), content: 'port=90\nname=app\n',
    diff: '--- before\n+++ after\n@@ -1,2 +1,2 @@\n-port=80\n+port=90\n name=app\n' });
});

it('supports an exact empty-file replacement but never an empty search in nonempty content', () => {
  expect(prepare('', '', 'port=80\n')).toMatchObject({ kind: 'prepared', content: 'port=80\n', diff: '--- before\n+++ after\n@@ -0,0 +1,1 @@\n+port=80\n' });
  expect(prepare('x', '', 'y').kind).toBe('refused'); expect(prepare('', '', '').kind).toBe('refused');
});

it('shows every changed line and only three surrounding context lines', () => {
  const source = 'a\nb\nc\nd\ne\nf\ng\nh\ni\n';
  expect(prepare(source, 'e\nf\n', 'E\nF\nG\n')).toMatchObject({ kind: 'prepared',
    diff: '--- before\n+++ after\n@@ -2,8 +2,9 @@\n b\n c\n d\n-e\n-f\n+E\n+F\n+G\n g\n h\n i\n' });
});

it.each([
  ['x', 'x', 'y', '@@ -1,1 +1,1 @@\n-x\n\\ No newline at end of file\n+y\n\\ No newline at end of file\n'],
  ['x\n', 'x\n', '', '@@ -1,1 +0,0 @@\n-x\n'],
  ['x', 'x', 'x\n', '@@ -1,1 +1,1 @@\n-x\n\\ No newline at end of file\n+x\n'],
  ['键=旧\r\n', '旧', '新', '@@ -1,1 +1,1 @@\n-键=旧\r\n+键=新\r\n']
])('preserves EOF and line-ending semantics: %j', (source, oldText, newText, hunk) => {
  expect(prepare(source!, oldText!, newText!)).toMatchObject({ kind: 'prepared', diff: `--- before\n+++ after\n${hunk}` });
});

it.each(['aa', 'missing'])('rejects ambiguous or missing literal edits without partial data: %s', (oldText) => {
  expect(prepare('aaa', oldText, 'b')).toMatchObject({ kind: 'refused', code: 'remote-edit-ambiguous' });
});

it('rejects no-op, NUL and invalid UTF-8 replacement input', () => {
  for (const newText of ['x', '\0', '\ud800']) expect(prepare('x', 'x', newText))
    .toMatchObject({ kind: 'refused', code: 'remote-edit-invalid' });
});

it('rejects stale, truncated, redacted or unverifiable original versions', () => {
  for (const snapshot of [{ content: 'x', truncated: true, sha256: hash('x') },
    { content: 'x', truncated: false, redacted: true, sha256: hash('x') },
    { content: 'changed', truncated: false, sha256: hash('x') }, { content: 'x', truncated: false }]) {
    expect(prepareFileEdit(snapshot, hash('x'), 'x', 'y').kind).toBe('refused');
  }
  expect(prepareFileEdit({ content: 'x', truncated: false, sha256: hash('x') }, '0'.repeat(64), 'x', 'y'))
    .toMatchObject({ kind: 'refused', code: 'remote-edit-source-changed' });
});

it('never returns source/new secrets or edit hashes on a redaction refusal', () => {
  for (const result of [prepare('password="hidden-source"\nport=80\n', '80', '90'),
    prepare('port=80\n', '80', '90\npassword="hidden-new"')]) {
    expect(result).toMatchObject({ kind: 'refused', code: 'remote-edit-unavailable' });
    expect(JSON.stringify(result)).not.toMatch(/hidden-source|hidden-new|sourceSha256|targetSha256/);
  }
});

it('refuses oversized diffs rather than calling a clipped preview complete', () => {
  const source = 'begin\n' + 'a\n'.repeat(20000) + 'end\n';
  expect(prepare(source, source, source.replaceAll('a\n', 'b\n')))
    .toMatchObject({ kind: 'refused', code: 'remote-edit-diff-too-large' });
});

it('bounds source and result bytes as well as line-count work', () => {
  expect(prepare('x', 'x', '中'.repeat(400000))).toMatchObject({ kind: 'refused', code: 'remote-edit-invalid' });
  expect(prepare('a\n'.repeat(40000) + 'end', 'end', 'new')).toMatchObject({ kind: 'refused', code: 'remote-edit-diff-too-large' });
});
