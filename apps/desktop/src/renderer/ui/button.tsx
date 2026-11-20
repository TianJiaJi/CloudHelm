import styles from './primitives.module.css';

export type ButtonVariant = 'default' | 'primary' | 'ghost';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'compact' | 'regular';
}

export function Button({ variant = 'default', size = 'regular', type = 'button', className, ...rest }: ButtonProps): React.JSX.Element {
  return <button type={type} data-variant={variant} data-size={size} className={className ? `${styles.btn} ${className}` : styles.btn} {...rest} />;
}

export function IconButton({ size = 'regular', type = 'button', className, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  size?: 'compact' | 'regular';
}): React.JSX.Element {
  return <button type={type} data-size={size} className={className ? `${styles.iconBtn} ${className}` : styles.iconBtn} {...rest} />;
}
