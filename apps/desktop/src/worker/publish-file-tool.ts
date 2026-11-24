import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Type, type Static } from 'typebox';
import { buildPublishPlan, candidateExitCode, candidateExitPhase, commitExitCode, commitExitPhase, parsePublishHash, type BusinessTool } from '@cloudhelm/core';
import type { SafetyGate } from '@cloudhelm/application';
import { AdjudicationSchema } from '@cloudhelm/contracts';
import type { RemoteToolDependencies } from './remote-tool-dependencies.js';
import { blockedOperationFeedback } from './operation-feedback.js';
import { hasJournalCredentials } from './journal-secrets.js';

type ElevationRouteChoice = Awaited<ReturnType<NonNullable<RemoteToolDependencies['selectElevation']>>>;

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
 * reviewed backend-built root scripts. An explicit su route confirmation is
 * requested before anything is allocated: cancel, sudo or a missing route
 * stops the publish with no terminal and no staging. The flow is a reviewed
 * create-only staging of the exact bytes under the ordinary login identity;
 * then a su-wrapped candidate script that guards target absence, staging shape
 * and every parent component with match-asserted guards, copies staging into a
 * private exclusive candidate inside the target parent and keeps it root-owned
 * mode 600, emitting the candidate hash. Only when that emitted hash matches
 * the reviewed hash does the second su-wrapped commit script re-verify the
 * candidate exclusively, emit its hash at the commit boundary, link it
 * atomically with ln -T, apply the reviewed metadata, re-emit the committed
 * hash and remove the candidate; the backend independently verifies both
 * emitted hashes against the review. No sudo route, no session, no replay. */
