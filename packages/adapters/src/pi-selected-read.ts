import { isAbsolute } from 'node:path';
import type { BusinessTool } from '@cloudhelm/core';
import { selectedReadParameters, selectedTextPage, validateSelectedRead, type SelectedReadInput } from './selected-text-page.js';

/** Authorization and a fresh read happen on EVERY page. Pi's public truncation
 * primitive still handles normal lines; long lines use this tool's byte mode. */
export function createSelectedReadTool(read: (path: string, signal?: AbortSignal) => Promise<{ data: Buffer }>): BusinessTool<SelectedReadInput> {
  return { name: 'read_selected_text_file', label: 'Read selected local text', replay: 'never', parameters: selectedReadParameters,
    description: 'Read only an authorized absolute local UTF-8 path, up to 1 MiB. Each response is at most 50 KiB including metadata. Use offset/limit for lines (1-based, at most 2000); for long lines use byteOffset/byteLimit instead (0-based, 4–51200 bytes). Never combine line and byte modes. Continue using the returned offsets and expectedSha256 to reject changed files. The page header is metadata, not file content. No local shell is available.',
    async execute(_id, args, signal) {
      validateSelectedRead(args);
      if (!isAbsolute(args.path)) throw new Error('Use an absolute selected path');
      if (signal?.aborted) throw new Error('Operation aborted');
      const { data } = await read(args.path, signal);
      if (signal?.aborted) throw new Error('Operation aborted');
      if (data.length > 1_048_576 || data.includes(0)) throw new Error('Only UTF-8 text files up to 1 MiB are supported');
      new TextDecoder('utf-8', { fatal: true }).decode(data);
      return selectedTextPage(data, args);
    }
  };
}
