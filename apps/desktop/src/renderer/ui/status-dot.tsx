import styles from './primitives.module.css';

/** Connection/state indicator dot; the only status-dot implementation. */
export function StatusDot({ active = false, size = 6 }: { active?: boolean; size?: number }): React.JSX.Element {
  return <i className={styles.statusDot} data-active={active} style={{ width: size, height: size }} aria-hidden="true" />;
}
