/* global window, document */
// G3 real-machine recovery-interaction harness.
// Drives the real desktop app over the real preload API against an isolated VM
// and a real model provider. Captures screenshots plus debug-replay evidence for
// the three G3 focus items: read-only diagnosis visibility, recovery disposition
// receipt, and execute-then-refuse monitoring. Conversations are selected in the
// real UI (history-row click) so stream-area widgets render as for a real user.
// Credentials arrive ONLY via environment variables, are stripped from the
// Electron environment, and are redacted from every artifact.
import console from 'node:console';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { quietElectron } from './quiet-electron.mjs';
import { DesktopProcess, cleanupDesktopSmoke, withTimeout } from './desktop-process.mjs';
import { captureQuietDesktop } from './quiet-screenshot.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const desktop = path.join(root, 'apps/desktop');
// Per-run evidence directory: a new run never overwrites a previous run's evidence.
const runStamp = new Date().toISOString().replace(/[-:.T]/gu, '').slice(0, 14);
const output = path.join(root, '.cache/g3-real-machine', `run-${runStamp}`);
await mkdir(output, { recursive: true });

const requiredEnv = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}：G3 凭据只经环境变量注入`);
  return value;
};
const secrets = { password: requiredEnv('G3_CRED'), apiKey: requiredEnv('G3_MODEL_KEY') };
const vm = { address: requiredEnv('G3_HOST'), port: Number(process.env.G3_PORT ?? '22'), username: requiredEnv('G3_LOGIN') };
const providerId = process.env.G3_PROVIDER ?? 'deepseek';
const modelOverride = process.env.G3_MODEL_ID;

function redact(text) {
  let value = String(text);
  for (const secret of [secrets.password, secrets.apiKey]) value = value.split(secret).join('[G3-REDACTED]');
  return value;
}

const summary = { startedAt: new Date().toISOString(), vm, providerId, steps: [], operations: [], focus: {} };
function record(step, detail = {}) {
  const safe = JSON.parse(redact(JSON.stringify(detail)));
  summary.steps.push({ at: new Date().toISOString(), step, ...safe });
  console.log(`[${step}] ${redact(JSON.stringify(safe))}`);
}

const userData = await mkdtemp(path.join(tmpdir(), 'cloudhelm-g3-'));
const instances = new Set();
let application = null;
let page = null;
let replayText = null;
try {
  // Credentials never enter the Electron process environment; they only cross
  // the preload API below and land in encrypted storage inside the app.
  const appEnv = { ...process.env, CLOUDHELM_USER_DATA: userData };
  for (const key of Object.keys(appEnv)) if (key.startsWith('G3_')) delete appEnv[key];
  application = await quietElectron.launch({ executablePath: createRequire(path.join(desktop, 'package.json'))('electron'),
    args: [path.join(desktop, 'out/main/index.js')], env: appEnv, timeout: 60_000 });
  const owner = new DesktopProcess(application); instances.add(owner); await owner.capture();
  page = await application.firstWindow({ timeout: 60_000 });
  await page.getByRole('textbox', { name: '给 AI 的消息' }).waitFor({ timeout: 60_000 });
  record('launched');

  const snapshot = () => page.evaluate(() => window.cloudhelm.snapshot());
  const shot = (name, timeoutMs = 25_000) => captureQuietDesktop(application, page, path.join(output, `${name}.png`), { timeoutMs });
  const collectReplay = async () => {
    try {
      const result = await page.evaluate(() => window.cloudhelm.debugReplay('read'));
      await page.evaluate(() => window.cloudhelm.debugReplay('disable'));
      return result?.text ? result : null;
    } catch { return null; }
  };
  const findStatusText = (needle) => page.evaluate((text) => Array.from(document.querySelectorAll('[role="status"]'))
    .map((item) => item.textContent?.trim() ?? '').find((value) => value.includes(text)) ?? null, needle);
  async function waitStatusText(needle, timeoutMs = 4_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = await findStatusText(needle);
      if (found) return found;
      await delay(250);
    }
    return null;
  }

  await page.evaluate(() => window.cloudhelm.debugReplay('enable'));
  record('replay-enabled');

  const providers = await page.evaluate(() => window.cloudhelm.listModelProviders());
  const provider = providers.find((item) => item.id === providerId);
  if (!provider) throw new Error(`未找到模型供应商 ${providerId}，可用：${providers.map((item) => item.id).join(', ')}`);
  const modelId = modelOverride ?? provider.models.find((model) => /flash/iu.test(`${model.id} ${model.name}`))?.id ?? provider.models[0]?.id;
  if (!modelId) throw new Error(`供应商 ${providerId} 没有可用模型`);
  await page.evaluate((profile) => window.cloudhelm.saveModelProfile(profile), { provider: provider.id, modelId, apiKey: secrets.apiKey });
  record('model-profile', { provider: provider.id, modelId });

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

  const seenOperations = new Map();
  const handled = new Set();
  function trackOperations(latest, taskId) {
    for (const operation of latest.operations.filter((item) => item.taskId === taskId)) {
      const key = `${operation.status}:${operation.failureKind ?? ''}:${operation.exitCode ?? ''}:${operation.reconciledAt ? 'r' : ''}`;
      if (seenOperations.get(operation.id) === key) continue;
      seenOperations.set(operation.id, key);
      summary.operations.push({ at: new Date().toISOString(), taskId, id: operation.id, status: operation.status,
        failureKind: operation.failureKind, exitCode: operation.exitCode, effects: operation.effects, readOnly: operation.readOnly,
        reconciledAt: operation.reconciledAt ?? null, preview: operation.preview.slice(0, 200) });
    }
  }

  // Select the conversation in the real UI so stream-area widgets render. A JS
  // click works on the hidden quiet window; native input is never required.
  async function selectConversation(started) {
    const prefix = started.goal.slice(0, 12);
    await withTimeout(async () => {
      while (!(await page.evaluate((text) => [...document.querySelectorAll('button')]
        .some((item) => (item.textContent ?? '').includes(text)), prefix))) await delay(300);
    }, 10_000, '等待历史列表出现对话');
    await page.evaluate((text) => {
      const button = [...document.querySelectorAll('button')].find((item) => (item.textContent ?? '').includes(text));
      if (!button) throw new Error('历史列表行不存在');
      button.click();
    }, prefix);
    await withTimeout(async () => {
      while (!(await page.evaluate((text) => (document.body.textContent ?? '').includes(text), started.goal.slice(0, 20)))) await delay(200);
    }, 10_000, '等待 UI 显示对话内容');
  }

  async function drive(taskId, { timeoutMs, onTick }) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const latest = await snapshot();
      trackOperations(latest, taskId);
      for (const approval of latest.approvals) {
        if (handled.has(approval.id)) continue;
        handled.add(approval.id);
        record('approval', { taskId, approvalId: approval.id, title: approval.title, impact: approval.impact, preview: approval.preview.slice(0, 200) });
        await shot(`approval-${approval.id.slice(0, 8)}`);
        await page.evaluate((approvalId) => window.cloudhelm.decideApproval(approvalId, true), approval.id);
        record('approval-decided', { approvalId: approval.id, approved: true });
      }
      for (const input of latest.inputs ?? []) {
        if (handled.has(input.id)) continue;
        handled.add(input.id);
        record('input-request', { taskId, inputId: input.id, kind: input.kind, title: input.title });
      }
      if (onTick) {
        try { await onTick(latest); } catch (error) { record('tick-error', { message: redact(String(error?.message ?? error)) }); }
      }
      const task = latest.conversations.find((item) => item.id === taskId);
      if (task && ['answered', 'paused', 'failed', 'human-control', 'waiting-user'].includes(task.status)) {
        return { task, snapshot: latest };
      }
      await delay(400);
    }
    return { task: null, snapshot: await snapshot(), timedOut: true };
  }

  // 场景 A：基线只读任务（真实 SSH/PAM 执行证据）
  const startedA = await page.evaluate((input) => window.cloudhelm.startConversation(input), { hostId: host.id,
    message: '只做只读检查：运行 uname -a 和 whoami，告诉我系统信息和当前登录用户。不要做任何修改。',
    model: { provider: provider.id, modelId }, localSelectionTokens: [] });
  record('scenario-a-started', { taskId: startedA.id, goal: startedA.goal.slice(0, 60) });
  await selectConversation(startedA);
  const a = await drive(startedA.id, { timeoutMs: 240_000 });
  if (a.timedOut) throw new Error('场景 A 超时：基线只读任务未结束');
  await shot('a-baseline');
  const aAnswer = (await snapshot()).messages.filter((item) => item.taskId === startedA.id && item.role === 'agent').at(-1)?.text ?? '';
  summary.focus.a = { taskId: startedA.id, status: a.task.status, answer: redact(aAnswer).slice(0, 600) };
  record('scenario-a-done', { status: a.task.status });

  // 场景 B（含处置 C）：失败写入 → 只读调查（关注项 1）→ 用户在卡片出现后
  // 立即「接受风险并继续」（关注项 2）→ 任务继续到本轮结束。操作状态转移全程
  // 记录（关注项 3 监控）。处置必须在模型证据对账（record_reconciled_result）
  // 之前发起——上一轮实测对账发生在写入失败后约 11 秒。
  let bNotice = false;
  let bCard = false;
  let bDisposed = false;
  let bFailedSeenAt = 0;
  const startedB = await page.evaluate((input) => window.cloudhelm.startConversation(input), { hostId: host.id,
    message: '创建文件 /root/g3-probe/g3-check.txt，内容为一行 g3。直接用 shell 重定向创建，不要使用 sudo。如果失败，请核验实际状态并告诉我结果。',
    model: { provider: provider.id, modelId }, localSelectionTokens: [] });
  record('scenario-b-started', { taskId: startedB.id, goal: startedB.goal.slice(0, 60) });
  await selectConversation(startedB);
  const b = await drive(startedB.id, { timeoutMs: 360_000, onTick: async (latest) => {
    const execution = latest.execution?.[startedB.id];
    if (!bNotice && execution?.diagnosisRestriction) {
      bNotice = true;
      summary.focus.bRestriction = { diagnosisRestriction: execution.diagnosisRestriction, model: execution.model };
      summary.focus.bNoticeText = await waitStatusText('本轮仅限只读调查');
      await shot('b-diagnosis-notice');
      record('b-diagnosis-restriction', { ...summary.focus.bRestriction, noticeText: Boolean(summary.focus.bNoticeText) });
    }
    if (!bCard && await page.evaluate(() => Boolean(document.querySelector('[aria-label="本次远端写入风险确认"]')))) {
      bCard = true;
      await shot('b-recovery-card');
      summary.focus.bCardText = await page.evaluate(() => document.querySelector('[aria-label="本次远端写入风险确认"]')?.textContent?.trim() ?? null);
      record('b-recovery-card-visible', { length: summary.focus.bCardText?.length ?? 0 });
    }
    const failedWrite = latest.operations.find((item) => item.taskId === startedB.id && item.hostId === host.id
      && item.status === 'failed' && item.effects !== 'none' && !item.readOnly && !item.reconciledAt && !item.recoveryDecision);
    if (failedWrite && !bDisposed && (bCard || (bFailedSeenAt && Date.now() - bFailedSeenAt > 3_000))) {
      bDisposed = true;
      summary.focus.bDisposal = { operationId: failedWrite.id, failureKind: failedWrite.failureKind };
      await page.evaluate((request) => window.cloudhelm.resolveOperationRisk(request), { actionId: randomUUID(), action: 'accept-and-continue',
        operationId: failedWrite.id, explanation: 'G3 真机验收：用户明确知晓原远端操作结果未知且可能继续运行，自愿接管此项未决风险。',
        sourceTaskId: startedB.id });
      let cDecision = null;
      const decisionDeadline = Date.now() + 25_000;
      while (!cDecision && Date.now() < decisionDeadline) {
        cDecision = (await snapshot()).operations.find((item) => item.id === failedWrite.id)?.recoveryDecision ?? null;
        if (cDecision) break;
        await delay(300);
      }
      summary.focus.cDecision = cDecision ? JSON.parse(redact(JSON.stringify(cDecision))) : null;
      summary.focus.cReceiptText = await waitStatusText('接管') ?? await waitStatusText('核验');
      await shot('c-receipt');
      record('scenario-c-decision', { decision: summary.focus.cDecision, receipt: Boolean(summary.focus.cReceiptText) });
    } else if (failedWrite && !bFailedSeenAt) bFailedSeenAt = Date.now();
  } });
  await shot('b-final');
  const afterB = await snapshot();
  const bAnswer = afterB.messages.filter((item) => item.taskId === startedB.id && item.role === 'agent').at(-1)?.text ?? '';
  summary.focus.b = { taskId: startedB.id, status: b.task?.status ?? 'timeout',
    restriction: afterB.execution?.[startedB.id]?.diagnosisRestriction ?? null,
    noticeSeen: bNotice, cardSeen: bCard, disposed: bDisposed,
    answer: redact(bAnswer).slice(0, 600) };
  if (b.task?.status === 'waiting-user') summary.focus.bClarifications = afterB.clarifications ?? [];
  if (!bDisposed) {
    // 模型可能先完成了证据对账；此时处置回执应显示证据核验结果（关注项 2 的证据路径）。
    summary.focus.cReceiptText = summary.focus.cReceiptText ?? await waitStatusText('核验') ?? await waitStatusText('接管');
    await shot('c-receipt');
    record('scenario-b-not-disposed', { receipt: Boolean(summary.focus.cReceiptText) });
  }
  record('scenario-b-done', summary.focus.b);
  if (!bNotice) throw new Error('场景 B 未观察到只读调查状态（关注项 1 无证据）');

  replayText = await collectReplay();
  if (!replayText) throw new Error('调试回放读取失败');
  record('replay-collected', { bytes: replayText.text.length });
} catch (error) {
  summary.error = redact(String(error?.stack ?? error));
  process.exitCode = 1;
  if (page) {
    try { await captureQuietDesktop(application, page, path.join(output, 'failure.png'), { timeoutMs: 10_000 }); } catch { /* 应用可能已不可用 */ }
    try {
      const result = await page.evaluate(() => window.cloudhelm.debugReplay('read'));
      if (result?.text) replayText = { text: result.text };
    } catch { /* 应用可能已不可用 */ }
  }
} finally {
  await cleanupDesktopSmoke(instances, userData, (message) => console.warn(redact(message)));
  if (replayText?.text) await writeFile(path.join(output, 'g3-replay.jsonl'), redact(replayText.text));
  summary.finishedAt = new Date().toISOString();
  // Redact the whole artifact: username/home paths may equal the test password.
  await writeFile(path.join(output, 'g3-summary.json'), redact(JSON.stringify(summary, null, 2)));
  console.log(`G3 evidence: ${output}`);
  console.log(redact(JSON.stringify(summary.focus)));
}
