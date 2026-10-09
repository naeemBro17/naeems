import type { InputHTMLAttributes } from 'react';

type MoneyInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  /** Extra class on the wrapper (layout in its row). */
  wrapClassName?: string;
  /** The sign in front: ৳ (default), or % for a percentage discount. */
  sign?: '৳' | '%';
};

/**
 * Batch 35 Part 7: every money field — a number with a fixed ৳ in front.
 * The ৳ sits in its own reserved space (the input's left padding is set
 * by .money-input, which no other input style can override), so the first
 * digit always starts after the sign and never under it.
 */
export function MoneyInput({ className, wrapClassName, sign = '৳', inputMode, step, min, ...rest }: MoneyInputProps) {
  return (
    <span className={`money-input${wrapClassName ? ` ${wrapClassName}` : ''}`} data-testid="money-input">
      <span className="money-input__sign" aria-hidden="true">
        {sign}
      </span>
      <input
        type="number"
        inputMode={inputMode ?? 'decimal'}
        step={step ?? 'any'}
        min={min ?? '0'}
        className={`form-input money-input__field${className ? ` ${className}` : ''}`}
        {...rest}
      />
    </span>
  );
}
