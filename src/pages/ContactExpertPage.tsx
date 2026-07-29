import { useProducts } from '../contexts/ProductContext';
import { ThemeToggle } from '../components/shared/ThemeToggle';
import { BackButton } from '../components/shared/BackButton';

/** Neutral placeholder avatar shown when no expert photo is set. */
function AvatarPlaceholder() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-1a6 6 0 016-6h4a6 6 0 016 6v1" />
    </svg>
  );
}

export function ContactExpertPage() {
  const { settings } = useProducts();
  const { messenger_link, expert_name, expert_bio, expert_photo_url } = settings;

  const canMessage = messenger_link.trim() !== '';

  const handleMessage = () => {
    if (!canMessage) return;
    window.open(messenger_link, '_blank');
  };

  return (
    <div className="viewer-shell detail-shell">
      <header className="detail-header">
        <BackButton />
        <div className="detail-header__actions">
          <ThemeToggle />
        </div>
      </header>

      <main className="contact-main">
        <div className="contact-card">
          <div className="contact-photo">
            {expert_photo_url ? (
              <img
                src={expert_photo_url}
                alt={expert_name}
                className="contact-photo__img"
              />
            ) : (
              <div className="contact-photo__placeholder">
                <AvatarPlaceholder />
              </div>
            )}
          </div>

          <h1 className="contact-headline">Wanna talk with an expert?</h1>

          {expert_name.trim() !== '' && (
            <p className="contact-byline">— {expert_name}</p>
          )}

          {expert_bio.trim() !== '' && (
            <p className="contact-bio">{expert_bio}</p>
          )}

          <button
            type="button"
            className="button button--primary button--full contact-cta"
            onClick={handleMessage}
            disabled={!canMessage}
          >
            <svg
              className="contact-cta__icon"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M12 2C6.48 2 2 6.13 2 11.25c0 2.92 1.46 5.52 3.75 7.22V22l3.42-1.88c.91.25 1.87.38 2.83.38 5.52 0 10-4.13 10-9.25S17.52 2 12 2zm1.01 12.44l-2.55-2.72-4.98 2.72 5.48-5.82 2.61 2.72 4.92-2.72-5.48 5.82z" />
            </svg>
            Message on Messenger
          </button>
        </div>
      </main>
    </div>
  );
}
