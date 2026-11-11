import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const normalized = (text) => text.replace(/\r\n/gu, '\n');
async function regularFile(root, file) {
  let parent = root;
  for (const segment of ['', ...file.split('/').slice(0, -1)]) {
    parent = path.join(parent, segment);
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Linked parent');
  }
  const stat = await lstat(path.join(root, file));
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Not a regular file');
  return stat;
}

/** Working-tree mirroring is optional; the index never uses these bytes as input. */
export async function captureCleanFiles(root, before, after, dirty) {
  const clean = new Map(), preserved = new Set();
  for (const [file, next] of after) {
    if (before.get(file) === next) continue;
    try {
      const stat = await regularFile(root, file), text = await readFile(path.join(root, file), 'utf8');
      if (normalized(text) === normalized(next)) continue; // Already synchronized locally.
      if (dirty.has(file) || normalized(text) !== normalized(before.get(file))) { preserved.add(file); continue; }
      clean.set(file, { stat, text });
    } catch { preserved.add(file); }
  }
  return { clean, preserved };
}

export async function mirrorCleanFiles(root, after, captured) {
  const rewritten = [];
  for (const [file, saved] of captured.clean) {
    const destination = path.join(root, file), temporary = `${destination}.cloudhelm-version-${randomUUID()}`;
    let ownsTemporary = false;
    try {
      const stat = await regularFile(root, file);
      if (stat.ino !== saved.stat.ino || stat.dev !== saved.stat.dev || stat.mode !== saved.stat.mode
        || await readFile(destination, 'utf8') !== saved.text) throw new Error('Working file changed');
      const next = saved.text.includes('\r\n') && !/(?<!\r)\n/u.test(saved.text)
        ? normalized(after.get(file)).replace(/\n/gu, '\r\n') : after.get(file);
      const handle = await open(temporary, 'wx', stat.mode & 0o777); ownsTemporary = true;
      try { await handle.writeFile(next); } finally { await handle.close(); }
      // Detect editor saves while preparing the replacement. This is not an OS
      // compare-and-swap; do not claim atomicity across Git and the working tree.
      const current = await regularFile(root, file);
      if (current.ino !== stat.ino || current.dev !== stat.dev || current.mode !== stat.mode
        || await readFile(destination, 'utf8') !== saved.text) throw new Error('Working file changed');
      await rename(temporary, destination); ownsTemporary = false; rewritten.push(file);
    } catch { captured.preserved.add(file); }
    finally { if (ownsTemporary) await unlink(temporary); }
  }
  return { rewritten, preserved: [...captured.preserved] };
}
