import { Icon, type IconName } from './icon.js';
import styles from './primitives.module.css';

export interface SegmentedOption<T extends string> { value: T; label: string; icon?: IconName }

/** Radio-style segmented control; the single source for mode switches. */
export function SegmentedControl<T extends string>({ options, value, onValueChange, size = 'regular', ariaLabel }: {
  options: SegmentedOption<T>[]; value: T; onValueChange(value: T): void; size?: 'compact' | 'regular'; ariaLabel: string;
}): React.JSX.Element {
  return <div className={styles.seg} role="radiogroup" aria-label={ariaLabel} data-size={size}>
    {options.map((option) => <button key={option.value} type="button" role="radio" aria-checked={option.value === value}
      className={styles.segButton} data-active={option.value === value}
      onClick={() => { if (option.value !== value) onValueChange(option.value); }}>
      {option.icon && <Icon name={option.icon} size={size === 'compact' ? 12 : 13} />}{option.label}
    </button>)}
  </div>;
}
