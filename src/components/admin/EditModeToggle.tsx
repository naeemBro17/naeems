import { useAuth } from '../../contexts/AuthContext';
import { useAdminEdit } from '../../contexts/AdminEditContext';

/**
 * Floating Edit Mode switch, fixed above the bottom nav. Rendered only for an
 * approved admin — customers and wholesalers never receive this markup. While
 * Edit Mode is on, a thin orange bar across the top of the viewport makes the
 * state unmistakable.
 */
export function EditModeToggle() {
  const { isAdmin } = useAuth();
  const { isEditMode, toggleEditMode } = useAdminEdit();

  if (!isAdmin) return null;

  return (
    <>
      {isEditMode && <div className="edit-mode-bar" aria-hidden="true" />}
      <button
        type="button"
        className={`edit-mode-toggle${isEditMode ? ' edit-mode-toggle--on' : ''}`}
        onClick={toggleEditMode}
        aria-pressed={isEditMode}
        aria-label={isEditMode ? 'Turn Edit Mode off' : 'Turn Edit Mode on'}
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
    </>
  );
}
