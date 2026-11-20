import { SegmentedControl } from './ui/index.js';
import { Icon } from './ui/icon.js';
import { useUi } from './store.js';
import styles from './layout-switcher.module.css';

/**
 * Top-left layout switch. Renders at identical coordinates in both layouts
 * (first row of each sidebar, same height and padding as the old brand row);
 * the logo lives inside the control, so the app has no separate brand element.
 */
export function LayoutSwitcher(): React.JSX.Element {
  const layoutMode = useUi((state) => state.layoutMode);
  return <div className={styles.switcher}>
    <span className={styles.logo} aria-hidden="true"><Icon name="terminal" size={15} /></span>
    <SegmentedControl ariaLabel="界面布局模式" size="compact" value={layoutMode}
      options={[{ value: 'ssh', label: 'SSH', icon: 'terminal' }, { value: 'agent', label: 'Agent', icon: 'sparkles' }]}
      onValueChange={(mode) => useUi.getState().setLayoutMode(mode)} />
  </div>;
}
