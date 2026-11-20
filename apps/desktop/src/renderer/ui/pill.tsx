import type { ReactNode } from 'react';
import styles from './primitives.module.css';

/** Compact outlined label for read-only metadata. */
export function Pill({ className, title, children }: { className?: string; title?: string; children?: ReactNode }): React.JSX.Element {
  return <span className={className ? `${styles.pill} ${className}` : styles.pill} title={title}>{children}</span>;
}

/** Accent count bubble for pending work. */
export function Badge({ children }: { children: ReactNode }): React.JSX.Element {
  return <b className={styles.badge}>{children}</b>;
}
