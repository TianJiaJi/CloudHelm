/* global window */
// G3 supplement evidence 1 runner: privileged deployment of a systemd health
// service through the real client against the isolated VM. One invocation is
// one round: deterministic VM reset -> launch -> model profile -> host connect
// -> fixed deployment task -> drive (auto-approve, answer the privileged
// sudo/su input windows as the user) -> out-of-band deployment verification
// -> redacted evidence write. Rounds are repeatable: identical task text and
// reset state; only the label differs. When the task pauses (e.g. privilege
// blocked awaiting manual takeover), the runner performs the user side of the
// documented "处理后手动继续" interaction: bounded resume probes, each phase's
// status and agent answer recorded, so the report shows what continuing yields.
// Usage: node Tests/smoke/g3-deploy-run.mjs --label deploy-current-r1 [--desktop <path>] [--resume-on-pause N]
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
import { vmResetDeployment, vmVerifyDeployment } from './lib/vm-lifecycle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const label = flag('label');
if (!label) throw new Error('缺少 --label（本轮标识，例如 --label deploy-current-r1）');
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

// Identical across every round and both versions (evidence 3 comparability).
const DEPLOY_TASK = '在这台主机上部署一个 systemd 健康检查服务，要求：'
  + '1. 脚本 /usr/local/share/g3-health/health_server.py：用系统自带的 Python 写一个极简 HTTP 服务，'
  + '监听 127.0.0.1:18080，GET /health 返回 HTTP 200、正文 g3-health-ok，其他路径返回 404。'
  + '2. 服务单元 /etc/systemd/system/g3-health.service：After=network.target，ExecStart 指向该脚本，'
  + 'Restart=on-failure，设为开机自启。'
  + '3. 配置校验（systemd-analyze verify 或等价校验）通过后启动服务，'
  + '并用 curl 实际请求 http://127.0.0.1:18080/health 验证返回。'
  + '完成后报告：单元配置校验结果、服务状态、健康端点 HTTP 状态码与响应正文。'
  + '提权或部署受阻时如实报告受阻阶段与原因，不要伪造结果。';

const output = path.join(root, '.cache/g3-real-machine/supplement', label);
await mkdir(output, { recursive: true });
const summary = { label, startedAt: new Date().toISOString(), desktop, providerId, modelId: modelId ?? null,
  vm: { address: vm.address, port: vm.port, username: vm.username },
  steps: [], operations: [], result: 'incomplete', resultDetail: null };
function record(step, detail = {}) {
  const safe = JSON.parse(redact(JSON.stringify(detail)));
  summary.steps.push({ at: new Date().toISOString(), step, ...safe });
  console.log(`[${step}] ${redact(JSON.stringify(safe))}`);
}

// Round-initial deterministic reset: the reviewer's "same initial snapshot"
// substitute (no hypervisor access); every round starts from verified absence.
summary.reset = await vmResetDeployment(vm, secrets.rootPassword);
record('vm-reset', { initial: summary.reset.initial });
if (!summary.reset.initial.unitAbsent || !summary.reset.initial.dirsAbsent
  || !summary.reset.initial.netAbsent || !summary.reset.initial.portClosed) {
  throw new Error(`VM 重置后初始态不干净：${JSON.stringify(summary.reset.initial)}`);
}

const userData = await mkdtemp(path.join(tmpdir(), 'cloudhelm-g3d-'));
const instances = new Set();
let application = null;
let page = null;
let replayText = null;
try {
  const appEnv = { ...process.env, CLOUDHELM_USER_DATA: userData };
  for (const key of Object.keys(appEnv)) if (key.startsWith('G3_')) delete appEnv[key];
  // The quiet launcher only accepts the main workspace development Electron
  // (44.5.1, same version the old worktree pins); the app bundle itself comes
  // entirely from --desktop, which is what distinguishes old from new rounds.
  application = await quietElectron.launch({ executablePath: createRequire(path.join(root, 'apps/desktop/package.json'))('electron'),
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
  const started = await driver.startTask(host.id, DEPLOY_TASK, model);
  const taskStartedAt = Date.now();
  const stopOn = ['answered', 'paused', 'failed', 'human-control', 'waiting-user'];
  let driven = await driver.drive(started.id, { timeoutMs: 1_200_000, stopOn });
  summary.phases = [{ phase: 1, taskStatus: driven.task?.status ?? 'timeout', timedOut: driven.timedOut === true,
    answer: redact(driver.agentAnswer(driven.snapshot, started.id)).slice(0, 400) }];
  // The pause message instructs "处理后手动继续". The harness's only in-product
  // handling is resuming (no terminal takeover API); each bounded resume
  // observes whether the task can proceed, and a repeated pause ends the round.
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

  summary.deployment = await vmVerifyDeployment(vm, secrets.rootPassword);
  replayText = await driver.collectReplay();
  summary.metrics = driver.metrics(driven.snapshot, started.id, replayText);
  const healthOk = /HTTP\/1\.[01] 200/.test(summary.deployment.healthProbe ?? '')
    && /g3-health-ok/.test(summary.deployment.healthProbe ?? '');
  summary.result = driven.timedOut ? 'timeout'
    : driven.task?.status === 'answered' && healthOk && summary.deployment.isActive === 'active' && summary.deployment.isEnabled === 'enabled'
      ? 'passed' : 'failed';
  summary.resultDetail = { taskStatus: summary.taskStatus, isActive: summary.deployment.isActive,
    isEnabled: summary.deployment.isEnabled, healthOk, configVerify: summary.deployment.configVerify?.slice(0, 300) ?? null };
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
  console.log(`G3 deploy round evidence: ${output}`);
  console.log(redact(JSON.stringify({ label: summary.label, result: summary.result, taskStatus: summary.taskStatus ?? null,
    metrics: summary.metrics ?? null, resultDetail: summary.resultDetail })));
}
