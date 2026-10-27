import { expect, it } from 'vitest';
import { isEffectFreeQuery, isReadOnlyQuery } from '@cloudhelm/core';
import { BashAnalyzer } from './bash-analyzer.js';
const analyzer = new BashAnalyzer();
it.each([
  'ping -c 10 -W 2 114.114.114.114', '/usr/bin/ping -n -c10 -W2 www.example.com', 'ping6 -c 3 -W 1 2001:db8::1',
  'lscpu', 'lsblk -o NAME,SIZE,TYPE,MOUNTPOINTS', 'ip -br addr', 'ip route show', 'ss -ltnp', 'nproc --all',
  'uname -a; lscpu; free -h; df -h; ip -br addr', 'ping -c 1 -W 1 192.0.2.1 || ping -c 1 -W 1 192.0.2.2'
])('attests literal diagnostic effects without granting automatic approval: %s', async (command) => {
  const analysis = await analyzer.analyze(command);
  expect(isEffectFreeQuery(analysis)).toBe(true); expect(isReadOnlyQuery(analysis)).toBe(false);
});
it.each([
  'ping example.com', 'ping -c 10 example.com', 'ping -W 2 example.com', 'ping -c 11 -W 2 example.com',
  'ping -c 0 -W 2 example.com', 'ping -c 10 -W 6 example.com', 'ping -f -c 10 -W 2 example.com',
  'ping -c 10 -W 2 -p 736563726574 example.com', 'ping -c 10 -W 2 -s 65000 example.com',
  'ping -c 10 -W 2 -I eth0 example.com', 'ping -c 1 -c 2 -W 1 example.com',
  'ping -4 -6 -c 1 -W 1 example.com', 'ping -c 1 -W 1 first.example second.example',
  'ping -c "$COUNT" -W 2 example.com', 'ping -c 1 -W 1 $(hostname)', 'ping -c 1 -W 1 example.com > /tmp/out',
  'ping -c 1 -W 1 example.com | tee /tmp/out', 'ping -c 1 -W 1 example.com &',
  'ping -c 1 -W 1 example.com; touch /tmp/file', 'ping -c 1 -W 1 example.com && reboot',
  'sudo ping -c 1 -W 1 example.com', 'env ping -c 1 -W 1 example.com', '/tmp/ping -c 1 -W 1 example.com',
  'ss -K dst 192.0.2.1', 'ss -E', 'ss -F /tmp/filter', 'ip route add default via 192.0.2.1', 'ip link set eth0 down',
  'ip -batch /tmp/input', 'lscpu --sysroot /tmp/root', 'lsblk --output-all /dev/sda',
  'uname -a; echo decoration; lscpu', 'lscpu | head -n 3', 'nproc --all; rm -rf /tmp/something'
])('does not attest unsupported traffic, writes or opaque syntax: %s', async (command) => {
  expect(isEffectFreeQuery(await analyzer.analyze(command))).toBe(false);
});
