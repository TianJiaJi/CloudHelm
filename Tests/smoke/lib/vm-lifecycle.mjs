// VM lifecycle helpers for the G3 supplement campaigns: read-only preflight,
// deterministic per-round reset (the reviewer's "same initial snapshot" when
// no hypervisor access exists) and post-run deployment verification. Out-of-band
// root operations use the VM's root SSH account (PermitRootLogin is enabled on
// this isolated test VM); the product under test never sees this channel.
// Credentials arrive ONLY via environment variables and are redacted upstream.
import { vmConnect } from './vm-ssh.mjs';

const clean = (text) => String(text ?? '').trim();

async function openAs(vm, password, username) {
  return vmConnect({ address: vm.address, port: vm.port, username, password });
}

export async function withVm(vm, password, username, run) {
  const session = await openAs(vm, password, username);
  try { return await run(session); } finally { await session.close(); }
}

/** Read-only preflight as the ordinary account plus a root-SSH reachability
 * check. No mutation. */
export function vmPreflight(vm, password) {
  return withVm(vm, password, vm.username, async (session) => {
    const result = {};
    result.selinux = clean((await session.exec('/usr/sbin/getenforce 2>/dev/null || getenforce', 10_000)).stdout);
    result.python27 = clean((await session.exec('command -v python2.7 && python2.7 -V 2>&1 | head -1', 10_000)).stdout);
    result.systemdAnalyze = (await session.exec('command -v systemd-analyze', 10_000)).code === 0;
    const port = await session.exec('curl -s -o /dev/null -m 2 http://127.0.0.1:18080/health; echo exit=$?', 10_000);
    result.port18080 = /exit=7$/u.test(clean(port.stdout)) ? 'closed' : 'open-or-unknown';
    const leftovers = await session.exec('ls -d /etc/systemd/system/g3-health.service /usr/local/share/g3-health'
      + ' /home/admin/g3-health /home/admin/g3-net /tmp/g3-net 2>/dev/null; true', 10_000);
    result.leftovers = clean(leftovers.stdout) || null;
    result.clock = clean((await session.exec('date -Ins', 10_000)).stdout);
    let rootOk = false;
    let rootUid = '';
    try {
      const root = await openAs(vm, password, 'root');
      const id = await root.exec('id -u', 10_000);
      rootOk = id.code === 0 && clean(id.stdout) === '0';
      rootUid = clean(id.stdout);
      await root.close();
    } catch { rootOk = false; }
    result.rootSsh = { reachable: rootOk, uid: rootUid };
    return result;
  });
}

async function cleanState(session) {
  const unit = await session.exec('test -e /etc/systemd/system/g3-health.service; echo unit=$?', 10_000);
  const dirs = await session.exec('ls -d /usr/local/share/g3-health /home/admin/g3-health /home/admin/g3-net 2>/dev/null; true', 10_000);
  const net = await session.exec('test -e /tmp/g3-net; echo net=$?', 10_000);
  const port = await session.exec('curl -s -o /dev/null -m 2 http://127.0.0.1:18080/health; echo exit=$?', 10_000);
  return {
    unitAbsent: /unit=1$/u.test(clean(unit.stdout)),
    dirsAbsent: clean(dirs.stdout) === '',
    netAbsent: /net=1$/u.test(clean(net.stdout)),
    portClosed: /exit=7$/u.test(clean(port.stdout)),
    checkedAt: clean((await session.exec('date -Ins', 10_000)).stdout),
  };
}

/** Deterministic reset to the round's initial state over the out-of-band root
 * SSH channel. Returns performed actions plus the verified clean state. Never
 * throws on missing artifacts — a clean VM is normal. */
export function vmResetDeployment(vm, password) {
  return withVm(vm, password, 'root', async (session) => {
    const actions = [];
    for (const command of ['systemctl stop g3-health', 'systemctl disable g3-health',
      'rm -f /etc/systemd/system/g3-health.service', 'systemctl daemon-reload',
      'rm -rf /usr/local/share/g3-health /home/admin/g3-health /home/admin/g3-net',
      'rm -f /tmp/g3-net',
      'rm -rf /home/admin/.cloudhelm-edit-*']) {
      const run = await session.exec(command, 30_000);
      actions.push({ command, code: run.code });
    }
    const initial = await cleanState(session);
    return { actions, initial };
  });
}

/** Post-run read-only deployment evidence over the out-of-band root SSH
 * channel: service state, unit/script hashes, config validation and a real
 * health-endpoint HTTP request. */
export function vmVerifyDeployment(vm, password) {
  return withVm(vm, password, 'root', async (session) => {
    const evidence = { verifiedAt: clean((await session.exec('date -Ins', 10_000)).stdout) };
    evidence.isActive = clean((await session.exec('systemctl is-active g3-health', 10_000)).stdout);
    evidence.isEnabled = clean((await session.exec('systemctl is-enabled g3-health', 10_000)).stdout);
    evidence.serviceShow = clean((await session.exec('systemctl show g3-health'
      + ' -p ActiveState,SubState,MainPID,ExecMainStartTimestamp', 10_000)).stdout);
    evidence.unitReadback = clean((await session.exec('cat /etc/systemd/system/g3-health.service 2>&1', 10_000)).stdout);
    evidence.unitSha = clean((await session.exec('sha256sum /etc/systemd/system/g3-health.service 2>&1', 10_000)).stdout);
    evidence.scriptSha = clean((await session.exec('sha256sum /usr/local/share/g3-health/health_server.py'
      + ' /home/admin/g3-health/health_server.py 2>/dev/null; true', 10_000)).stdout);
    const verify = await session.exec('systemd-analyze verify /etc/systemd/system/g3-health.service 2>&1; echo verify_exit=$?', 30_000);
    evidence.configVerify = clean(verify.stdout);
    const health = await session.exec('curl -s -i -m 5 http://127.0.0.1:18080/health; echo; echo health_exit=$?', 15_000);
    evidence.healthProbe = clean(health.stdout);
    evidence.listener = clean((await session.exec('ss -ltn 2>/dev/null | grep 18080; true', 10_000)).stdout);
    return evidence;
  });
}
