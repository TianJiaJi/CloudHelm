/* global window, document */
// Shared driver for the G3 supplement campaigns: evidence 1 (privileged
// deployment through the real client) and evidence 2 (mid-write disconnection
// recovery). Wraps the real preload API with model profile setup, host
// connection, conversation selection in the real UI, auto-approval, input
// answering by title rules (sudo password, su root password, su confirmation —
// the user side of the controlled privileged channels), operation tracking with
// no-replay evidence fields, and debug-replay collection.
// Credentials arrive ONLY via environment variables in the calling script and
// cross the preload API; they never enter the Electron environment or logs.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withTimeout } from '../desktop-process.mjs';
import { captureQuietDesktop } from '../quiet-screenshot.mjs';

/** Task statuses the caller treats as end-of-round. */
export const FINAL_STATUSES = ['answered', 'failed', 'human-control', 'waiting-user'];

export function createDriver(context) {
  const { page, application, output, secrets, redact, record, inputDecider, approvalDecider } = context;
  const snapshot = () => page.evaluate(() => window.cloudhelm.snapshot());
  const shot = (name, timeoutMs = 25_000) => captureQuietDesktop(application, page, path.join(output, `${name}.png`), { timeoutMs });
  const seenOperations = new Map();
  const handled = new Set();
  const operations = [];

  function trackOperations(latest, taskId) {
    for (const operation of latest.operations.filter((item) => item.taskId === taskId)) {
      const key = `${operation.status}:${operation.failureKind ?? ''}:${operation.exitCode ?? ''}:${operation.reconciledAt ? 'r' : ''}`;
      if (seenOperations.get(operation.id) === key) continue;
      seenOperations.set(operation.id, key);
      operations.push({ at: new Date().toISOString(), taskId, id: operation.id, status: operation.status,
        kind: operation.kind, readOnly: operation.readOnly, internal: operation.internal ?? null,
        toolCallId: operation.toolCallId ?? null, delegationId: operation.delegationId ?? null,
        failureKind: operation.failureKind ?? null, exitCode: operation.exitCode ?? null,
        effects: operation.effects ?? null, reconciledAt: operation.reconciledAt ?? null,
        reconciliation: operation.reconciliation ? { kind: operation.reconciliation.kind,
          outcome: operation.reconciliation.outcome,
          evidenceOperationIds: operation.reconciliation.evidenceOperationIds ?? null } : null,
        privilege: operation.privilege ? { method: operation.privilege.method, stage: operation.privilege.stage,
          code: operation.privilege.code, source: operation.privilege.source } : null,
        authentication: operation.authentication ?? null,
        preview: operation.preview.slice(0, 200) });
    }
  }

  // Title rules are order-sensitive: the sudo window title contains the
  // substring "su", so sudo must be matched first. Unknown inputs stay
  // unanswered — the round then fails honestly instead of guessing.
  function decideInputAnswer(input) {
    if (input.kind === 'secret' && /sudo/u.test(input.title)) return { answer: secrets.password, rule: 'sudo-password' };
    if (input.kind === 'secret' && /su/u.test(input.title)) return { answer: secrets.rootPassword, rule: 'su-root-password' };
    if (input.kind === 'secret' && /SSH 登录需要身份验证/u.test(input.title)) return { answer: secrets.password, rule: 'ssh-login-password' };
    if (input.kind === 'confirmation' && (input.choices ?? []).includes('通过 su 切换 root')) {
      return { answer: '通过 su 切换 root', rule: 'su-confirmation' };
    }
    return null;
  }

  async function drive(taskId, { timeoutMs, onTick, stopOn = FINAL_STATUSES }) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const latest = await snapshot();
      trackOperations(latest, taskId);
      for (const approval of latest.approvals) {
        if (handled.has(approval.id)) continue;
        handled.add(approval.id);
        record('approval', { taskId, approvalId: approval.id, title: approval.title, impact: approval.impact,
          preview: approval.preview.slice(0, 200) });
        await shot(`approval-${approval.id.slice(0, 8)}`);
        const approved = approvalDecider ? approvalDecider(approval) : true;
        await page.evaluate(([approvalId, value]) => window.cloudhelm.decideApproval(approvalId, value), [approval.id, approved]);
        record('approval-decided', { approvalId: approval.id, approved });
      }
      for (const input of latest.inputs ?? []) {
        if (handled.has(input.id)) continue;
        handled.add(input.id);
        const decision = inputDecider ? inputDecider(input) : null;
        const chosen = decision ?? decideInputAnswer(input);
        record('input-request', { taskId, inputId: input.id, kind: input.kind, title: input.title,
          choices: input.choices ?? null, answered: chosen?.rule ?? null, cancelled: decision?.cancel === true });
        if (decision?.cancel) {
          await page.evaluate((inputId) => window.cloudhelm.cancelInput(inputId), input.id);
          record('input-cancelled', { inputId: input.id });
        } else if (chosen) {
          await page.evaluate(([inputId, answer]) => window.cloudhelm.answerInput(inputId, answer), [input.id, chosen.answer]);
        }
      }
      if (onTick) {
        try {
          if (await onTick(latest) === 'stop') {
            return { task: latest.conversations.find((item) => item.id === taskId) ?? null, snapshot: latest, stoppedByTick: true };
          }
        } catch (error) { record('tick-error', { message: redact(String(error?.message ?? error)) }); }
      }
      const task = latest.conversations.find((item) => item.id === taskId);
      if (task && stopOn.includes(task.status)) return { task, snapshot: latest };
      await delay(400);
    }
    return { task: null, snapshot: await snapshot(), timedOut: true };
  }

  async function setupModel({ providerId, modelId }) {
    const providers = await page.evaluate(() => window.cloudhelm.listModelProviders());
    const provider = providers.find((item) => item.id === providerId);
    if (!provider) throw new Error(`未找到模型供应商 ${providerId}，可用：${providers.map((item) => item.id).join(', ')}`);
    const chosen = modelId ?? provider.models.find((model) => /flash/iu.test(`${model.id} ${model.name}`))?.id ?? provider.models[0]?.id;
    if (!chosen) throw new Error(`供应商 ${providerId} 没有可用模型`);
    await page.evaluate((profile) => window.cloudhelm.saveModelProfile(profile), { provider: provider.id, modelId: chosen, apiKey: secrets.apiKey });
    record('model-profile', { provider: provider.id, modelId: chosen });
    return { provider: provider.id, modelId: chosen };
  }

  async function addHostAndConnect(vm) {
    const host = await page.evaluate(([draft, credentials]) => window.cloudhelm.addHost(draft, credentials),
      [{ label: 'G3 隔离VM', address: vm.address, port: vm.port, username: vm.username, auth: 'password' }, { password: secrets.password }]);
    try {
      await page.evaluate((hostId) => window.cloudhelm.connectHost(hostId), host.id);
    } catch (error) {
      const fingerprint = /Verify SSH host key for [^:]+: (.+)$/u.exec(String(error?.message ?? error))?.[1];
      if (!fingerprint) throw error;
      record('trust-required', { fingerprint });
      await page.evaluate(([hostId, value]) => window.cloudhelm.trustHostKey(hostId, value), [host.id, fingerprint]);
      await page.evaluate((hostId) => window.cloudhelm.connectHost(hostId), host.id);
    }
    await withTimeout(async () => {
      while ((await snapshot()).hosts.find((item) => item.id === host.id)?.status !== 'connected') await delay(250);
    }, 45_000, '等待 SSH 连接（真实 PAM 认证）');
    await page.evaluate((hostId) => window.cloudhelm.updateHostReviewMode(hostId, 'ask'), host.id);
    record('ssh-connected', { hostId: host.id, reviewMode: 'ask' });
    return host;
  }

  // Select the conversation in the real UI so stream-area widgets render. A JS
  // click works on the hidden quiet window; native input is never required.
  async function selectConversation(started) {
    const prefix = started.goal.slice(0, 12);
    await withTimeout(async () => {
      while (!(await page.evaluate((text) => [...document.querySelectorAll('button')]
        .some((item) => (item.textContent ?? '').includes(text)), prefix))) await delay(300);
    }, 15_000, '等待历史列表出现对话');
    await page.evaluate((text) => {
      const button = [...document.querySelectorAll('button')].find((item) => (item.textContent ?? '').includes(text));
      if (!button) throw new Error('历史列表行不存在');
      button.click();
    }, prefix);
    await withTimeout(async () => {
      while (!(await page.evaluate((text) => (document.body.textContent ?? '').includes(text), started.goal.slice(0, 20)))) await delay(200);
    }, 15_000, '等待 UI 显示对话内容');
  }

  async function startTask(hostId, message, model) {
    const started = await page.evaluate((input) => window.cloudhelm.startConversation(input),
      { hostId, message, model, localSelectionTokens: [] });
    record('task-started', { taskId: started.id, goal: started.goal.slice(0, 80) });
    await selectConversation(started);
    return started;
  }

  function agentAnswer(latest, taskId) {
    return latest.messages.filter((item) => item.taskId === taskId && item.role === 'agent').at(-1)?.text ?? '';
  }

  function metrics(latest, taskId, replayText) {
    const task = latest.conversations.find((item) => item.id === taskId);
    const assistantMessages = latest.messages.filter((item) => item.taskId === taskId && item.role === 'agent').length;
    let modelRequests = null;
    let replayLines = null;
    if (replayText) {
      replayLines = 0;
      modelRequests = 0;
      for (const line of replayText.split('\n')) {
        if (!line.trim()) continue;
        replayLines += 1;
        try { if (JSON.parse(line)?.event === 'model.request') modelRequests += 1; } catch { /* malformed line counts as a line only */ }
      }
    }
    return { taskStatus: task?.status ?? 'missing', requestCount: task?.requestCount ?? null,
      assistantMessages, modelRequests, replayLines };
  }

  async function collectReplay() {
    try {
      const result = await page.evaluate(() => window.cloudhelm.debugReplay('read'));
      await page.evaluate(() => window.cloudhelm.debugReplay('disable'));
      return result?.text ?? null;
    } catch { return null; }
  }

  async function saveReplay(replayText) {
    if (!replayText) return null;
    const target = path.join(output, 'g3-replay.jsonl');
    await writeFile(target, redact(replayText));
    return target;
  }

  return { snapshot, shot, drive, trackOperations, setupModel, addHostAndConnect, selectConversation,
    startTask, agentAnswer, metrics, collectReplay, saveReplay,
    get operations() { return operations; },
    get handled() { return handled; } };
}

/** Standard G3 supplement evidence writer: redacted summary JSON and replay
 * JSONL into the run directory. Mirrors the original G3 harness artifact
 * naming so the reviewer reads one format everywhere. */
export async function writeEvidence(output, summary, replayText, redact) {
  if (replayText) await writeFile(path.join(output, 'g3-replay.jsonl'), redact(replayText));
  await writeFile(path.join(output, 'g3-summary.json'), redact(JSON.stringify(summary, null, 2)));
}
