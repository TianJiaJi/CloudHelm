import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { SessionStorage } from '@cloudhelm/core';

const entryTypes = new Set(['message', 'thinking_level_change', 'model_change', 'usage', 'compaction',
  'branch_summary', 'custom', 'custom_message', 'context_edit', 'label', 'session_info']);
function validContent(content: unknown): boolean {
  return typeof content === 'string' || (Array.isArray(content) && content.every((part) =>
    part && typeof part === 'object' && typeof part.type === 'string'));
}
function validateEntry(entry: Record<string, unknown>, ids: Set<string>): void {
  if (typeof entry.id !== 'string' || ids.has(entry.id) || typeof entry.type !== 'string' || !entryTypes.has(entry.type)
    || typeof entry.timestamp !== 'string' || !Number.isFinite(Date.parse(entry.timestamp))
    || (entry.parentId !== null && (typeof entry.parentId !== 'string' || !ids.has(entry.parentId)))) throw new Error('原生会话记录损坏，无法安全恢复');
  if (entry.type === 'message') {
    const message = entry.message as Record<string, unknown> | undefined;
    if (!message || !['user', 'assistant', 'toolResult', 'system'].includes(String(message.role))
      || !validContent(message.content) || typeof message.timestamp !== 'number') throw new Error('会话消息损坏');
    if (message.role === 'assistant') {
      const usage = message.usage as Record<string, unknown> | undefined;
      if (typeof message.provider !== 'string' || typeof message.model !== 'string' || !Array.isArray(message.content)
        || !usage || !['input', 'output', 'cacheRead', 'cacheWrite'].every((key) => typeof usage[key] === 'number'
          && Number.isFinite(usage[key]) && (usage[key] as number) >= 0)) throw new Error('模型回复元数据损坏');
    }
    if (message.role === 'toolResult' && (typeof message.toolCallId !== 'string' || typeof message.toolName !== 'string')) throw new Error('工具结果元数据损坏');
  }
  if (entry.type === 'model_change' && (typeof entry.provider !== 'string' || typeof entry.modelId !== 'string')) throw new Error('模型记录损坏');
  if (entry.type === 'custom_message' && !validContent(entry.content)) throw new Error('控制消息损坏');
  if (entry.type === 'compaction' && (typeof entry.summary !== 'string' || typeof entry.firstKeptEntryId !== 'string'
    || !ids.has(entry.firstKeptEntryId))) throw new Error('压缩记录损坏');
}

/** Pi's parser tolerates broken lines; CloudHelm requires an intact, bound transcript. */
export function openSessionStorage(cwd: string, storage?: SessionStorage): SessionManager {
  if (!storage) return SessionManager.inMemory(cwd);
  if (!isAbsolute(storage.directory) || !/^[a-zA-Z0-9-]+$/u.test(storage.id)) throw new Error('Invalid session binding');
  if (!storage.restore) {
    mkdirSync(storage.directory, { recursive: true, mode: 0o700 });
    if (readdirSync(storage.directory).some((name) => name.endsWith('.jsonl'))) throw new Error('Session already exists');
    return SessionManager.create(cwd, storage.directory, { id: storage.id });
  }
  const files = readdirSync(storage.directory).filter((name) => name.endsWith('.jsonl'));
  if (files.length !== 1) throw new Error('原生会话文件缺失或绑定不唯一，无法继续此对话');
  const file = join(storage.directory, files[0]!);
  const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
  const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const header = entries.shift();
  if (header?.type !== 'session' || header.id !== storage.id || header.version !== 3) throw new Error('原生会话格式或绑定不匹配');
  const ids = new Set<string>();
  for (const entry of entries) {
    validateEntry(entry, ids);
    ids.add(entry.id as string);
  }
  if (!entries.some((entry) => entry.type === 'message')) throw new Error('原生会话没有有效消息');
  const manager = SessionManager.open(file, storage.directory, cwd);
  if (manager.getEntries().length !== entries.length) throw new Error('原生会话解析不完整');
  return manager;
}
