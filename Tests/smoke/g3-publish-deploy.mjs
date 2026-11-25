/* global window */
// G3 publish acceptance runner 1: full forward deployment of the systemd
// health service on the fixed client, where both root files are created only
// through the structured publish_remote_file channel. One invocation is one
// round: deterministic VM reset -> launch -> model profile -> host connect ->
// fixed prescriptive task (privileged mkdir, two publishes, config verify,
// daemon-reload, enable+start, live health probe) -> drive (auto-approve,
// answer every route/su window as the user side of the controlled channels)
// -> out-of-band deployment verification plus file stats -> redacted evidence
// write. Pass requires: task answered, all route windows su-confirmed, all su
// windows answered, >= 2 staging writes and >= 4 su-wrapped publish script
// successes, zero sudo wraps, service active+enabled, config verify clean,
// health endpoint 200 g3-health-ok, both files root:root 644.
// Usage: node Tests/smoke/g3-publish-deploy.mjs --label publish-deploy-r1 [--desktop <path>] [--resume-on-pause N]
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
import { DesktopProcess, cleanupDesktopSmoke } from './desktop-process.mjs';
import { captureQuietDesktop } from './quiet-screenshot.mjs';
import { createDriver, writeEvidence } from './lib/g3-drive.mjs';
import { vmResetDeployment, vmVerifyDeployment, withVm } from './lib/vm-lifecycle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const label = flag('label');
if (!label) throw new Error('缺少 --label（本轮标识，例如 --label publish-deploy-r1）');
const desktop = path.resolve(flag('desktop') ?? path.join(root, 'apps/desktop'));
const resumeOnPause = Math.max(0, Number(flag('resume-on-pause') ?? '1'));

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

const ROUTE_TITLE = '确认本次操作的提权方式';
const SUDO_WRAP = /^sudo --/u;
const SU_WRAP = /su -l -s \/bin\/sh root -c/u;
const PUBLISH_MARK = '.cloudhelm-publish';
const TARGETS = ['/usr/local/share/g3-health/health_server.py', '/etc/systemd/system/g3-health.service'];

// Identical across every round; the publish channel is the only permitted way
// to create the two root files, so the operation stream proves the channel.
const DEPLOY_TASK = '在这台主机上部署一个 systemd 健康检查服务，硬性要求：'
  + '1. 先用一条特权命令创建目录 /usr/local/share/g3-health（例如 mkdir -p /usr/local/share/g3-health），成功后再进行下一步。'
  + '2. 两个 root 文件必须逐个使用 publish_remote_file 工具发布（属主 root:root、权限 644），'
  + '禁止用 shell 重定向、tee 或任何其他写入方式创建它们：'
  + 'a) /usr/local/share/g3-health/health_server.py：用系统自带的 Python 2.7 写一个极简 HTTP 服务，'
  + '监听 127.0.0.1:18080，GET /health 返回 HTTP 200、正文 g3-health-ok，其他路径返回 404；'
  + 'b) /etc/systemd/system/g3-health.service：[Unit] 段 After=network.target，[Service] 段 '
  + 'ExecStart=/usr/bin/python2.7 /usr/local/share/g3-health/health_server.py、Restart=on-failure，'
  + '[Install] 段 WantedBy=multi-user.target。'
  + '3. 两个文件发布完成后执行 systemd-analyze verify 校验单元配置，通过后 systemctl daemon-reload，'
  + '再启用并启动服务（设置开机自启）。'
  + '4. 用 curl 实际请求 http://127.0.0.1:18080/health 验证返回。'
  + '完成后报告：两个文件的内容 SHA-256、属主与权限，单元配置校验结果，服务状态，健康端点 HTTP 状态码与响应正文。'
  + '提权或部署受阻时如实报告受阻阶段与原因，不要伪造结果。';

const output = path.join(root, '.cache/g3-real-machine/supplement', label);
await mkdir(output, { recursive: true });
const summary = { label, startedAt: new Date().toISOString(),
  testedCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(),
  desktop, providerId, modelId: modelId ?? null,
  vm: { address: vm.address, port: vm.port, username: vm.username },
  steps: [], operations: [], result: 'incomplete', resultDetail: null };
