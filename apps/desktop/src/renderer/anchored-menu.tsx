import type { ReactNode } from 'react';
import { MenuSurface } from './menu-surface.js';

/** Menu anchored to an element, positioned from its bounding box. */
export function AnchoredMenu({ anchor, label, children, close }: {
  anchor: HTMLElement; label: string; children: ReactNode; close(): void;
}): React.JSX.Element {
  return <MenuSurface anchor={anchor} label={label} close={close}>{children}</MenuSurface>;
}
