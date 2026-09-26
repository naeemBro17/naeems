import { useNavigate } from 'react-router-dom';
import { navigateBackWithHeroReverse, navigateWithTransition } from '../../lib/viewTransition';

interface BackButtonProps {
  /** Pass the product this page is showing, on product detail only — lets
   *  the back navigation morph the big image back into the exact grid/bento
   *  card it came from instead of just crossfading (reports/batch-21.txt
   *  Part 1, point 4). Omit on every other page that reuses this button
   *  (contact/expert, etc.) — they get the normal mirrored slide. */
  heroProductId?: string;
}

/**
 * Top-left back arrow (44x44 tap target) shared by the product detail and
 * contact pages. Pops real in-app history when there is any, otherwise falls
 * back to the homepage (e.g. after a hard load straight onto the page).
 */
export function BackButton({ heroProductId }: BackButtonProps = {}) {
  const navigate = useNavigate();

  const goBack = () => {
    const hasRealHistory = window.history.length > 2;
    if (heroProductId && hasRealHistory) {
      navigateBackWithHeroReverse(navigate, heroProductId);
      return;
    }
    if (hasRealHistory) {
      navigateWithTransition(navigate, -1);
    } else {
      navigateWithTransition(navigate, '/');
    }
  };

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
