import { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

/** Fit the measured cell grid into a padding-free viewport and synchronize the PTY. */
export function fitTerminal(terminal: Terminal, viewport: HTMLElement, resize: (cols: number, rows: number) => void): () => void {
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  let disposed = false;
  let frame = 0;
  let lastCols = 0;
  let lastRows = 0;
  const update = (): void => {
    frame = 0;
    if (disposed || viewport.clientWidth === 0 || viewport.clientHeight === 0) return;
    fit.fit();
    if (terminal.cols === lastCols && terminal.rows === lastRows) return;
    lastCols = terminal.cols; lastRows = terminal.rows;
    resize(lastCols, lastRows);
  };
  const schedule = (): void => {
    if (!disposed && !frame) frame = window.requestAnimationFrame(update);
  };
  const observer = new ResizeObserver(schedule);
  observer.observe(viewport);
  // Font metrics and device scale can change without changing the outer viewport.
  if (terminal.element) observer.observe(terminal.element);
  window.addEventListener('resize', schedule);
  document.fonts.addEventListener('loadingdone', schedule);
  void document.fonts.ready.then(schedule);
  update();
  return () => {
    disposed = true;
    window.cancelAnimationFrame(frame);
    observer.disconnect();
    window.removeEventListener('resize', schedule);
    document.fonts.removeEventListener('loadingdone', schedule);
    fit.dispose();
  };
}