function record(step, detail = {}) {
  const safe = JSON.parse(redact(JSON.stringify(detail)));
  summary.steps.push({ at: new Date().toISOString(), step, ...safe });
  console.log(`[${step}] ${redact(JSON.stringify(safe))}`);
}

// Round-initial deterministic reset; every round starts from verified absence.
summary.reset = await vmResetDeployment(vm, secrets.rootPassword);
record('vm-reset', { initial: summary.reset.initial });
const initial = summary.reset.initial;
if (!initial.unitAbsent || !initial.dirsAbsent || !initial.netAbsent || !initial.portClosed
  || !initial.markerAbsent || !initial.publishTempAbsent) {
  throw new Error(`VM 重置后初始态不干净：${JSON.stringify(initial)}`);
}

const userData = await mkdtemp(path.join(tmpdir(), 'cloudhelm-g3p-'));
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

  const driver = createDriver({ page, application, output, secrets, redact, record });
  try { await page.evaluate(() => window.cloudhelm.debugReplay('enable')); record('replay-enabled'); }
  catch { record('replay-unavailable', { note: '无 debugReplay，指标改用任务计数' }); }

  const model = await driver.setupModel({ providerId, modelId });
  const host = await driver.addHostAndConnect(vm);
  const started = await driver.startTask(host.id, DEPLOY_TASK, model);
  const taskStartedAt = Date.now();
  const stopOn = ['answered', 'paused', 'failed', 'human-control', 'waiting-user'];
  let driven = await driver.drive(started.id, { timeoutMs: 1_200_000, stopOn });
  summary.phases = [{ phase: 1, taskStatus: driven.task?.status ?? 'timeout', timedOut: driven.timedOut === true,
    answer: redact(driver.agentAnswer(driven.snapshot, started.id)).slice(0, 400) }];
  // A pause gets the documented user-side "处理后手动继续": a bounded resume,
  // each phase's status and answer recorded; a repeated pause ends the round.
  let resumesLeft = !driven.timedOut && driven.task?.status === 'paused' ? resumeOnPause : 0;
  while (resumesLeft > 0) {
    resumesLeft -= 1;
    record('pause-observed', { phase: summary.phases.length, resumesLeft });
    await delay(2000);
    await page.evaluate((taskId) => window.cloudhelm.resumeConversation(taskId), started.id);
    record('task-resumed', { phase: summary.phases.length + 1 });
    driven = await driver.drive(started.id, { timeoutMs: 600_000, stopOn });
    summary.phases.push({ phase: summary.phases.length + 1, resumed: true,
      taskStatus: driven.task?.status ?? 'timeout', timedOut: driven.timedOut === true,
      answer: redact(driver.agentAnswer(driven.snapshot, started.id)).slice(0, 400) });
  }
  summary.driveMs = Date.now() - taskStartedAt;
  summary.operations = driver.operations;
  summary.taskStatus = driven.task?.status ?? 'timeout';
  summary.answer = redact(driver.agentAnswer(driven.snapshot, started.id)).slice(0, 800);
  if (driven.task?.status === 'waiting-user') summary.clarifications = driven.snapshot.clarifications ?? [];
  await driver.shot('final');

  // Out-of-band root evidence: service state, hashes, config verify, live
  // health probe, plus per-file stat and publish leftover listing.
  summary.deployment = await vmVerifyDeployment(vm, secrets.rootPassword);
  summary.fileStats = await withVm(vm, secrets.rootPassword, 'root', async (session) => {
    const stats = {};
    for (const file of TARGETS) {
      const stat = await session.exec(`LC_ALL=C stat -c '%F|%U:%G|%a|%s' ${file} 2>&1; echo stat_exit=$?`, 10_000);
      stats[file] = stat.stdout.trim();
    }
    const leftovers = await session.exec('ls /tmp/.cloudhelm-publish-*.staging /usr/local/share/g3-health/.cloudhelm-publish-*'
      + ' /etc/systemd/system/.cloudhelm-publish-* 2>/dev/null; true', 10_000);
    stats.publishLeftovers = leftovers.stdout.trim() || null;
    return stats;
  });
  replayText = await driver.collectReplay();
  summary.metrics = driver.metrics(driven.snapshot, started.id, replayText);

  // Channel verdict from the recorded windows and the operation stream. Wrap
  // entries are deduped per operation id; the last tracked entry is final.
  const steps = summary.steps;
  const routeRequests = steps.filter((item) => item.step === 'input-request' && item.title === ROUTE_TITLE);
  const suWindows = steps.filter((item) => item.step === 'input-request' && /su 身份验证/u.test(`${item.title}`));
  const sudoOps = driver.operations.filter((op) => SUDO_WRAP.test(op.preview));
  const publishWrapFinal = new Map();
  for (const op of driver.operations.filter((op) => SU_WRAP.test(op.preview) && op.preview.includes(PUBLISH_MARK))) {
    publishWrapFinal.set(op.id, op);
  }
  const stagingFinal = new Map();
  for (const op of driver.operations.filter((op) => op.kind === 'write-file' && op.preview.includes(PUBLISH_MARK))) {
    stagingFinal.set(op.id, op);
  }
  const publishWraps = [...publishWrapFinal.values()];
  const stagingOps = [...stagingFinal.values()];
  summary.publishOperations = publishWraps.map((op) => ({ id: op.id, status: op.status, exitCode: op.exitCode, at: op.at }));
  summary.stagingOperations = stagingOps.map((op) => ({ id: op.id, status: op.status, at: op.at }));
  const publishSuSucceeded = publishWraps.filter((op) => op.status === 'succeeded' && op.exitCode === 0);
  const stagingSucceeded = stagingOps.filter((op) => op.status === 'succeeded');
  const healthOk = /HTTP\/1\.[01] 200/.test(summary.deployment.healthProbe ?? '')
    && /g3-health-ok/.test(summary.deployment.healthProbe ?? '');
  const configOk = /verify_exit=0$/u.test(summary.deployment.configVerify ?? '');
  const filesOk = TARGETS.every((file) => /regular file\|root:root\|644\|/u.test(summary.fileStats[file] ?? ''));
  const checks = {
    taskAnswered: summary.taskStatus === 'answered',
    routeWindowsAllSu: routeRequests.length >= 2 && routeRequests.every((item) => item.answered === 'su-confirmation'),
    suWindowsAllAnswered: suWindows.length >= 1 && suWindows.every((item) => item.answered === 'su-root-password'),
    publishSuWrapCount: publishWraps.length,
    publishSuSucceededCount: publishSuSucceeded.length,
    publishSuAllSucceeded: publishSuSucceeded.length >= 4,
    stagingSucceededCount: stagingSucceeded.length,
    stagingWritesDone: stagingSucceeded.length >= 2,
    sudoFree: sudoOps.length === 0,
    serviceActive: summary.deployment.isActive === 'active',
    serviceEnabled: summary.deployment.isEnabled === 'enabled',
    configVerified: configOk,
    healthOk,
    filesRoot644: filesOk,
  };
  summary.checks = checks;
  const pass = checks.taskAnswered && checks.routeWindowsAllSu && checks.suWindowsAllAnswered
    && checks.publishSuAllSucceeded && checks.stagingWritesDone && checks.sudoFree
    && checks.serviceActive && checks.serviceEnabled && checks.configVerified && checks.healthOk && checks.filesRoot644;
  summary.result = driven.timedOut ? 'timeout' : pass ? 'passed' : 'failed';
  summary.resultDetail = { taskStatus: summary.taskStatus, routeWindowCount: routeRequests.length,
    suWindowCount: suWindows.length, publishSuWrapCount: publishWraps.length,
    publishSuSucceededCount: publishSuSucceeded.length, stagingSucceededCount: stagingSucceeded.length,
    sudoWrapCount: sudoOps.length, isActive: summary.deployment.isActive,
    isEnabled: summary.deployment.isEnabled, healthOk, configVerify: summary.deployment.configVerify?.slice(0, 300) ?? null,
    fileStats: summary.fileStats };
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
  await cleanupDesktopSmoke(instances, userData, (message) => console.warn(redact(message)));
  summary.finishedAt = new Date().toISOString();
  await writeEvidence(output, summary, replayText, redact);
  console.log(`G3 publish deploy round evidence: ${output}`);
  console.log(redact(JSON.stringify({ label: summary.label, result: summary.result, taskStatus: summary.taskStatus ?? null,
    metrics: summary.metrics ?? null, checks: summary.checks ?? null })));
}
