import type { InputHTMLAttributes } from 'react';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> & {
  value: number;
  onValueChange(value: number): void;
};

/** NaN is a transient invalid form draft, never a saved value. Native validation
 * blocks submit/test while empty; do not coerce an empty edit into a real zero. */
export function NumberInput({ value, onValueChange, ...props }: Props): React.JSX.Element {
  return <input {...props} type="number" value={Number.isFinite(value) ? value : ''}
    onChange={(event) => onValueChange(event.currentTarget.valueAsNumber)} />;
}
