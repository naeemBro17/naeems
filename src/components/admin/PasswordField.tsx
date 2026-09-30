import { useState } from 'react';

interface PasswordFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'new-password' | 'current-password';
  hint?: string;
}

/** Password input with a show/hide eye button (Batch 24). */
export function PasswordField({ id, label, value, onChange, autoComplete, hint }: PasswordFieldProps) {
  const [isVisible, setIsVisible] = useState(false);
  return (
    <div className="form-field">
      <label className="form-label" htmlFor={id}>
        {label}
      </label>
      <div className="password-field">
        <input
          id={id}
          type={isVisible ? 'text' : 'password'}
          className="form-input password-field__input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          autoCapitalize="none"
          spellCheck={false}
        />
        <button
          type="button"
          className="password-field__eye"
          onClick={() => setIsVisible((v) => !v)}
          aria-label={isVisible ? 'Hide password' : 'Show password'}
          aria-pressed={isVisible}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
            <circle cx="12" cy="12" r="3" />
            {isVisible && <path d="M3 3l18 18" />}
          </svg>
        </button>
      </div>
      {hint && <p className="form-hint">{hint}</p>}
    </div>
  );
}
