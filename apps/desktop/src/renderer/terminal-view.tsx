import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useUi } from './store.js';
import { fitTerminal } from './terminal-fit.js';
import styles from './ui.module.css';

export function TerminalView({ terminalId, report }: { terminalId: string; report(error: string): void }): React.JSX.Element {
  const holder = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const shown = useRef(0);
  const tab = useUi((state) => state.terminals[terminalId]);

  useEffect(() => {
    const element = holder.current;
    if (!element) return;
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const theme = () => media.matches
      ? { background: '#f7f9f8', foreground: '#262d2a', cursor: '#397d6b', selectionBackground: '#b8d6ca' }
      : { background: '#202324', foreground: '#e0e4e2', cursor: '#83b7aa', selectionBackground: '#44665b' };
    const xterm = new Terminal({ cursorBlink: true, fontFamily: 'SFMono-Regular, Consolas, monospace', fontSize: 13,
      lineHeight: 1.2, theme: theme(), scrollback: 5000 });
    const updateTheme = () => { xterm.options.theme = theme(); };
    media.addEventListener('change', updateTheme);
    terminal.current = xterm;
    xterm.open(element);
    const showError = (error: unknown): void => report(error instanceof Error ? error.message : String(error));
    xterm.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'c' && !xterm.hasSelection()) {
        const current = useUi.getState().terminals[terminalId];
        if (current?.taskId) {
          event.preventDefault();
          void window.cloudhelm.stopTerminal(terminalId).catch(showError);
          return false;
        }
      }
      return true;
    });
    const dispose = xterm.onData((data) => {
      // Device responses use a dedicated, backend-validated protocol route. Every
      // user input is checked by the worker against authoritative task/PTY state.
      const protocol = /^(?:\u001b\[(?:\?|>)[\d;]*c|\u001b\[\d+;\d+R)$/u.test(data);
      void (protocol ? window.cloudhelm.terminalProtocolResponse(terminalId, data)
        : window.cloudhelm.terminalInput(terminalId, data)).catch(showError);
    });
    const stopFitting = fitTerminal(xterm, element, (cols, rows) => {
      void window.cloudhelm.resizeTerminal(terminalId, cols, rows).catch(showError);
    });
    return () => {
      stopFitting(); dispose.dispose(); media.removeEventListener('change', updateTheme); xterm.dispose(); terminal.current = null; shown.current = 0;
    };
  }, [terminalId, report]);

  useEffect(() => {
    if (!tab || !terminal.current) return;
    if (shown.current < tab.offset || shown.current > tab.offset + tab.buffer.length) {
      terminal.current.reset(); shown.current = tab.offset;
    }
    terminal.current.write(tab.buffer.slice(shown.current - tab.offset));
    shown.current = tab.offset + tab.buffer.length;
  }, [terminalId, tab?.buffer, tab?.offset]);

  return <div className={styles.terminal} aria-label="SSH terminal"><div className={styles.terminalViewport} ref={holder} /></div>;
}
