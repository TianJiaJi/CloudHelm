import type { CSSProperties, ReactNode } from 'react';
import styles from './primitives.module.css';

type SurfaceTag = 'aside' | 'div' | 'main' | 'section';

/** Floating rounded panel frame shared by both layout modes. */
export function PanelSurface({ as = 'div', className, style, children }: {
  as?: SurfaceTag; className?: string; style?: CSSProperties; children?: ReactNode;
}): React.JSX.Element {
  const Tag = as;
  return <Tag className={className ? `${styles.panelSurface} ${className}` : styles.panelSurface} style={style}>{children}</Tag>;
}

/** Bordered content card for stream and dialog content. */
export function Card({ as = 'div', tone = 'surface', className, children, ...rest }: {
  as?: 'div' | 'section' | 'form'; tone?: 'surface' | 'raised' | 'accent' | 'warning'; className?: string; children?: ReactNode;
} & Omit<React.HTMLAttributes<HTMLElement>, 'className' | 'children'>): React.JSX.Element {
  const Tag = as;
  return <Tag className={className ? `${styles.card} ${className}` : styles.card} data-tone={tone} {...rest}>{children}</Tag>;
}
