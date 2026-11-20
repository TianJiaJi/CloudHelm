import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useUi } from './store.js';
import { fitTerminal } from './terminal-fit.js';
import { atViewportTail } from './terminal-follow.js';
import { useShortcuts } from './shortcut-store.js';
import { isMacPlatform, menuHint, type ShortcutActionId, type ShortcutContext } from './shortcuts.js';
import { openContextMenu, type ContextMenuEntry } from './context-menu.js';
import { copyText, readClipboardText } from './clipboard.js';
import { registerTerminalActions } from './terminal-actions.js';
import { useTheme } from './theme-store.js';
import styles from './ui.module.css';

function terminalTheme(): { background: string; foreground: string; cursor: string; selectionBackground: string } {
  const computed = getComputedStyle(document.documentElement);
  const token = (name: string): string => computed.getPropertyValue(name).trim();
  return { background: token('--terminalBg'), foreground: token('--text'), cursor: token('--terminalCursor'), selectionBackground: token('--terminalSelection') };
}

export function TerminalView({ terminalId, report, onQuote, onNewTerminal }: {
  terminalId: string; report(error: string): void; onQuote?(): void; onNewTerminal?(): void;
}): React.JSX.Element {
  const holder = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const shown = useRef(0);
  // Following the tail is a user-visible state, never an assumption: continuous
  // output that keeps force-scrolling prevents reading scrollback at all.
  const followed = useRef(true);
  const [pendingBelow, setPendingBelow] = useState(false);
  const tab = useUi((state) => state.terminals[terminalId]);
  const bindings = useShortcuts((state) => state.bindings);
  const shortcutsEnabled = useShortcuts((state) => state.enabled);
  const isMac = isMacPlatform();

  useEffect(() => {
    const element = holder.current;
    if (!element) return;
    const xterm = new Terminal({ cursorBlink: true, fontFamily: 'SFMono-Regular, Consolas, monospace', fontSize: 13,
      lineHeight: 1.2, theme: terminalTheme(), scrollback: 5000 });
    const stopThemeUpdates = useTheme.subscribe(() => { xterm.options.theme = terminalTheme(); });
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
    const stopScrollTracking = xterm.onScroll(() => {
      const buffer = xterm.buffer.active;
      followed.current = atViewportTail(buffer.viewportY, buffer.baseY);
      if (followed.current) setPendingBelow(false);
    });
    const unregister = registerTerminalActions(terminalId, {
      getSelection: () => xterm.getSelection(),
      paste: (text) => xterm.paste(text),
      selectAll: () => xterm.selectAll(),
      clear: () => xterm.clear(),
      focus: () => xterm.focus()
    });
    return () => {
      unregister(); stopFitting(); stopScrollTracking.dispose(); dispose.dispose(); stopThemeUpdates(); xterm.dispose();
      terminal.current = null; shown.current = 0; followed.current = true;
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
      // the viewport above output that has not been parsed yet. Reading history
      // is never interrupted; the indicator below names the new output instead.
      if (terminal.current !== xterm) return;
      if (followed.current) xterm.scrollToBottom(); else setPendingBelow(true);
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

  function jumpToTail(): void {
    followed.current = true;
    setPendingBelow(false);
    terminal.current?.scrollToBottom();
  }

  return <div className={styles.terminal} aria-label="SSH terminal" data-shortcut-scope="terminal"
    onContextMenu={(event) => openContextMenu(event, menuEntries(), '终端操作')}>
    <div className={styles.terminalViewport} ref={holder} />
    {pendingBelow && <button type="button" className={styles.terminalNewOutput}
      onClick={jumpToTail}>有新输出 · 跳到末尾</button>}
  </div>;
}
