/* global window */
// G3 publish acceptance runner 2: mid-publish disconnection on the fixed
// client. The su credential window of the publish candidate script is
// deliberately held (never answered, password never injected), so when the
// out-of-band root channel kills the admin sshd session the candidate is
// dispatched-but-unconfirmed: the root script never ran and the target was
// never created. The round then observes the real recovery: reconnect, resume,
// read-only verification first, the write lock honored (nothing dispatched
// past the unresolved operation except SafetyGate-blocked proposals),
// explicit reconciliation of the killed candidate, and only then a fresh
// re-proposal with new operation ids (never a replay) that completes the
// file. Evidence: held-window record, kill record, connection-loss record,
// distinct operation ids, reconciliation record, out-of-band final file
// state. One invocation is one round.
// Usage: node Tests/smoke/g3-publish-netcut.mjs --label publish-netcut-r1 [--desktop <path>]
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { quietElectron } from './quiet-electron.mjs';
import { DesktopProcess, cleanupDesktopSmoke, withTimeout } from './desktop-process.mjs';
import { captureQuietDesktop } from './quiet-screenshot.mjs';
import { createDriver, writeEvidence } from './lib/g3-drive.mjs';
import { vmResetDeployment } from './lib/vm-lifecycle.mjs';
import { vmConnect } from './lib/vm-ssh.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const label = flag('label');
if (!label) throw new Error('缺少 --label（本轮标识，例如 --label publish-netcut-r1）');
const desktop = path.resolve(flag('desktop') ?? path.join(root, 'apps/desktop'));

