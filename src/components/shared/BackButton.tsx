import { useNavigate } from 'react-router-dom';
import { navigateBack } from '../../lib/viewTransition';

/**
 * Top-left back arrow (44x44 tap target) shared by the product detail and
 * contact pages. Pops real in-app history when there is any, otherwise falls
 * back to the homepage (e.g. after a hard load straight onto the page).
 *
 * Goes through lib/viewTransition.ts's navigateBack, which starts the View
 * Transition from this click itself (the Batch 21 approach) — leaving a
 * product page morphs its image back into the card it came from.
 */
export function BackButton() {
  const navigate = useNavigate();

  const goBack = () => navigateBack(navigate);

  return (
    <button
      type="button"
      className="detail-header__back"
      onClick={goBack}
      aria-label="Go back"
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
        <path d="M19 12H5" />
        <path d="M12 19l-7-7 7-7" />
      </svg>
    </button>
  );
}
