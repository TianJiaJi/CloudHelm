/* global window */
// G3 supplement evidence 2 runner: hand off a remote write, cut the SSH
// connection mid-flight (out-of-band root SSH kills the admin sshd session —
// the product never sees this channel), then observe the real recovery:
// reconnect, resume, read-only verification first, reconciliation of the
// unknown operation, explicit re-issue (never an automatic replay), final
// answer. Evidence: operation timeline with distinct ids for the killed write
// and its reviewed successor, connection-loss record, reconciliation record.
// Usage: node Tests/smoke/g3-netcut.mjs --label netcut-r1 [--desktop <path>]
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
if (!label) throw new Error('缺少 --label（本轮标识，例如 --label netcut-r1）');
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

// /tmp/g3-net keeps the task path free of the credential-equal home path, so
// redaction never mangles the evidence. Sleep inside the write widens the
// in-flight window so the cut always lands before the file is created.
const NETCUT_TASK = '在这台主机上完成一次文件写入：'
  + '用一条命令创建 /tmp/g3-net，先 sleep 12 秒，然后写入一行内容 net-ok'
  + '（例如 sleep 12 && echo net-ok > /tmp/g3-net）。'
  + '命令结束后读取 /tmp/g3-net 的内容，向我确认文件内容是 net-ok。'
  + '中途如果连接断开、命令结果未知或系统提示需要核验，按系统指引核验后再继续，不要盲目重发。';

const output = path.join(root, '.cache/g3-real-machine/supplement', label);
await mkdir(output, { recursive: true });
const summary = { label, startedAt: new Date().toISOString(), desktop, providerId, modelId: modelId ?? null,
  vm: { address: vm.address, port: vm.port, username: vm.username },
  steps: [], operations: [], recovery: {}, result: 'incomplete', resultDetail: null };
function record(step, detail = {}) {
  const safe = JSON.parse(redact(JSON.stringify(detail)));
  summary.steps.push({ at: new Date().toISOString(), step, ...safe });
  console.log(`[${step}] ${redact(JSON.stringify(safe))}`);
}

summary.reset = await vmResetDeployment(vm, secrets.rootPassword);
record('vm-reset', { initial: summary.reset.initial });
if (!summary.reset.initial.netAbsent || !summary.reset.initial.unitAbsent || !summary.reset.initial.dirsAbsent) {
  throw new Error(`VM 重置后初始态不干净：${JSON.stringify(summary.reset.initial)}`);
}

// Out-of-band root channel: only the disconnection trigger and the final file
// read. The product under test never sees this connection.
const rootSession = await vmConnect({ address: vm.address, port: vm.port, username: 'root', password: secrets.rootPassword });
const userData = await mkdtemp(path.join(tmpdir(), 'cloudhelm-g3n-'));
const instances = new Set();
let application = null;
let page = null;
let replayText = null;
try {
  const appEnv = { ...process.env, CLOUDHELM_USER_DATA: userData };
  for (const key of Object.keys(appEnv)) if (key.startsWith('G3_')) delete appEnv[key];
  application = await quietElectron.launch({ executablePath: createRequire(path.join(desktop, 'package.json'))('electron'),
    args: [path.join(desktop, 'out/main/index.js')], env: appEnv, timeout: 60_000 });
  const owner = new DesktopProcess(application); instances.add(owner); await owner.capture();
  page = await application.firstWindow({ timeout: 60_000 });
  await page.getByRole('textbox', { name: '给 AI 的消息' }).waitFor({ timeout: 60_000 });
  record('launched');

  const driver = createDriver({ page, application, output, secrets, redact, record });
  try { await page.evaluate(() => window.cloudhelm.debugReplay('enable')); record('replay-enabled'); }
  catch { record('replay-unavailable', { note: '旧版无 debugReplay，指标改用任务计数' }); }

  const model = await driver.setupModel({ providerId, modelId });
  const host = await driver.addHostAndConnect(vm);
  const started = await driver.startTask(host.id, NETCUT_TASK, model);
  const taskStartedAt = Date.now();

  let killFired = false;
  let reconnected = false;
  const driven = await driver.drive(started.id, { timeoutMs: 900_000,
    stopOn: ['answered', 'failed', 'human-control', 'waiting-user'],
    onTick: async (latest) => {
      if (!killFired) {
        const target = latest.operations.find((op) => op.taskId === started.id && op.kind === 'command'
          && op.status === 'running' && op.readOnly !== true && !op.internal);
        if (!target) return;
        killFired = true;
        summary.recovery.kill = { at: new Date().toISOString(), operationId: target.id, preview: target.preview.slice(0, 200) };
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

  // Out-of-band final state of the演练 file: the successor write's effect.
  const netState = await rootSession.exec('cat /tmp/g3-net 2>&1; echo; sha256sum /tmp/g3-net 2>&1; echo net_exit=$?', 15_000);
  summary.recovery.netFile = redact(netState.stdout);
  replayText = await driver.collectReplay();
  summary.metrics = driver.metrics(driven.snapshot, started.id, replayText);

  // No-replay evidence: the killed operation and its successor are distinct
  // reviewed operations; the successor was dispatched only after reconciliation.
  const killed = summary.operations.find((op) => op.id === summary.recovery.kill?.operationId);
  const successors = summary.operations.filter((op) => op.kind === 'command' && !op.internal
    && op.id !== killed?.id && /g3-net/u.test(op.preview) && op.status !== 'proposed');
  summary.recovery.noReplay = {
    killed: killed ? { id: killed.id, status: killed.status, effects: killed.effects, reconciledAt: killed.reconciledAt,
      reconciliation: killed.reconciliation } : null,
    successors: successors.map((op) => ({ id: op.id, status: op.status, exitCode: op.exitCode, createdAt: op.at,
      reconciledBefore: Boolean(killed?.reconciledAt && new Date(op.at).getTime() > killed.reconciledAt) })),
    unresolvedBlocks: summary.operations.filter((op) => op.failureKind === 'unresolved-prior-operation')
      .map((op) => ({ id: op.id, at: op.at })),
  };
  const fileOk = /net-ok/u.test(summary.recovery.netFile ?? '');
  summary.result = driven.timedOut ? 'timeout'
    : !killFired ? 'kill-window-missed'
      : driven.task?.status === 'answered' && fileOk ? 'passed' : 'failed';
  summary.resultDetail = { taskStatus: summary.taskStatus, killFired, reconnected, fileOk,
    killedStatus: killed?.status ?? null, killedReconciled: Boolean(killed?.reconciledAt),
    successorCount: successors.length };
  record('round-result', summary.resultDetail);
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
  console.log(`G3 netcut round evidence: ${output}`);
  console.log(redact(JSON.stringify({ label: summary.label, result: summary.result, taskStatus: summary.taskStatus ?? null,
    metrics: summary.metrics ?? null, recovery: summary.recovery.noReplay, resultDetail: summary.resultDetail })));
}