const requiredEnv = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}：G3 凭据只经环境变量注入`);
  return value;
};
const secrets = { password: requiredEnv('G3_CRED'), rootPassword: process.env.G3_ROOT ?? requiredEnv('G3_CRED'), apiKey: requiredEnv('G3_MODEL_KEY') };
const vm = { address: requiredEnv('G3_HOST'), port: Number(process.env.G3_PORT ?? '22'), username: requiredEnv('G3_LOGIN') };
const providerId = process.env.G3_PROVIDER ?? 'deepseek';
const modelId = process.env.G3_MODEL_ID;

function redact(text) {
  let value = String(text);
  for (const secret of [...new Set([secrets.password, secrets.rootPassword, secrets.apiKey])].filter(Boolean)) {
    value = value.split(secret).join('[G3-REDACTED]');
  }
  return value;
}

const SUDO_WRAP = /^sudo --/u;
const SU_WRAP = /su -l -s \/bin\/sh root -c/u;
const PUBLISH_MARK = '.cloudhelm-publish';
const MARKER = '/usr/local/share/g3-netcut-marker';

// Identical across every round; the publish channel is the only permitted way
// to create the marker, so the operation stream proves the no-replay recovery.
const NETCUT_TASK = '在这台主机上完成一次受控文件发布：'
  + '使用 publish_remote_file 工具把一行内容 g3-netcut-ok 发布为新文件 /usr/local/share/g3-netcut-marker'
  + '（属主 root:root，权限 644），不要用 shell 重定向、tee 或其他任何写入方式创建它。'
  + '发布完成后读取该文件并向我确认内容是 g3-netcut-ok。'
  + '中途如果连接断开、发布结果未知或系统提示需要核验，先按系统指引以只读方式核验并记录结论，'
  + '再重新提案完成发布；不要盲目重发，不要删除后重建。';

const output = path.join(root, '.cache/g3-real-machine/supplement', label);
await mkdir(output, { recursive: true });
const summary = { label, startedAt: new Date().toISOString(),
  testedCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(),
  desktop, providerId, modelId: modelId ?? null,
  vm: { address: vm.address, port: vm.port, username: vm.username },
  steps: [], operations: [], recovery: {}, result: 'incomplete', resultDetail: null };
function record(step, detail = {}) {
  const safe = JSON.parse(redact(JSON.stringify(detail)));
  summary.steps.push({ at: new Date().toISOString(), step, ...safe });
  console.log(`[${step}] ${redact(JSON.stringify(safe))}`);
}

// Round-initial deterministic reset; every round starts from verified absence.
summary.reset = await vmResetDeployment(vm, secrets.rootPassword);
record('vm-reset', { initial: summary.reset.initial });
const initial = summary.reset.initial;
if (!initial.markerAbsent || !initial.publishTempAbsent || !initial.netAbsent || !initial.unitAbsent) {
  throw new Error(`VM 重置后初始态不干净：${JSON.stringify(initial)}`);
}

// Out-of-band root channel: only the disconnection trigger and the final file
// read. The product under test never sees this connection.
const rootSession = await vmConnect({ address: vm.address, port: vm.port, username: 'root', password: secrets.rootPassword });
const userData = await mkdtemp(path.join(tmpdir(), 'cloudhelm-g3c-'));
const instances = new Set();
let application = null;
let page = null;
let replayText = null;
try {
  const appEnv = { ...process.env, CLOUDHELM_USER_DATA: userData };
  for (const key of Object.keys(appEnv)) if (key.startsWith('G3_')) delete appEnv[key];
  application = await quietElectron.launch({ executablePath: createRequire(path.join(root, 'apps/desktop/package.json'))('electron'),
    args: [path.join(desktop, 'out/main/index.js')], env: appEnv, timeout: 60_000 });
  const owner = new DesktopProcess(application); instances.add(owner); await owner.capture();
  page = await application.firstWindow({ timeout: 60_000 });
  await page.getByRole('textbox', { name: '给 AI 的消息' }).waitFor({ timeout: 60_000 });
  record('launched');

  // Hold the su credential window of the publish candidate — and only that
  // one: the hold engages only while the su-wrapped publish script is the
  // running operation, so a read-only su check elsewhere in the round still
  // gets answered and the round cannot deadlock on a wrong window.
  let killFired = false;
  let suWindowHeld = false;
  const inputDecider = (input, latest) => {
    if (killFired) return null;
    if (input.kind !== 'secret' || !/su 身份验证/u.test(`${input.title}`)) return null;
    const running = (latest?.operations ?? []).find((op) => op.kind === 'command' && op.status === 'running'
      && !op.internal && SU_WRAP.test(op.preview) && op.preview.includes(PUBLISH_MARK));
    if (!running) return null;
    suWindowHeld = true;
    return { hold: true, rule: 'netcut-hold-su-password' };
  };
  const driver = createDriver({ page, application, output, secrets, redact, record, inputDecider });
  try { await page.evaluate(() => window.cloudhelm.debugReplay('enable')); record('replay-enabled'); }
  catch { record('replay-unavailable', { note: '无 debugReplay，指标改用任务计数' }); }

  const model = await driver.setupModel({ providerId, modelId });
  const host = await driver.addHostAndConnect(vm);
  const started = await driver.startTask(host.id, NETCUT_TASK, model);
  const taskStartedAt = Date.now();

  let reconnected = false;
  const driven = await driver.drive(started.id, { timeoutMs: 900_000,
    stopOn: ['answered', 'failed', 'human-control', 'waiting-user'],
    onTick: async (latest) => {
      if (!killFired) {
        // The cut is armed only after the su window is held, so the killed
        // candidate is guaranteed dispatched-but-unconfirmed: the root script
        // never ran and the password was never injected.
        if (!suWindowHeld) return;
        const target = latest.operations.find((op) => op.taskId === started.id && op.kind === 'command'
          && op.status === 'running' && op.readOnly !== true && !op.internal
          && SU_WRAP.test(op.preview) && op.preview.includes(PUBLISH_MARK));
        if (!target) return;
        killFired = true;
        summary.recovery.kill = { at: new Date().toISOString(), operationId: target.id,
          preview: target.preview.slice(0, 200) };
        const killed = await rootSession.exec('pkill -9 -u admin sshd; echo pkill_exit=$?', 15_000);
        summary.recovery.kill.pkillExit = /pkill_exit=0$/u.test(killed.stdout.trim()) ? 0 : killed.code;
        record('kill-fired', { operationId: target.id, pkillExit: summary.recovery.kill.pkillExit });
        await driver.shot('kill-fired');
        return;
      }
      if (killFired && !reconnected) {
        const hostView = latest.hosts.find((item) => item.id === host.id);
        const taskView = latest.conversations.find((item) => item.id === started.id);
        if (hostView?.status !== 'disconnected' && taskView?.status !== 'paused') return;
        reconnected = true;
        await delay(2_500); // Let the loss-time record and unknown settle.
        const settled = await driver.snapshot();
        summary.recovery.lossDetectedAt = new Date().toISOString();
        summary.recovery.taskStatusAtLoss = settled.conversations.find((item) => item.id === started.id)?.status ?? null;
        summary.recovery.hostStatusAtLoss = settled.hosts.find((item) => item.id === host.id)?.status ?? null;
        summary.recovery.connectionLosses = settled.conversations.find((item) => item.id === started.id)?.connectionLosses ?? null;
        record('connection-loss', { taskStatus: summary.recovery.taskStatusAtLoss, hostStatus: summary.recovery.hostStatusAtLoss,
          losses: summary.recovery.connectionLosses });
        await driver.shot('connection-loss');
        await page.evaluate((hostId) => window.cloudhelm.connectHost(hostId), host.id);
        await withTimeout(async () => {
          while ((await driver.snapshot()).hosts.find((item) => item.id === host.id)?.status !== 'connected') await delay(250);
        }, 45_000, '等待重连');
        summary.recovery.reconnectedAt = new Date().toISOString();
        await page.evaluate((taskId) => window.cloudhelm.resumeConversation(taskId), started.id);
        summary.recovery.resumedAt = new Date().toISOString();
        record('reconnected-resumed', {});
        await driver.shot('reconnected');
        return;
      }
      if (reconnected) {
        // A second pause after recovery (budget, clarification) ends the round honestly.
        const taskView = latest.conversations.find((item) => item.id === started.id);
        const hostView = latest.hosts.find((item) => item.id === host.id);
        if (taskView?.status === 'paused' && hostView?.status === 'connected') {
          record('paused-after-recovery', {});
          return 'stop';
        }
      }
      return undefined;
    } });
  summary.driveMs = Date.now() - taskStartedAt;
  summary.operations = driver.operations;
  summary.taskStatus = driven.task?.status ?? 'timeout';
  summary.answer = redact(driver.agentAnswer(driven.snapshot, started.id)).slice(0, 800);
  await driver.shot('final');

  // Out-of-band final state of the marker: the re-proposal's effect.
  const markerState = await rootSession.exec(`cat ${MARKER} 2>&1; echo; sha256sum ${MARKER} 2>&1;`
    + ` LC_ALL=C stat -c '%F|%U:%G|%a|%s' ${MARKER} 2>&1; echo marker_exit=$?`, 15_000);
  summary.recovery.markerFile = redact(markerState.stdout);
  const leftovers = await rootSession.exec(`ls -la /tmp/.cloudhelm-publish-*.staging /usr/local/share/.cloudhelm-publish-* 2>/dev/null; true`, 15_000);
  summary.recovery.publishLeftovers = redact(leftovers.stdout);
  replayText = await driver.collectReplay();
  summary.metrics = driver.metrics(driven.snapshot, started.id, replayText);

  // No-replay evidence: the killed candidate and its successors are distinct
  // reviewed operations; the successors were dispatched only after the killed
  // operation was explicitly reconciled. Wrap entries are deduped per
  // operation id; the last tracked entry is the final state — the killed
  // lookup follows the same rule, so a mid-flight op is judged by its
  // reconciled terminal state, not its earliest tracked snapshot.
  const killed = [...summary.operations].reverse().find((op) => op.id === summary.recovery.kill?.operationId) ?? null;
  const publishWrapFinal = new Map();
  for (const op of summary.operations.filter((op) => SU_WRAP.test(op.preview) && op.preview.includes(PUBLISH_MARK))) {
    publishWrapFinal.set(op.id, op);
  }
  const stagingFinal = new Map();
  for (const op of summary.operations.filter((op) => op.kind === 'write-file' && op.preview.includes(PUBLISH_MARK))) {
    stagingFinal.set(op.id, op);
  }
  const publishWraps = [...publishWrapFinal.values()];
  const stagingOps = [...stagingFinal.values()];
  const successors = publishWraps.filter((op) => op.id !== killed?.id && op.status !== 'proposed');
  const killedReconciledAt = killed?.reconciledAt ?? null;
  const killAtMs = summary.recovery.kill ? new Date(summary.recovery.kill.at).getTime() : 0;
  // Write-lock evidence: between the cut and the reconciliation nothing
  // non-read-only was dispatched; SafetyGate-blocked proposals
  // (unresolved-prior-operation) are the lock working, not violations.
  const lockViolations = summary.operations.filter((op) => op.id !== killed?.id && op.readOnly !== true && !op.internal
    && new Date(op.at).getTime() > killAtMs
    && (killedReconciledAt === null || new Date(op.at).getTime() < killedReconciledAt)
    && op.failureKind !== 'unresolved-prior-operation');
  const successorAfterReconcile = successors.length >= 2 && killedReconciledAt !== null
    && successors.every((op) => new Date(op.at).getTime() > killedReconciledAt);
  const successorSucceeded = successors.filter((op) => op.status === 'succeeded' && op.exitCode === 0).length >= 2;
  const stagingSucceeded = stagingOps.filter((op) => op.status === 'succeeded').length >= 2;
  summary.recovery.noReplay = {
    killed: killed ? { id: killed.id, status: killed.status, effects: killed.effects, reconciledAt: killed.reconciledAt,
      reconciliation: killed.reconciliation } : null,
    successors: successors.map((op) => ({ id: op.id, status: op.status, exitCode: op.exitCode, createdAt: op.at,
      reconciledBefore: Boolean(killedReconciledAt && new Date(op.at).getTime() > killedReconciledAt) })),
    stagingOperations: stagingOps.map((op) => ({ id: op.id, status: op.status, at: op.at })),
    unresolvedBlocks: summary.operations.filter((op) => op.failureKind === 'unresolved-prior-operation')
      .map((op) => ({ id: op.id, at: op.at })),
    lockViolations: lockViolations.map((op) => ({ id: op.id, kind: op.kind, status: op.status, at: op.at })),
  };
  const fileOk = /g3-netcut-ok/u.test(summary.recovery.markerFile ?? '');
  const markerRoot644 = /regular file\|root:root\|644\|/u.test(summary.recovery.markerFile ?? '');
  const checks = {
    taskAnswered: summary.taskStatus === 'answered',
    suWindowHeld,
    killFired,
    reconnected,
    fileOk,
    markerRoot644,
    killedReconciled: killedReconciledAt !== null,
    lockHonored: lockViolations.length === 0,
    successorAfterReconcile,
    successorSucceeded,
    stagingWritesDone: stagingSucceeded,
    sudoFree: summary.operations.every((op) => !SUDO_WRAP.test(op.preview)),
  };
  summary.checks = checks;
  const pass = checks.taskAnswered && checks.suWindowHeld && checks.killFired && checks.reconnected
    && checks.fileOk && checks.markerRoot644 && checks.killedReconciled && checks.lockHonored
    && checks.successorAfterReconcile && checks.successorSucceeded && checks.stagingWritesDone && checks.sudoFree;
  summary.result = driven.timedOut ? 'timeout'
    : !killFired ? 'kill-window-missed'
      : pass ? 'passed' : 'failed';
  summary.resultDetail = { taskStatus: summary.taskStatus, killFired, reconnected, fileOk, markerRoot644,
    killedStatus: killed?.status ?? null, killedReconciled: killedReconciledAt !== null,
    successorCount: successors.length, lockViolationCount: lockViolations.length };
  record('round-result', { result: summary.result, ...checks });
} catch (error) {
  summary.error = redact(String(error?.stack ?? error));
  process.exitCode = 1;
  if (page) {
    try { await captureQuietDesktop(application, page, path.join(output, 'failure.png'), { timeoutMs: 10_000 }); } catch { /* 应用可能已不可用 */ }
    try {
      const result = await page.evaluate(() => window.cloudhelm.debugReplay('read'));
      if (result?.text) replayText = result.text;
    } catch { /* 应用可能已不可用 */ }
  }
} finally {
  await rootSession.close();
  await cleanupDesktopSmoke(instances, userData, (message) => console.warn(redact(message)));
  summary.finishedAt = new Date().toISOString();
  await writeEvidence(output, summary, replayText, redact);
  console.log(`G3 publish netcut round evidence: ${output}`);
  console.log(redact(JSON.stringify({ label: summary.label, result: summary.result, taskStatus: summary.taskStatus ?? null,
    metrics: summary.metrics ?? null, recovery: summary.recovery.noReplay, checks: summary.checks ?? null, resultDetail: summary.resultDetail })));
}
