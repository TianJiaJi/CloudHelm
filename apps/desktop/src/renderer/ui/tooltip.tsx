import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import styles from './primitives.module.css';

const MARGIN = 8;

/** Hover/focus hint anchored to its trigger, rendered in the popover top layer. */
export function Tooltip({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const id = useId();
  const target = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const hint = tip.current!;
    const anchor = target.current!;
    function position(): void {
      const bounds = anchor.getBoundingClientRect();
      const left = Math.max(MARGIN, Math.min(bounds.left, window.innerWidth - hint.offsetWidth - MARGIN));
      const below = bounds.bottom + 6;
      hint.style.left = `${left}px`;
      hint.style.top = `${below + hint.offsetHeight + MARGIN <= window.innerHeight ? below : Math.max(MARGIN, bounds.top - hint.offsetHeight - 6)}px`;
    }
    hint.showPopover();
    position();
    window.addEventListener('resize', position);
    return () => { window.removeEventListener('resize', position); hint.hidePopover(); };
  }, [open, label]);
  return <span ref={target} className={styles.tooltipTarget} aria-describedby={open ? id : undefined}
    onPointerEnter={() => setOpen(true)}
    onPointerLeave={() => setOpen(false)}
    onFocus={() => setOpen(true)}
    onBlur={() => setOpen(false)}
    onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }}>
    {children}
    {open && <div ref={tip} id={id} popover="manual" role="tooltip" className={styles.tooltip}>{label}</div>}
  </span>;
}
