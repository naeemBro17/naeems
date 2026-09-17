import type { ReactNode } from 'react';

interface SheetFooterProps {
  onCancel: () => void;
  isSaving: boolean;
  /** Disables Save (e.g. required field empty). */
  disabled?: boolean;
  saveLabel?: string;
}

/**
 * The footer every edit sheet ends with: a text Cancel above a full-width
 * orange Save that shows a spinner while the request is in flight.
 */
export function SheetFooter({
  onCancel,
  isSaving,
  disabled = false,
  saveLabel = 'Save',
}: SheetFooterProps) {
  return (
    <div className="edit-sheet__footer">
      <button
        type="button"
        className="edit-sheet__cancel"
        onClick={onCancel}
        disabled={isSaving}
      >
        Cancel
      </button>
      <button
        type="submit"
        className="edit-sheet__save"
        disabled={isSaving || disabled}
      >
        {isSaving ? <span className="spinner" aria-hidden="true" /> : saveLabel}
      </button>
    </div>
  );
}

interface ReorderRowProps {
  index: number;
  count: number;
  dragIndex: number | null;
  onDragStart: (index: number) => void;
  onDragEnd: () => void;
  onDrop: (index: number) => void;
  onMove: (from: number, to: number) => void;
  /** Accessible name of the item, used by the handle and arrow buttons. */
  label: string;
  /** Optional class on the row (e.g. a dimmed state for hidden items). */
  className?: string;
  children: ReactNode;
}

/**
 * One row in a reorderable list. The handle drives HTML5 drag on desktop;
 * the up/down arrows do the same job on touch, where drag events don't fire.
 */
export function ReorderRow({
  index,
  count,
  dragIndex,
  onDragStart,
  onDragEnd,
  onDrop,
  onMove,
  label,
  className,
  children,
}: ReorderRowProps) {
  return (
    <li
      className={`edit-row${dragIndex === index ? ' edit-row--dragging' : ''}${
        className ? ` ${className}` : ''
      }`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={() => onDrop(index)}
    >
      <span
        className="edit-row__handle"
        draggable
        onDragStart={() => onDragStart(index)}
        onDragEnd={onDragEnd}
        aria-label={`Drag to reorder ${label}`}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01" />
        </svg>
      </span>

      <div className="edit-row__body">{children}</div>

      <span className="edit-row__arrows">
        <button
          type="button"
          className="edit-row__arrow"
          onClick={() => onMove(index, index - 1)}
          disabled={index === 0}
          aria-label={`Move ${label} up`}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 14l6-6 6 6" />
          </svg>
        </button>
        <button
          type="button"
          className="edit-row__arrow"
          onClick={() => onMove(index, index + 1)}
          disabled={index === count - 1}
          aria-label={`Move ${label} down`}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 10l6 6 6-6" />
          </svg>
        </button>
      </span>
    </li>
  );
}

interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  small?: boolean;
}

/** The app's switch control, sized for a list row when `small`. */
export function Toggle({ checked, onChange, label, small = false }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle${small ? ' toggle--small' : ''}${checked ? ' toggle--on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle__thumb" aria-hidden="true" />
    </button>
  );
}

/** Small icon-only row action (edit / delete / remove). */
export function RowIconButton({
  label,
  onClick,
  variant = 'neutral',
  children,
}: {
  label: string;
  onClick: () => void;
  variant?: 'neutral' | 'danger';
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`edit-row__icon edit-row__icon--${variant}`}
      onClick={onClick}
      aria-label={label}
    >
      {children}
    </button>
  );
}

export function PencilGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  );
}

export function TrashGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
    </svg>
  );
}

/** Multi-select pill chips for one group of tags (e.g. skin type / condition). */
export function ChipGroup({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: readonly string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (value: string) => {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };

  return (
    <div className="form-field">
      <span className="form-label">{label}</span>
      <div className="chip-group" role="group" aria-label={label}>
        {options.map((option) => {
          const on = selected.includes(option);
          return (
            <button
              key={option}
              type="button"
              className={`chip-select${on ? ' chip-select--on' : ''}`}
              aria-pressed={on}
              onClick={() => toggle(option)}
            >
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function CloseGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}