export function createPublishFileTool(deps: RemoteToolDependencies, gate: SafetyGate): BusinessTool<Static<typeof parameters>> {
  return {
    name: 'publish_remote_file',
    label: 'Publish one new root-owned remote file under review',
    description: 'Publish one new non-secret UTF-8 file (max 1 MiB) to a trusted root-owned directory on an authorized host, create-only, never overwriting. An explicitly confirmed su route is requested first; cancel, sudo or a missing route stops everything before allocation. Flow: a reviewed create-only staging of the exact bytes under the ordinary login; a separately reviewed root candidate script match-asserts target absence, staging shape and every parent component, then creates a private exclusive root-owned mode-600 candidate in the target parent and emits its hash; after the backend hash gate passes, a second reviewed root commit script re-verifies the candidate exclusively, emits its hash at the boundary, links it atomically with ln -T, applies the metadata, re-emits the committed hash and removes the candidate; the backend independently checks both hashes. Existing targets, symlinks and untrusted parents are refused; refusals before commit leave the target untouched; committed-but-unverified or unknown results need manual verification, no replay. owner is user:group (default root:root), mode is three-digit octal (default 644). Content must not contain credentials. Scripts are backend-built su wraps answered via the private credential window; sudo is never used.',
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
      // The publish channel only ever dispatches the su wrap, so the route
      // choice must exist, be explicitly confirmed, and be su — otherwise
      // nothing at all is allocated, staged or dispatched.
      const candidateOperationId = randomUUID();
      if (!deps.selectElevation) return blockedOperationFeedback(_id, 'route-confirmation-unavailable',
        '无法请求特权路线确认：发布只经显式确认的 su 路线执行。未分配终端，未执行任何操作。');
      let route: ElevationRouteChoice;
      try {
        route = await deps.selectElevation(host, { operationId: candidateOperationId, command: plan.wrappedCandidateCommand, cwd: '/' }, signal);
      } catch {
        return blockedOperationFeedback(_id, 'elevation-selection-invalidated',
          '路线确认被中断或其作用域已变化：未分配终端，未执行任何操作。需要发布时请重新提案，不要自动重试。');
      }
      if (route === null) return blockedOperationFeedback(_id, 'route-not-confirmed',
        '未确认特权路线：发布未启动，未分配终端，未执行任何操作。需要发布时请先确认 su 路线再重新提案。');
      if (route !== 'su') return blockedOperationFeedback(_id, 'route-unsupported',
        '发布通道仅接受显式确认的 su 路线；本次确认的路线不被发布接受。未分配终端，未执行任何操作。');
      const terminalId = await deps.ensureTerminal(host.id);
      const staging = await deps.runOperation(gate, { id: randomUUID(), kind: 'write-file', path: stagingPath, content,
        createOnly: true, delegationId: randomUUID(), toolCallId: _id,
        ...(params.adjudications ? { adjudications: params.adjudications } : {}),
        scope: deps.scope(host, terminalId, '/') }, signal, host.label);
      if (staging.isError || staging.result?.status !== 'succeeded' || staging.result.exitCode !== 0)
        return note(staging, '暂存未完成：未尝试特权发布，目标未被修改。暂存失败需要核验时按原操作记录处理，不要重放。');
      // Every privileged step is the backend-built su wrap on the
      // credential-bound native PTY route, each reviewed on its own.
      const rootCommand = (command: string, operationId: string) => ({ id: operationId, kind: 'command' as const, command,
        privilege: 'root' as const, delegationId: randomUUID(), toolCallId: _id,
        ...(params.adjudications ? { adjudications: params.adjudications } : {}),
        scope: { ...deps.scope(host, terminalId, '/'), runAs: 'root' } });
      const candidate = await deps.runOperation(gate, rootCommand(plan.wrappedCandidateCommand, candidateOperationId), signal, host.label);
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
      const commit = await deps.runOperation(gate, rootCommand(plan.wrappedCommitCommand, randomUUID()), signal, host.label);
      const commitResult = commit.result;
      if (!commitResult) return note(commit, `提交操作未进入执行；候选 ${plan.candidatePath} 与暂存 ${stagingPath} 保留，目标未被修改。不要重放。`);
      const commitPhase = commitExitPhase(commitResult.exitCode);
      if (commitPhase === 'succeeded' && commitResult.status === 'succeeded') {
        const observedBoundaryHash = parsePublishHash(commitResult.stdoutTail ?? '', plan.candidatePath);
        const observedTargetHash = parsePublishHash(commitResult.stdoutTail ?? '', targetPath);
        if (observedBoundaryHash === contentSha256 && observedTargetHash === contentSha256) return { ...commit, isError: false, content: [{ type: 'text' as const,
          text: `${commit.content.map((part) => part.text).join('\n')}\n发布完成：${targetPath}（${contentBytes} 字节 · SHA-256 ${contentSha256} · 属主 ${owner} · 权限 ${mode}）。提交边界候选哈希与提交后目标回读哈希均已独立核对；候选清理：${cleanupState(commitResult.stdoutTail)}。` }] };
        return { ...commit, isError: true, content: [{ type: 'text' as const,
          text: `${commit.content.map((part) => part.text).join('\n')}\n目标 ${targetPath} 已提交，但提交边界候选哈希（观测 ${observedBoundaryHash ?? '无有效哈希行'}）或提交后目标回读哈希（观测 ${observedTargetHash ?? '无有效哈希行'}）未能核对（审核 ${contentSha256}）：必须人工核验目标内容与元数据，禁止重放发布、删除后重建或盲目补偿；核验结论记录后再决定下一步。` }] };
      }
      if (commitPhase === 'commit-failed') return note(commit,
        `提交失败（${commitExitCode(commitResult.exitCode)}，exit ${commitResult.exitCode ?? 'unknown'}）：提交前守卫或原子提交未通过，目标未被本次发布修改（目标可能已存在、候选失去独占或发生竞态）。候选 ${plan.candidatePath} 与暂存 ${stagingPath} 保留。请核验目标状态后另行提案，不要重放。`);
      if (commitPhase === 'committed-unverified') return { ...commit, isError: true, content: [{ type: 'text' as const,
        text: `${commit.content.map((part) => part.text).join('\n')}\n目标 ${targetPath} 已提交，但独立回读未通过：必须人工核验目标内容与元数据，禁止重放发布、删除后重建或盲目补偿；核验结论记录后再决定下一步。` }] };
      return note(commit, `提交结果未知（exit ${commitResult.exitCode ?? 'unknown'}）：请先以只读方式核验目标 ${targetPath} 与候选 ${plan.candidatePath}，不要重放发布。`);
    }
  };
}
