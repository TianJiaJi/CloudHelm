/** Whether the terminal viewport is at (or within one row of) the live tail.
 *
 * Output must never yank a reader back while they are reading scrollback, and a
 * reader who is at the tail should keep following without extra clicks. The
 * tolerance covers sub-row rounding after a resize.
 */
export function atViewportTail(viewportY: number, baseY: number): boolean {
  if (!Number.isFinite(viewportY) || !Number.isFinite(baseY)) return true;
  return viewportY >= baseY - 1;
}
