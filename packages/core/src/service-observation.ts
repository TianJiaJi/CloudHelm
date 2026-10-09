/** Exact read-only systemd query grammar. No remote manager, file output, pager or mutation options. */
export const SERVICE_PROPERTIES = 'Id,LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,InvocationID,Job,CanStart,NeedDaemonReload';
export function validServiceUnit(unit: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,180}\.service$/u.test(unit);
}
export function serviceQuery(unit: string): string {
  if (!validServiceUnit(unit)) throw new Error('请输入明确的 .service 单元名，不支持通配符');
  return `systemctl show --no-pager --property=${SERVICE_PROPERTIES} -- ${unit}`;
}
export function serviceLogQuery(unit: string): string {
  if (!validServiceUnit(unit)) throw new Error('Invalid service unit');
  return `journalctl --no-pager --output=short-iso --lines=80 --unit=${unit}`;
}
export function isServiceQuery(name: string, args: string[]): boolean {
  if (name === 'systemctl') return args.length === 5 && args[0] === 'show' && args[1] === '--no-pager'
    && args[2] === `--property=${SERVICE_PROPERTIES}` && args[3] === '--' && validServiceUnit(args[4]!);
  return name === 'journalctl' && args.length === 4 && args[0] === '--no-pager' && args[1] === '--output=short-iso'
    && args[2] === '--lines=80' && args[3]!.startsWith('--unit=') && validServiceUnit(args[3]!.slice(7));
}
export function serviceObservation(output: string): Record<string, string> {
  const allowed = SERVICE_PROPERTIES.split(',');
  return Object.fromEntries(output.split(/\r?\n/u).flatMap((line) => {
    const index = line.indexOf('=');
    return index > 0 && allowed.includes(line.slice(0, index)) ? [[line.slice(0, index), line.slice(index + 1)]] : [];
  }));
}
