import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../../hooks/useToast';

interface CollapsingHeaderProps {
  expertName: string;
  expertPhotoUrl: string;
}

/** Scroll depth past which the header turns frosted and reveals the title. */
const COLLAPSE_AT_PX = 200;

export function CollapsingHeader({
  expertName,
  expertPhotoUrl,
}: CollapsingHeaderProps) {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const handleScroll = () => setCollapsed(window.scrollY > COLLAPSE_AT_PX);
    handleScroll();
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const goBack = () => {
    if (window.history.length > 2) {
      navigate(-1);
    } else {
      navigate('/');
    }
  };

  const handleShare = async () => {
    const url = `${window.location.origin}/contact`;
    if (navigator.share) {
      try {
        await navigator.share({ url, title: expertName });
      } catch {
        // User cancelled the share sheet — not an error.
      }
      return;
    }
    await navigator.clipboard.writeText(url);
    showToast('Link copied — share it anywhere');
  };

  return (
    <header className={`exp-header${collapsed ? ' exp-header--collapsed' : ''}`}>
      <button
        type="button"
        className="exp-header__glass-button"
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

      <div className="exp-header__title" aria-hidden={!collapsed}>
        <span className="exp-header__avatar">
          {expertPhotoUrl !== '' ? (
            <img src={expertPhotoUrl} alt="" />
          ) : (
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="8" r="4" />
              <path d="M4 21v-1a6 6 0 016-6h4a6 6 0 016 6v1" />
            </svg>
          )}
        </span>
        <span className="exp-header__name">{expertName}</span>
      </div>

      <button
        type="button"
        className="exp-header__glass-button"
        onClick={handleShare}
        aria-label={`Share ${expertName}'s profile`}
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
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98" />
        </svg>
      </button>
    </header>
  );
}
