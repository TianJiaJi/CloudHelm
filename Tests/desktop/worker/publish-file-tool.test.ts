import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { SafetyGate } from '@cloudhelm/application';
import { buildPublishPlan, type OperationResult, type ProposedOperation } from '@cloudhelm/core';
import type { RuntimeHost } from '@cloudhelm/contracts/runtime';
import { createPublishFileTool } from '../../../apps/desktop/src/worker/publish-file-tool.js';
import { operationToolResult } from '../../../apps/desktop/src/worker/operation-feedback.js';
import type { RemoteToolDependencies } from '../../../apps/desktop/src/worker/remote-tool-dependencies.js';

const content = '[Unit]\nDescription=CloudHelm demo\n[Service]\nExecStart=/usr/bin/sleep 600\n[Install]\nWantedBy=multi-user.target\n';
const contentHash = createHash('sha256').update(content, 'utf8').digest('hex');
const targetPath = '/etc/systemd/system/demo.service';
type PhaseOverride = Partial<OperationResult> | ((shaPath: string) => Partial<OperationResult>);

function resolveOverride(override: PhaseOverride | undefined, shaPath: string): Partial<OperationResult> {
  if (override === undefined) return {};
  return typeof override === 'function' ? override(shaPath) : override;
}

function fixture(candidate?: PhaseOverride, commit?: PhaseOverride, staging?: Partial<OperationResult>) {
  const host: RuntimeHost = { id: 'host', label: 'fixture', address: '192.0.2.1', port: 22, username: 'user', auth: 'agent',
    status: 'connected', defaultMode: 'ask', protectedPaths: [], policyRevision: 1 };
  const gate = {} as SafetyGate;
  const scope: RemoteToolDependencies['scope'] = (_host, terminalId, cwd = '/') => ({ taskId: 'task', hostId: host.id, terminalId,
    terminalGeneration: 1, cwd, loginAs: host.username, runAs: host.username, policyRevision: 1, protectedPaths: [], allowedWorkingRoots: [], goal: 'publish' });
  const ensureTerminal = vi.fn(async () => 'ordinary');
  const runOperation = vi.fn<RemoteToolDependencies['runOperation']>(async (actualGate, operation) => {
    expect(actualGate).toBe(gate);
    if (operation.kind === 'write-file') {
      const result = staging === undefined
        ? { status: 'succeeded', exitCode: 0, stdoutTail: `Wrote ${operation.path}. Verified read-back hash.` }
        : { status: 'succeeded', exitCode: 0, stdoutTail: `Wrote ${operation.path}. Verified read-back hash.`, ...staging };
      return operationToolResult({ operationId: operation.id, ...result } as OperationResult, host.label, false);
    }
    if (operation.kind === 'command') {
      // The dispatched su wrap escapes every inner quote as '\''; undo that
      // once so the mocked hashes name the same paths the scripts carry.
      const text = operation.command.replaceAll("'\\''", "'");
      const shaPath = /sha256sum '([^']+)'/.exec(text)?.[1] ?? '/unset';
      const commitForm = text.includes("ln '");
      const resolved = resolveOverride(commitForm ? commit : candidate, shaPath);
      const defaults = commitForm
        ? { status: 'succeeded', exitCode: 0,
          stdoutTail: `cloudhelm-publish: committed\n${contentHash}  ${shaPath}\ncloudhelm-publish: cleanup ok\ncloudhelm-publish: readback verified\n` }
        : { status: 'succeeded', exitCode: 0,
          stdoutTail: `16+0 records in\n16+0 records out\n${contentHash}  ${shaPath}\ncloudhelm-publish: candidate ready\n` };
      return operationToolResult({ operationId: operation.id, ...defaults, ...resolved } as OperationResult, host.label, false);
    }
    throw new Error('Unexpected operation kind');
  });
  const deps = { hosts: [host], scope, ensureTerminal, runOperation } as unknown as RemoteToolDependencies;
  const tool = createPublishFileTool(deps, gate);
  const params = { hostId: 'host', path: targetPath, content };
  return { host, ensureTerminal, runOperation,
    run: (overrides: Partial<typeof params> = {}) => tool.execute('call', { ...params, ...overrides }, undefined) };
}

