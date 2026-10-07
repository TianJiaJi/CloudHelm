import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { safeDiagnostic, type DiagnosticEvent } from '@cloudhelm/core';

export function diagnosticSettings(development: boolean, env: NodeJS.ProcessEnv, userData: string) {
  const level = env.CLOUDHELM_LOG_LEVEL ?? (development ? 'debug' : 'off');
  return { level: ['debug', 'info', 'error'].includes(level) ? level : 'off', directory: env.CLOUDHELM_LOG_DIR || join(userData, 'logs', 'dev') };
}

/** One main-process writer owns both sinks. Failures cannot affect remote authorization. */
export class DiagnosticLogger {
  private warned = false;
  constructor(private readonly settings: ReturnType<typeof diagnosticSettings>,
    private readonly output: (line: string) => void = (line) => console.log(line),
    private readonly limit = 10 * 1024 * 1024) {
    if (settings.level !== 'off') this.output(`[CloudHelm] 开发日志：${settings.directory}`);
  }
  write(event: DiagnosticEvent): void {
    if (this.settings.level === 'off') return;
    const safe = safeDiagnostic(event);
    const levels = { debug: 0, info: 1, error: 2 };
    if (levels[safe.level ?? 'debug'] < levels[this.settings.level as keyof typeof levels]) return;
    try {
      const record = { time: new Date().toISOString(), ...safe };
      const line = JSON.stringify(record) + '\n';
      this.output(`[CloudHelm ${record.time}] ${safe.event} ${JSON.stringify(safe)}`);
      mkdirSync(this.settings.directory, { recursive: true, mode: 0o700 });
      chmodSync(this.settings.directory, 0o700);
      const file = join(this.settings.directory, 'runtime.jsonl');
      if (existsSync(file) && statSync(file).size + Buffer.byteLength(line) > this.limit) {
        const oldest = join(this.settings.directory, 'runtime.4.jsonl');
        if (existsSync(oldest)) unlinkSync(oldest);
        for (let index = 3; index >= 0; index--) {
          const source = index ? join(this.settings.directory, `runtime.${index}.jsonl`) : file;
          if (existsSync(source)) renameSync(source, join(this.settings.directory, `runtime.${index + 1}.jsonl`));
        }
      }
      appendFileSync(file, line, { mode: 0o600 });
      chmodSync(file, 0o600);
    } catch {
      if (!this.warned) {
        this.warned = true;
        try { this.output('[CloudHelm] 诊断日志写入失败；远端审核策略保持不变。'); } catch { /* Diagnostic sink only. */ }
      }
    }
  }
}
