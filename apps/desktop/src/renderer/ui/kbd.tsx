import styles from './primitives.module.css';

/** Keyboard hint shown next to menu rows and actions. */
export function Kbd({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <kbd className={styles.kbd}>{children}</kbd>;
}
