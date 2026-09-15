import type { MouseEvent } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useAdminEdit } from '../../contexts/AdminEditContext';

interface EditButtonProps {
  /** Accessible name, e.g. "Edit hero banner". */
  label: string;
  onClick: () => void;
  /** Extra class for per-section positioning. */
  className?: string;
}

/**
 * The pencil that appears on a section while Edit Mode is on. Nothing is
 * rendered for anyone who isn't an approved admin, so customers never receive
 * this markup. For the admin it stays mounted and fades between states, so
 * switching Edit Mode off animates out rather than snapping. Clicks stop
 * propagating so a pencil sitting on a tappable tile doesn't also open it.
 */
export function EditButton({ label, onClick, className }: EditButtonProps) {
  const { isAdmin } = useAuth();
  const { isEditMode } = useAdminEdit();
  if (!isAdmin) return null;

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.preventDefault();
    onClick();
  };

  return (
    <button
      type="button"
      className={`edit-btn${isEditMode ? '' : ' edit-btn--off'}${
        className ? ` ${className}` : ''
      }`}
      onClick={handleClick}
      onPointerDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      aria-label={label}
      aria-hidden={!isEditMode}
      tabIndex={isEditMode ? 0 : -1}
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
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
      </svg>
    </button>
  );
}
