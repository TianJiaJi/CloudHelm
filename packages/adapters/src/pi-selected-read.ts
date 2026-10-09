import { isAbsolute } from 'node:path';
import { createReadTool } from '@earendil-works/pi-coding-agent';
import type { BusinessTool } from '@cloudhelm/core';

/** Pi owns paging/truncation; the host retains file authorization and size limits. */
export function createSelectedReadTool(read: (path: string) => Promise<{ data: Buffer }>): BusinessTool<{ path: string; offset?: number; limit?: number }> {
  async function checkedRead(path: string): Promise<Buffer> {
    if (!isAbsolute(path)) throw new Error('Use an absolute selected path');
    const { data } = await read(path);
    if (data.length > 1_048_576 || data.includes(0)) throw new Error('Only UTF-8 text files up to 1 MiB are supported');
    new TextDecoder('utf-8', { fatal: true }).decode(data);
    return data;
  }
  const native = createReadTool('/', { operations: {
    access: async (path) => { await checkedRead(path); }, readFile: checkedRead, detectImageMimeType: async () => null
  } });
  return { name: 'read_selected_text_file', label: 'Read selected local text', replay: 'never', parameters: native.parameters,
    description: 'Read authorized UTF-8 text up to 1 MiB. Use an absolute selected path. Output is paginated/truncated by Pi; offset is a 1-based line number and limit selects the number of lines.',
    async execute(id, args, signal) {
      // Pi resolves local path spelling before invoking operations. Authorize the exact input first.
      await checkedRead(args.path);
      const result = await native.execute(id, args, signal);
      return { ...result, content: result.content.filter((part) => part.type === 'text') };
    }
  };
}
