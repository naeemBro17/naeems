import { useNavigate } from 'react-router-dom';

/**
 * Top-left back arrow (44x44 tap target) shared by the product detail and
 * contact pages. Pops real in-app history when there is any, otherwise falls
 * back to the homepage (e.g. after a hard load straight onto the page).
 *
 * Deliberately plain react-router `useNavigate()`, not the app's wrapped
 * `useAppNavigate` — `navigate(-1)` is a real browser traversal (same as a
 * phone back button), and lib/navigationTransitions.ts is what animates
 * every traversal now, including this one. It also reads which product
 * detail page is currently mounted itself (heroTransition.ts) to know
 * whether to reverse-hero-morph, so this button doesn't need to know or
 * pass that along any more.
 */
export function BackButton() {
  const navigate = useNavigate();

  const goBack = () => {
    if (window.history.length > 2) {
      navigate(-1);
    } else {
      navigate('/');
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
