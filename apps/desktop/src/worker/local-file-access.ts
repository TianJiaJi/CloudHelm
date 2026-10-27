import { open, realpath, stat } from 'node:fs/promises';
import { constants, type BigIntStats } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { LocalScope } from '@cloudhelm/contracts';
import { selectedDirectoryPage, type SelectedDirectoryPage } from './selected-directory-page.js';

const MAX_LOCAL_BYTES = 1_048_576;
const aborted = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error('Operation aborted'); };
function inside(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
async function checkedPath(scope: LocalScope, requested: string): Promise<string> {
  if (!path.isAbsolute(requested)) throw new Error('Use an absolute local path from the selected scope');
  const actualRoot = await realpath(scope.path);
  if (actualRoot !== scope.path) throw new Error('The selected local source changed; select it again');
  const actualTarget = await realpath(requested);
  if (scope.kind === 'file' ? actualTarget !== actualRoot : !inside(actualTarget, actualRoot)) {
    throw new Error('Local path is outside the selected source');
  }
  return actualTarget;
}
function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

export class LocalFileAccess {
  private readonly cursorKey = randomBytes(32);
  constructor(private readonly scopes: LocalScope[]) {}

  findScope(requested: string): LocalScope | undefined {
    return this.scopes.find((scope) => scope.kind === 'file' ? requested === scope.path : inside(requested, scope.path));
  }
  private assertScope(requested: string, previous: LocalScope): void {
    const current = this.findScope(requested);
    if (!current || current.path !== previous.path || current.kind !== previous.kind) {
      throw new Error('Local path is outside the current selected sources; authorization changed');
    }
  }

  async read(requested: string, signal?: AbortSignal): Promise<{ data: Buffer; scope: LocalScope }> {
    aborted(signal);
    const scope = this.findScope(requested);
    if (!scope) throw new Error('File is outside the selected local sources');
    const actual = await checkedPath(scope, requested);
    const before = await stat(actual, { bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_LOCAL_BYTES)) throw new Error('Only regular local files up to 1 MiB are supported');
    aborted(signal);
    const file = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let data: Buffer;
    try {
      if (!sameFile(before, await file.stat({ bigint: true }))) throw new Error('Selected file changed while opening; read it again');
      // The extra byte detects growth without unbounded allocation/readFile on a
      // file that changes after stat. Binary uploads still use this same boundary.
      const buffer = Buffer.alloc(Number(before.size) + 1);
      let length = 0;
      while (length < buffer.length) {
        aborted(signal);
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      aborted(signal);
      if (length !== Number(before.size) || !sameFile(before, await file.stat({ bigint: true }))) {
        throw new Error('Selected file changed while reading; read it again');
      }
      this.assertScope(requested, scope);
      if (await checkedPath(scope, requested) !== actual || !sameFile(before, await stat(actual, { bigint: true }))) {
        throw new Error('Selected file changed while reading; read it again');
      }
      data = buffer.subarray(0, length);
    } finally { await file.close(); }
    // Closing the descriptor is asynchronous too. Do not disclose data if the
    // source was revoked or the request cancelled during that final boundary.
    aborted(signal);
    this.assertScope(requested, scope);
    return { data, scope };
  }

  async list(requested: string, cursor?: string, signal?: AbortSignal): Promise<SelectedDirectoryPage> {
    aborted(signal);
    const scope = this.findScope(requested);
    if (!scope || scope.kind !== 'directory') throw new Error('Directory is outside the selected local sources');
    const actual = await checkedPath(scope, requested);
    const page = await selectedDirectoryPage(actual, scope.path, this.cursorKey, cursor, signal);
    this.assertScope(requested, scope);
    if (await checkedPath(scope, requested) !== actual) throw new Error('Selected directory changed during listing; select it again');
    aborted(signal);
    this.assertScope(requested, scope);
    return page;
  }
}
