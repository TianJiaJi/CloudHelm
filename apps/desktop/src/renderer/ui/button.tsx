import styles from './primitives.module.css';

export type ButtonVariant = 'default' | 'primary' | 'ghost';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'compact' | 'regular';
}

export function Button({ variant = 'default', size = 'regular', type = 'button', ...rest }: ButtonProps): React.JSX.Element {
  const variantClass = variant === 'primary' ? styles.btnPrimary : variant === 'ghost' ? styles.btnGhost : styles.btnDefault;
  return <button type={type} data-variant={variant} data-size={size} className={`${styles.btn} ${variantClass}`} {...rest} />;
}

export function IconButton({ size = 'regular', type = 'button', ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  size?: 'compact' | 'regular';
}): React.JSX.Element {
  return <button type={type} data-size={size} className={styles.iconBtn} {...rest} />;
}