function rebuildPlan(stagingPath: string) {
  const nonce = path.basename(stagingPath).replace(/^\.cloudhelm-publish-/u, '').replace(/\.staging$/u, '');
  return buildPublishPlan({ targetPath, contentSha256: contentHash, contentBytes: Buffer.byteLength(content, 'utf8'),
    mode: '644', owner: 'root:root', stagingPath, nonce });
}

describe('publish_remote_file tool', () => {
  it('stages under the ordinary identity then dispatches candidate and commit su wraps as root', async () => {
    const f = fixture();
    const reply = await f.run();
    expect(reply.isError).toBe(false);
    expect(f.runOperation).toHaveBeenCalledTimes(3);
    const staging = f.runOperation.mock.calls[0]![1] as Extract<ProposedOperation, { kind: 'write-file' }>;
    expect(staging.kind).toBe('write-file');
    expect(staging.createOnly).toBe(true);
    expect(staging.content).toBe(content);
    expect(staging.path).toMatch(/^\/tmp\/\.cloudhelm-publish-[a-f0-9]{16,64}\.staging$/u);
    expect(staging.scope.runAs).toBe('user');
    const plan = rebuildPlan(staging.path);
    const candidate = f.runOperation.mock.calls[1]![1] as Extract<ProposedOperation, { kind: 'command' }>;
    const commit = f.runOperation.mock.calls[2]![1] as Extract<ProposedOperation, { kind: 'command' }>;
    expect(candidate.command).toBe(plan!.wrappedCandidateCommand);
    expect(commit.command).toBe(plan!.wrappedCommitCommand);
    for (const op of [candidate, commit]) {
      expect(op.kind).toBe('command');
      expect(op.privilege).toBe('root');
      expect(op.scope.runAs).toBe('root');
    }
    expect(reply.content[0]!.text).toContain('发布完成');
    expect(reply.content[0]!.text).toContain('独立回读已核对内容哈希与元数据');
    expect(reply.content[0]!.text).toContain('候选清理：ok');
  });

  it('does not attempt the privileged publish when staging fails', async () => {
    const f = fixture(undefined, undefined, { status: 'failed', exitCode: 1, stdoutTail: 'Remote file already exists' });
    const reply = await f.run();
    expect(reply.isError).toBe(true);
    expect(f.runOperation).toHaveBeenCalledTimes(1);
    expect(reply.content[0]!.text).toContain('暂存未完成');
    expect(reply.content[0]!.text).toContain('目标未被修改');
  });

  it('reports pre-commit refusals with the target untouched', async () => {
    const f = fixture({ status: 'failed', exitCode: 12, stdoutTail: '' });
    const reply = await f.run();
    expect(reply.isError).toBe(true);
    expect(f.runOperation).toHaveBeenCalledTimes(2);
    expect(reply.content[0]!.text).toContain('候选阶段被拒绝（parent-untrusted）');
    expect(reply.content[0]!.text).toContain('目标未被修改');
    expect(reply.content[0]!.text).toContain('不要重放');
  });

  it('reports an unremovable candidate state after exclusive-create failures', async () => {
    const f = fixture({ status: 'failed', exitCode: 13, stdoutTail: '' });
    const reply = await f.run();
    expect(reply.isError).toBe(true);
    expect(reply.content[0]!.text).toContain('候选阶段被拒绝（candidate-create-failed）');
    expect(reply.content[0]!.text).toContain('状态不明，可能残留');
  });

  it('refuses to dispatch the commit when the candidate hash is missing from the candidate output', async () => {
    const f = fixture({ status: 'succeeded', exitCode: 0, stdoutTail: 'cloudhelm-publish: candidate ready\n' });
    const reply = await f.run();
    expect(reply.isError).toBe(true);
    expect(f.runOperation).toHaveBeenCalledTimes(2);
    expect(reply.content[0]!.text).toContain('候选哈希未通过独立核对');
    expect(reply.content[0]!.text).toContain('不发送提交操作');
    expect(reply.content[0]!.text).toContain('目标未被修改');
  });

  it('refuses to dispatch the commit when the observed candidate hash differs from the reviewed hash', async () => {
    const f = fixture((shaPath) => ({ status: 'succeeded', exitCode: 0,
      stdoutTail: `${'b'.repeat(64)}  ${shaPath}\ncloudhelm-publish: candidate ready\n` }));
    const reply = await f.run();
    expect(reply.isError).toBe(true);
    expect(f.runOperation).toHaveBeenCalledTimes(2);
    expect(reply.content[0]!.text).toContain('候选哈希未通过独立核对');
    expect(reply.content[0]!.text).toContain('不要重放');
  });

  it('reports atomic commit failure without claiming target modification', async () => {
    const f = fixture(undefined, { status: 'failed', exitCode: 20, stdoutTail: '' });
    const reply = await f.run();
    expect(reply.isError).toBe(true);
    expect(f.runOperation).toHaveBeenCalledTimes(3);
    expect(reply.content[0]!.text).toContain('提交失败');
    expect(reply.content[0]!.text).toContain('目标未被本次发布修改');
    expect(reply.content[0]!.text).toContain('不要重放');
  });

  it('requires manual verification when the committed metadata read-back fails', async () => {
    const f = fixture(undefined, { status: 'failed', exitCode: 22, stdoutTail: 'cloudhelm-publish: committed\n' });
    const reply = await f.run();
    expect(reply.isError).toBe(true);
    expect(f.runOperation).toHaveBeenCalledTimes(3);
    expect(reply.content[0]!.text).toContain('已提交');
    expect(reply.content[0]!.text).toContain('人工核验');
    expect(reply.content[0]!.text).toContain('禁止重放');
  });

  it('requires manual verification when the committed target hash cannot be verified', async () => {
    const f = fixture(undefined, { status: 'succeeded', exitCode: 0,
      stdoutTail: 'cloudhelm-publish: committed\ncloudhelm-publish: cleanup ok\ncloudhelm-publish: readback verified\n' });
    const reply = await f.run();
    expect(reply.isError).toBe(true);
    expect(f.runOperation).toHaveBeenCalledTimes(3);
    expect(reply.content[0]!.text).toContain('提交回读哈希未能核对');
    expect(reply.content[0]!.text).toContain('人工核验');
  });

  it('keeps unknown candidate results replay-blocked', async () => {
    const f = fixture({ status: 'unknown', exitCode: undefined, stdoutTail: '' });
    const reply = await f.run();
    expect(reply.isError).toBe(true);
    expect(f.runOperation).toHaveBeenCalledTimes(2);
    expect(reply.content[0]!.text).toContain('候选阶段结果未知');
    expect(reply.content[0]!.text).toContain('不要重放');
  });

  it('keeps unknown commit results replay-blocked', async () => {
    const f = fixture(undefined, { status: 'unknown', exitCode: undefined, stdoutTail: '' });
    const reply = await f.run();
    expect(reply.isError).toBe(true);
    expect(f.runOperation).toHaveBeenCalledTimes(3);
    expect(reply.content[0]!.text).toContain('提交结果未知');
    expect(reply.content[0]!.text).toContain('不要重放');
  });

  it('rejects non-absolute targets before any terminal allocation', async () => {
    const f = fixture();
    const reply = await f.run({ path: 'etc/demo.conf' });
    expect(reply.isError).toBe(true);
    expect((reply.details as { code?: string }).code).toBe('invalid-publish-target');
    expect(f.ensureTerminal).not.toHaveBeenCalled();
    expect(f.runOperation).not.toHaveBeenCalled();
  });

  it('refuses content with recognizable credentials', async () => {
    const f = fixture();
    const reply = await f.run({ content: 'endpoint=https://deploy:hunter2@example.invalid/x\n' });
    expect(reply.isError).toBe(true);
    expect((reply.details as { code?: string }).code).toBe('content-contains-credentials');
    expect(f.ensureTerminal).not.toHaveBeenCalled();
    expect(f.runOperation).not.toHaveBeenCalled();
  });
});
