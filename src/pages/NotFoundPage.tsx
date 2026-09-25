import { Link } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

/** Shown for any URL that doesn't match a real route. Every screen needs a
 *  visible way out — this replaces the previous silent redirect to "/". */
export function NotFoundPage() {
  useDocumentTitle("Page not found — Naeem's");

  return (
    <div className="viewer-shell detail-shell">
      <main className="detail-main">
        <div className="empty-state">
          <div className="empty-state__icon" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M9.5 9.5h.01M14.5 9.5h.01" />
              <path d="M8.5 15c1-1.2 2.2-1.8 3.5-1.8s2.5.6 3.5 1.8" />
            </svg>
          </div>
          <p className="empty-state__message">Page not found</p>
          <Link to="/" className="button button--secondary">
            Go to homepage
          </Link>
        </div>
      </main>
    </div>
  );
}
