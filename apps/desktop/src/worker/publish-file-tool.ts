import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Type, type Static } from 'typebox';
import { buildPublishPlan, candidateExitCode, candidateExitPhase, commitExitPhase, parsePublishHash, type BusinessTool } from '@cloudhelm/core';
import type { SafetyGate } from '@cloudhelm/application';
import { AdjudicationSchema } from '@cloudhelm/contracts';
import type { RemoteToolDependencies } from './remote-tool-dependencies.js';
import { blockedOperationFeedback } from './operation-feedback.js';
import { hasJournalCredentials } from './journal-secrets.js';

const parameters = Type.Object({ hostId: Type.String(),
  path: Type.String({ minLength: 2, maxLength: 4096 }),
  content: Type.String({ minLength: 1, maxLength: 1048576 }),
  mode: Type.Optional(Type.String({ pattern: '^[0-7]{3}$' })),
  owner: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$' })),
  adjudications: Type.Optional(Type.Array(AdjudicationSchema, { maxItems: 8 })) }, { additionalProperties: false });

function note(feedback: Awaited<ReturnType<RemoteToolDependencies['runOperation']>>, addition: string):
  Awaited<ReturnType<RemoteToolDependencies['runOperation']>> {
  return { ...feedback, content: [{ type: 'text' as const,
    text: `${feedback.content.map((part) => part.text).join('\n')}\n${addition}` }] };
}

const cleanupState = (tail: string | undefined): 'ok' | 'failed' | 'unknown' =>
  tail?.includes('cloudhelm-publish: cleanup ok') === true ? 'ok'
    : tail?.includes('cloudhelm-publish: cleanup failed') === true ? 'failed' : 'unknown';

/** Create-only privileged publish of one non-secret file, split into separately
 * reviewed backend-built root scripts: a reviewed create-only staging of the
 * exact bytes under the ordinary login identity, then a su-wrapped candidate
 * script that guards target absence, staging shape and every parent component,
 * copies staging into a private exclusive candidate inside the target parent,
 * applies the reviewed metadata and emits the candidate hash. Only when that
 * emitted hash matches the reviewed hash does the second su-wrapped commit
 * script link the verified candidate atomically without overwrite, re-emit the
 * committed hash, verify metadata again and remove the candidate. No sudo
 * route, no session, no replay. */
