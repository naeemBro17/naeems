import { BottomSheet } from '../shared/BottomSheet';

interface AccountSheetProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * What the bottom nav's Account tab opens. Customer accounts don't exist yet,
 * and admin/wholesaler sign-in lives on unlisted routes — so this sheet is
 * deliberately the whole of the public account surface.
 */
export function AccountSheet({ isOpen, onClose }: AccountSheetProps) {
  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title="My Account">
      <div className="account-sheet">
        <span className="account-sheet__icon" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21v-1a6 6 0 016-6h4a6 6 0 016 6v1" />
          </svg>
        </span>
        <p className="account-sheet__message">
          Customer accounts coming soon. Check back soon!
        </p>
        <button
          type="button"
          className="button button--primary button--full"
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </BottomSheet>
  );
}
