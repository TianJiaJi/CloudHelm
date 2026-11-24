/* global window */
// G3 privilege route runner: verification of the route-selection fix
// (228bf89 route confirmation before privileged dispatch, 6c64f9a PTY close
// diagnostics) on the no-sudoers isolated VM. One invocation is one round of
// one scenario:
//   --scenario su     the user picks “通过 su 切换 root” in the route window;
//                     the replay must show the actual su dispatch with no sudo
//                     dispatched first, the su password window answered, and a
//                     successful read of /root.
//   --scenario cancel the user cancels the route window; no privileged command
//                     may be dispatched and no other route may be tried.
//   --scenario reject the user picks “使用 sudo” and then rejects the reviewed
//                     privileged approval; nothing dispatched, no su switch.
// Preconditions are checked out-of-band as the ordinary admin account only —
// no root login and no sudoers change in this round, per the round rules.
// Credentials arrive ONLY via environment variables in the calling script.
// Usage: node Tests/smoke/g3-privilege-route.mjs --label route-su-r1 --scenario su [--desktop <path>]
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { quietElectron } from './quiet-electron.mjs';
import { DesktopProcess, cleanupDesktopSmoke } from './desktop-process.mjs';
import { captureQuietDesktop } from './quiet-screenshot.mjs';
import { createDriver, writeEvidence } from './lib/g3-drive.mjs';
import { vmConnect } from './lib/vm-ssh.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const label = flag('label');
const scenario = flag('scenario');
if (!label) throw new Error('缺少 --label（本轮标识，例如 --label route-su-r1）');
if (!['su', 'cancel', 'reject'].includes(scenario)) throw new Error('缺少或非法 --scenario（su | cancel | reject）');
const desktop = path.resolve(flag('desktop') ?? path.join(root, 'apps/desktop'));