export function createPublishFileTool(deps: RemoteToolDependencies, gate: SafetyGate): BusinessTool<Static<typeof parameters>> {
  return {
    name: 'publish_remote_file',
    label: 'Publish one new root-owned remote file under review',
    description: 'Publish one new non-secret UTF-8 file (max 1 MiB) to a trusted root-owned directory on an authorized host, create-only and never overwriting. Flow: reviewed create-only staging of the exact content under the ordinary login identity; then a separately reviewed backend-built root candidate script that re-verifies target absence, staging shape, every parent component (real directory, root-owned, not group/world-writable), creates a private exclusive candidate inside the target parent, applies and verifies the reviewed metadata and emits the candidate hash for an independent backend hash gate; only after that gate passes does another separately reviewed root commit script link the verified candidate atomically without overwrite, re-emit the committed hash, verify metadata again and remove the candidate. Existing targets, symlinks and untrusted parents are refused; any refusal before commit leaves the target untouched; committed-but-unverified or unknown results must be verified manually and are never auto-replayed. owner is user:group (default root:root), mode is three-digit octal (default 644). Content must not contain credentials. The reviewed scripts are backend-built su wraps answered through the private credential window; sudo is not used on this route.',
    parameters, replay: 'never',
    execute: async (_id, params, signal) => {
      const host = deps.hosts.find((entry) => entry.id === params.hostId);
      if (!host) return { content: [{ type: 'text' as const, text: 'Host is outside the conversation authorization scope' }],
        details: { code: 'out-of-scope-host' }, isError: true };
      const targetPath = path.posix.normalize(params.path);
      const content = params.content;
      const contentBytes = Buffer.byteLength(content, 'utf8');
      const contentSha256 = createHash('sha256').update(content, 'utf8').digest('hex');
      if (contentBytes > 1_048_576) return blockedOperationFeedback(_id, 'invalid-publish-content',
        '内容超过 1 MiB 上限；未分配终端，未执行任何操作。');
      if (hasJournalCredentials(content)) return blockedOperationFeedback(_id, 'content-contains-credentials',
        '内容中检测到可识别凭据；发布通道不承载秘密。请改用受控凭据通道或去除凭据后重新提案。未执行任何操作。');
      const nonce = randomBytes(16).toString('hex');
      const stagingPath = `/tmp/.cloudhelm-publish-${nonce}.staging`;
      const mode = params.mode ?? '644';
      const owner = params.owner ?? 'root:root';
      const plan = buildPublishPlan({ targetPath, contentSha256, contentBytes, mode, owner, stagingPath, nonce });
      if (!plan) return blockedOperationFeedback(_id, 'invalid-publish-target',
        '目标必须是规范化的绝对 POSIX 路径（非 /、无结尾斜杠、无 .. 或控制字符），owner 形如 user:group，mode 为三位八进制。未执行任何操作。');
      const terminalId = await deps.ensureTerminal(host.id);
      const staging = await deps.runOperation(gate, { id: randomUUID(), kind: 'write-file', path: stagingPath, content,
        createOnly: true, delegationId: randomUUID(), toolCallId: _id,
        ...(params.adjudications ? { adjudications: params.adjudications } : {}),
        scope: deps.scope(host, terminalId, '/') }, signal, host.label);
      if (staging.isError || staging.result?.status !== 'succeeded' || staging.result.exitCode !== 0)
        return note(staging, '暂存未完成：未尝试特权发布，目标未被修改。暂存失败需要核验时按原操作记录处理，不要重放。');
      // Every privileged step is the backend-built su wrap on the
      // credential-bound native PTY route, each reviewed on its own.
      const rootCommand = (command: string) => ({ id: randomUUID(), kind: 'command' as const, command,
        privilege: 'root' as const, delegationId: randomUUID(), toolCallId: _id,
        ...(params.adjudications ? { adjudications: params.adjudications } : {}),
        scope: { ...deps.scope(host, terminalId, '/'), runAs: 'root' } });
      const candidate = await deps.runOperation(gate, rootCommand(plan.wrappedCandidateCommand), signal, host.label);
      const candidateResult = candidate.result;
      if (!candidateResult) return note(candidate, `候选阶段未进入执行；暂存文件 ${stagingPath} 保留，目标未被修改。不要重放。`);
      const phase = candidateExitPhase(candidateResult.exitCode);
      if (phase === 'refused') return note(candidate,
        `候选阶段被拒绝（${candidateExitCode(candidateResult.exitCode)}）：预提交守卫失败，目标未被修改。${candidateResult.exitCode === 13 ? `候选 ${plan.candidatePath} 状态不明，可能残留，请核验后再处理；` : candidateResult.exitCode === 14 ? `已尝试清理候选 ${plan.candidatePath}（${cleanupState(candidateResult.stdoutTail)}）；` : ''}暂存文件 ${stagingPath} 保留。请修正问题后另行提案，不要重放本次发布。`);
      if (phase !== 'ready' || candidateResult.status !== 'succeeded') return note(candidate,
        `候选阶段结果未知（exit ${candidateResult.exitCode ?? 'unknown'}）：请先以只读方式核验目标 ${targetPath} 与候选 ${plan.candidatePath}，不要重放发布。`);
      // Backend hash gate: only the candidate hash emitted by the root script
      // itself, compared against the reviewed hash, unlocks the commit script.
      const observedCandidateHash = parsePublishHash(candidateResult.stdoutTail ?? '', plan.candidatePath);
      if (observedCandidateHash !== contentSha256) return { ...candidate, isError: true, content: [{ type: 'text' as const,
        text: `${candidate.content.map((part) => part.text).join('\n')}\n候选哈希未通过独立核对（观测 ${observedCandidateHash ?? '无有效哈希行'}，审核 ${contentSha256}）：不发送提交操作。候选 ${plan.candidatePath} 与暂存 ${stagingPath} 保留供人工核验，目标未被修改。不要重放本次发布。` }] };
      const commit = await deps.runOperation(gate, rootCommand(plan.wrappedCommitCommand), signal, host.label);
      const commitResult = commit.result;
      if (!commitResult) return note(commit, `提交操作未进入执行；候选 ${plan.candidatePath} 与暂存 ${stagingPath} 保留，目标未被修改。不要重放。`);
      const commitPhase = commitExitPhase(commitResult.exitCode);
      if (commitPhase === 'succeeded' && commitResult.status === 'succeeded') {
        const observedTargetHash = parsePublishHash(commitResult.stdoutTail ?? '', targetPath);
        if (observedTargetHash === contentSha256) return { ...commit, isError: false, content: [{ type: 'text' as const,
          text: `${commit.content.map((part) => part.text).join('\n')}\n发布完成：${targetPath}（${contentBytes} 字节 · SHA-256 ${contentSha256} · 属主 ${owner} · 权限 ${mode}）。提交后独立回读已核对内容哈希与元数据；候选清理：${cleanupState(commitResult.stdoutTail)}。` }] };
        return { ...commit, isError: true, content: [{ type: 'text' as const,
          text: `${commit.content.map((part) => part.text).join('\n')}\n目标 ${targetPath} 已提交，但提交回读哈希未能核对（观测 ${observedTargetHash ?? '无有效哈希行'}）：必须人工核验目标内容与元数据，禁止重放发布、删除后重建或盲目补偿；核验结论记录后再决定下一步。` }] };
      }
      if (commitPhase === 'commit-failed') return note(commit,
        `提交失败（exit ${commitResult.exitCode ?? 'unknown'}）：link(2) 原子语义保证目标未被本次发布修改（目标可能已存在或发生竞态）。候选 ${plan.candidatePath} 与暂存 ${stagingPath} 保留。请核验目标状态后另行提案，不要重放。`);
      if (commitPhase === 'committed-unverified') return { ...commit, isError: true, content: [{ type: 'text' as const,
        text: `${commit.content.map((part) => part.text).join('\n')}\n目标 ${targetPath} 已提交，但独立回读未通过：必须人工核验目标内容与元数据，禁止重放发布、删除后重建或盲目补偿；核验结论记录后再决定下一步。` }] };
      return note(commit, `提交结果未知（exit ${commitResult.exitCode ?? 'unknown'}）：请先以只读方式核验目标 ${targetPath} 与候选 ${plan.candidatePath}，不要重放发布。`);
    }
  };
}
