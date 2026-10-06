import { useCallback, useRef, useState } from 'react';
import { presentError, type ErrorContext, type ErrorPresentation } from './error-presentation.js';

function noticeKey(notice: ErrorPresentation): string {
  return JSON.stringify([notice.code, notice.context]);
}

export function useErrorNotices(): {
  current: ErrorPresentation | undefined;
  report(message: string, context?: ErrorContext): void;
  dismiss(): void;
} {
  const [notices, setNotices] = useState<ErrorPresentation[]>([]);
  const recent = useRef(new Map<string, number>());
  const report = useCallback((message: string, context?: ErrorContext) => {
    if (!message.trim()) return;
    const notice = presentError(message);
    if (notice.code === 'human-control' || notice.code === 'terminal-busy') notice.context = context;
    const key = noticeKey(notice);
    const now = Date.now();
    for (const [code, shownAt] of recent.current) if (now - shownAt >= 8000) recent.current.delete(code);
    if (recent.current.has(key)) return;
    recent.current.set(key, now);
    setNotices((current) => current.some((item) => noticeKey(item) === key) ? current : [...current.slice(0, 4), notice]);
  }, []);
  const dismiss = useCallback(() => { setNotices((current) => current.slice(1)); }, []);
  return { current: notices[0], report, dismiss };
}