const requiredEnv = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}：G3 凭据只经环境变量注入`);
  return value;
};
if (scenario === 'su' && !process.env.G3_ROOT) throw new Error('su 场景必须提供 G3_ROOT（su 私有窗口的 root 密码）');
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

const ROUTE_TITLE = '确认本次操作的提权方式';
const SUDO_ROUTE = '使用 sudo';
const SUDO_WRAP = /^sudo --/u;
const SU_WRAP = /su -l -s \/bin\/sh root -c/u;
// One privileged read-only command per round; identical text across scenarios.
const TASK = '只读任务：以 root 身份列出 /root 目录下的全部文件（执行一条命令：ls -la /root），把文件列表原样告诉我。'
  + '不要写入或修改任何内容。当前登录账号无法直接读取 /root，需要提权执行。';

const scenarioConfig = {
  su: {
    brief: '选择 su：路线窗选“通过 su 切换 root”，审核通过，su 私有窗口输入 root 密码；实际走 su 且没有先派发 sudo',
    inputDecider: null,
    approvalDecider: null,
  },
  cancel: {
    brief: '取消路线选择：不派发特权命令、不换路线重试',
    inputDecider: (input) => input.kind === 'confirmation' && input.title === ROUTE_TITLE
      ? { cancel: true, rule: 'scenario-cancel-route' } : null,
    approvalDecider: null,
  },
  reject: {
    brief: '拒绝人工审核：路线窗选“使用 sudo”，人工拒绝特权操作审核；不派发、不切 su',
    inputDecider: (input) => input.kind === 'confirmation' && input.title === ROUTE_TITLE
      ? { answer: SUDO_ROUTE, rule: 'scenario-sudo-route' } : null,
    approvalDecider: (approval) => !SUDO_WRAP.test(approval.preview),
  },
}[scenario];

const output = path.join(root, '.cache/g3-real-machine/supplement', label);
await mkdir(output, { recursive: true });
const summary = { label, scenario, scenarioBrief: scenarioConfig.brief,
  testedCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(),
  startedAt: new Date().toISOString(), desktop, providerId, modelId: modelId ?? null,
  vm: { address: vm.address, port: vm.port, username: vm.username },
  roundRules: { sudoersUntouched: true, noRootLoginOutOfBand: true },
  steps: [], operations: [], result: 'incomplete', resultDetail: null };
function record(step, detail = {}) {
  const safe = JSON.parse(redact(JSON.stringify(detail)));
  summary.steps.push({ at: new Date().toISOString(), step, ...safe });
  console.log(`[${step}] ${redact(JSON.stringify(safe))}`);
}

// Admin-only precondition: ordinary account, no root channel this round.
{
  const session = await vmConnect({ address: vm.address, port: vm.port, username: vm.username, password: secrets.password });
  try {
    const uid = await session.exec('id -u', 15_000);
    const lsRoot = await session.exec('ls -la /root', 15_000);
    const sudoProbe = await session.exec('sudo -n true', 15_000);
    summary.precondition = { uid: { code: uid.code, stdout: uid.stdout.trim() },
      lsRoot: { code: lsRoot.code, stderr: redact(lsRoot.stderr.trim().slice(0, 200)) },
      sudoNonInteractive: { code: sudoProbe.code, stdout: sudoProbe.stdout.trim().slice(0, 200),
        stderr: redact(sudoProbe.stderr.trim().slice(0, 200)) } };
    if (uid.code !== 0 || uid.stdout.trim() !== '1000') throw new Error(`前置条件不成立：id -u 返回 ${JSON.stringify(summary.precondition.uid)}`);
    if (lsRoot.code === 0) throw new Error('前置条件不成立：admin 能直接读取 /root');
    if (sudoProbe.code === 0) throw new Error('前置条件不成立：admin 具备非交互 sudo 能力');
    record('precondition-ok', summary.precondition);
  } finally {
    await session.close();
  }
}

const userData = await mkdtemp(path.join(tmpdir(), 'cloudhelm-g3r-'));
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

  const driver = createDriver({ page, application, output, secrets, redact, record,
    inputDecider: scenarioConfig.inputDecider, approvalDecider: scenarioConfig.approvalDecider });
  try { await page.evaluate(() => window.cloudhelm.debugReplay('enable')); record('replay-enabled'); }
  catch { record('replay-unavailable', { note: '无 debugReplay，指标改用任务计数' }); }

  const model = await driver.setupModel({ providerId, modelId });
  const host = await driver.addHostAndConnect(vm);
  const started = await driver.startTask(host.id, TASK, model);
  const taskStartedAt = Date.now();
  const driven = await driver.drive(started.id, { timeoutMs: 900_000,
    stopOn: ['answered', 'paused', 'failed', 'human-control', 'waiting-user'] });
  summary.driveMs = Date.now() - taskStartedAt;
  summary.operations = driver.operations;
  summary.taskStatus = driven.task?.status ?? 'timeout';
  summary.answer = redact(driver.agentAnswer(driven.snapshot, started.id)).slice(0, 800);
  if (driven.task?.status === 'waiting-user') summary.clarifications = driven.snapshot.clarifications ?? [];
  await driver.shot('final');

  replayText = await driver.collectReplay();
  summary.metrics = driver.metrics(driven.snapshot, started.id, replayText);

  // Scenario verdict from the recorded steps and operation stream.
  const steps = summary.steps;
  const routeRequests = steps.filter((item) => item.step === 'input-request' && item.title === ROUTE_TITLE);
  const suWindows = steps.filter((item) => item.step === 'input-request' && /su 身份验证/u.test(`${item.title}`));
  const approvalsSeen = steps.filter((item) => item.step === 'approval');
  const approvalsDecided = steps.filter((item) => item.step === 'approval-decided');
  const executed = (op) => op.exitCode !== null || ['succeeded', 'failed', 'running', 'unknown'].includes(op.status);
  const sudoOps = driver.operations.filter((op) => SUDO_WRAP.test(op.preview));
  const suOps = driver.operations.filter((op) => SU_WRAP.test(op.preview));
  const executedPrivileged = driver.operations.filter((op) => (SUDO_WRAP.test(op.preview) || SU_WRAP.test(op.preview)) && executed(op));
  const checks = { routeWindowShown: routeRequests.length >= 1,
    routeWindowCancelled: routeRequests.length >= 1 && routeRequests.every((item) => item.cancelled === true),
    routeAnsweredSu: routeRequests.length >= 1 && routeRequests.every((item) => item.answered === 'su-confirmation'),
    routeAnsweredSudo: routeRequests.length >= 1 && routeRequests.every((item) => item.answered === 'scenario-sudo-route'),
    sudoDispatchedFirst: sudoOps.length >= 1,
    suWindowShown: suWindows.length >= 1,
    suWindowAnswered: suWindows.length >= 1 && suWindows.every((item) => item.answered === 'su-root-password'),
    privilegedApprovalSeen: approvalsSeen.some((item) => SUDO_WRAP.test(item.preview ?? '') || SU_WRAP.test(item.preview ?? '')),
    privilegedApprovalRejected: approvalsDecided.some((item) => item.approved === false),
    privilegedDispatchCount: executedPrivileged.length,
    suWrapExecuted: suOps.some(executed),
    suWrapSucceeded: suOps.some((op) => op.status === 'succeeded' && op.exitCode === 0),
    sudoWrapPresent: sudoOps.length >= 1,
    suWrapPresent: suOps.length >= 1,
    taskAnswered: summary.taskStatus === 'answered' };
  summary.checks = checks;
  const pass = {
    su: checks.routeWindowShown && checks.routeAnsweredSu && checks.suWindowAnswered && checks.suWrapSucceeded
      && !checks.sudoWrapPresent && checks.privilegedDispatchCount >= 1 && checks.taskAnswered,
    cancel: checks.routeWindowShown && checks.routeWindowCancelled && checks.privilegedDispatchCount === 0
      && !checks.privilegedApprovalSeen && !checks.suWindowShown && checks.taskAnswered,
    reject: checks.routeWindowShown && checks.routeAnsweredSudo && checks.privilegedApprovalSeen && checks.privilegedApprovalRejected
      && checks.privilegedDispatchCount === 0 && !checks.suWrapPresent && !checks.suWindowShown && checks.taskAnswered,
  }[scenario];
  summary.result = driven.timedOut ? 'timeout' : pass ? 'passed' : 'failed';
  summary.resultDetail = { scenario, taskStatus: summary.taskStatus,
    routeWindowCount: routeRequests.length, suWindowCount: suWindows.length,
    privilegedDispatchCount: checks.privilegedDispatchCount, privilegedApprovalCount: approvalsSeen.length };
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
  await cleanupDesktopSmoke(instances, userData, (message) => console.warn(redact(message)));
  summary.finishedAt = new Date().toISOString();
  await writeEvidence(output, summary, replayText, redact);
  console.log(`G3 privilege route evidence: ${output}`);
  console.log(redact(JSON.stringify({ label: summary.label, scenario, result: summary.result,
    taskStatus: summary.taskStatus ?? null, checks: summary.checks ?? null, metrics: summary.metrics ?? null })));
}
