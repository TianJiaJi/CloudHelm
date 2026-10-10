import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useUi } from './store.js';
import { fitTerminal } from './terminal-fit.js';
import { useShortcuts } from './shortcut-store.js';
import { isMacPlatform, menuHint, type ShortcutActionId, type ShortcutContext } from './shortcuts.js';
import { openContextMenu, type ContextMenuEntry } from './context-menu.js';
import { copyText, readClipboardText } from './clipboard.js';
import { registerTerminalActions } from './terminal-actions.js';
import styles from './ui.module.css';

export function TerminalView({ terminalId, report, onQuote, onNewTerminal }: {
  terminalId: string; report(error: string): void; onQuote?(): void; onNewTerminal?(): void;
}): React.JSX.Element {
  const holder = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const shown = useRef(0);
  const tab = useUi((state) => state.terminals[terminalId]);
  const bindings = useShortcuts((state) => state.bindings);
  const shortcutsEnabled = useShortcuts((state) => state.enabled);
  const isMac = isMacPlatform();

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
    const unregister = registerTerminalActions(terminalId, {
      getSelection: () => xterm.getSelection(),
      paste: (text) => xterm.paste(text),
      selectAll: () => xterm.selectAll(),
      clear: () => xterm.clear(),
      focus: () => xterm.focus()
    });
    return () => {
      unregister(); stopFitting(); dispose.dispose(); media.removeEventListener('change', updateTheme); xterm.dispose();
      terminal.current = null; shown.current = 0;
    };
  }, [terminalId, report]);

  useEffect(() => {
    if (!tab || !terminal.current) return;
    const xterm = terminal.current;
    if (shown.current < tab.offset || shown.current > tab.offset + tab.buffer.length) {
      xterm.reset(); shown.current = tab.offset;
    }
    const incoming = tab.buffer.slice(shown.current - tab.offset);
    if (incoming) xterm.write(incoming, () => {
      // xterm writes asynchronously. Following before the callback can leave
      // the viewport above output that has not been parsed yet.
      if (terminal.current === xterm) xterm.scrollToBottom();
    });
    shown.current = tab.offset + tab.buffer.length;
  }, [terminalId, tab?.buffer, tab?.offset]);

  function hint(id: ShortcutActionId, context: ShortcutContext = 'terminal'): string | undefined {
    const value = menuHint(id, bindings, isMac, context, shortcutsEnabled);
    return value ? value.hint : undefined;
  }

  function menuEntries(): ContextMenuEntry[] {
    const xterm = terminal.current;
    if (!xterm) return [];
    return [
      { id: 'copy', label: '复制', icon: 'copy', hint: hint('terminal.copy'), disabled: !xterm.hasSelection(),
        run: () => void copyText(xterm.getSelection()).then((ok) => { if (!ok) report('无法访问剪贴板，请重试或手动选择内容。'); }) },
      { id: 'paste', label: '粘贴', icon: 'attach', hint: hint('terminal.paste'),
        run: () => void readClipboardText().then((text) => { if (text) xterm.paste(text); }).catch(() => report('无法读取剪贴板。')) },
      { id: 'selectAll', label: '全选', hint: hint('terminal.selectAll'), run: () => xterm.selectAll() },
      { id: 'd1', separator: true },
      { id: 'quote', label: '引用输出到 AI', hint: hint('terminal.quote'), disabled: !onQuote, run: () => onQuote?.() },
      { id: 'clear', label: '清屏（仅本地显示）', hint: hint('terminal.clear'), run: () => xterm.clear() },
      { id: 'd2', separator: true },
      { id: 'new', label: '新终端', icon: 'plus', hint: hint('terminal.new'), disabled: !onNewTerminal, run: () => onNewTerminal?.() }
    ];
  }

  return <div className={styles.terminal} aria-label="SSH terminal" data-shortcut-scope="terminal"
    onContextMenu={(event) => openContextMenu(event, menuEntries(), '终端操作')}><div className={styles.terminalViewport} ref={holder} /></div>;
}
