import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useProducts } from '../contexts/ProductContext';
import { useToast } from '../hooks/useToast';
import { averageRating, REVIEW_SELECT } from '../lib/reviews';
import { openExternal, whatsAppUrl } from '../lib/expertLinks';
import { CollapsingHeader } from '../components/expert/CollapsingHeader';
import { StatsRow } from '../components/expert/StatsRow';
import { SocialLinks } from '../components/expert/SocialLinks';
import { ReviewCard } from '../components/expert/ReviewCard';
import { ReviewSubmitSheet } from '../components/expert/ReviewSubmitSheet';
import { StarRating } from '../components/expert/StarRating';
import { useAdminEdit } from '../contexts/AdminEditContext';
import { EditButton } from '../components/admin/EditButton';
import { EditModeToggle } from '../components/admin/EditModeToggle';
import {
  ExpertEditSheet,
  type ExpertEditSection,
} from '../components/admin/edit-sheets/ExpertEditSheet';
import type { Review } from '../types';

/** Initials shown when no expert photo is set. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return parts
    .slice(0, 2)
    .map((p) => p.charAt(0).toUpperCase())
    .join('');
}

function MapPinIcon() {
  return (
    <svg
      className="exp-pill__icon"
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0116 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function PersonPlusIcon() {
  return (
    <svg
      className="exp-pill__icon"
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2" />
      <circle cx="8.5" cy="7" r="4" />
      <path d="M19 8v6M22 11h-6" />
    </svg>
  );
}

export function ContactExpertPage() {
  const { settings } = useProducts();
  const { showToast } = useToast();
  const { isEditMode } = useAdminEdit();

  const [editSection, setEditSection] = useState<ExpertEditSection | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [heroImageFailed, setHeroImageFailed] = useState(false);
  const [showAllReviews, setShowAllReviews] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);

  // Approved, visible reviews in the order the admin arranged them.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('reviews')
        .select(REVIEW_SELECT)
        .eq('is_approved', true)
        .eq('is_visible', true)
        .order('sort_order', { ascending: true });
      if (cancelled) return;
      if (error) {
        console.error('Review load failed:', error);
        return;
      }
      setReviews((data ?? []) as Review[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const {
    expert_name,
    expert_photo_url,
    expert_bio,
    expert_location,
    expert_title,
    expert_reply_time,
    expert_facebook_url,
    expert_appointment_url,
    expert_whatsapp_url,
  } = settings;

  // A newly saved photo gets a fresh chance to load.
  useEffect(() => {
    setHeroImageFailed(false);
  }, [expert_photo_url]);

  const stats = useMemo(
    () => [
      { value: settings.expert_stat_1_value, label: settings.expert_stat_1_label },
      { value: settings.expert_stat_2_value, label: settings.expert_stat_2_label },
      { value: settings.expert_stat_3_value, label: settings.expert_stat_3_label },
    ],
    [settings]
  );

  const average = averageRating(reviews);
  const visibleReviews = showAllReviews ? reviews : reviews.slice(0, 1);
  const whatsapp = whatsAppUrl(expert_whatsapp_url);

  const handleFollow = useCallback(() => {
    const url = expert_facebook_url.trim();
    if (url === '') {
      showToast('Coming Soon');
      return;
    }
    openExternal(url);
  }, [expert_facebook_url, showToast]);

  const handleBook = useCallback(() => {
    const url = expert_appointment_url.trim();
    if (url === '') {
      showToast('Coming Soon');
      return;
    }
    openExternal(url);
  }, [expert_appointment_url, showToast]);

  return (
    <div className="expert-page">
      <CollapsingHeader expertName={expert_name} expertPhotoUrl={expert_photo_url} />

      <div className="exp-hero">
        {expert_photo_url !== '' && !heroImageFailed ? (
          <img
            className="exp-hero__photo"
            src={expert_photo_url}
            alt={expert_name}
            onError={() => setHeroImageFailed(true)}
          />
        ) : (
          <div className="exp-hero__fallback" aria-hidden="true">
            <span className="exp-hero__initials">{initialsOf(expert_name)}</span>
          </div>
        )}

        <div className="exp-hero__scrim" aria-hidden="true" />

        {expert_location.trim() !== '' && (
          <span className="exp-pill exp-pill--location">
            <MapPinIcon />
            {expert_location}
          </span>
        )}

        <button type="button" className="exp-pill exp-pill--follow" onClick={handleFollow}>
          <PersonPlusIcon />
          Follow
        </button>

        <div className="exp-hero__name-block">
          <h1 className="exp-hero__name">{expert_name}</h1>
          {expert_title.trim() !== '' && (
            <p className="exp-hero__subtitle">{expert_title}</p>
          )}
        </div>

        <EditButton
          label="Edit profile and photo"
          className="edit-btn--hero"
          onClick={() => setEditSection('hero')}
        />
      </div>

      {expert_reply_time.trim() !== '' && (
        <div className="exp-reply">
          <span className="exp-reply__dot" aria-hidden="true" />
          <span className="exp-reply__text">{expert_reply_time}</span>
        </div>
      )}

      <div className="exp-stats-wrap">
        <StatsRow stats={stats} />
        <EditButton
          label="Edit stats"
          className="edit-btn--stats"
          onClick={() => setEditSection('stats')}
        />
      </div>

      {(expert_bio.trim() !== '' || isEditMode) && (
        <section className="exp-section">
          <div className="exp-label-row">
            <h2 className="exp-label">About</h2>
            <EditButton
              label="Edit bio"
              className="edit-btn--inline"
              onClick={() => setEditSection('bio')}
            />
          </div>
          <p className="exp-bio">
            {expert_bio.trim() !== '' ? expert_bio : 'No bio yet.'}
          </p>
        </section>
      )}

      <SocialLinks
        settings={settings}
        editControl={
          <EditButton
            label="Edit social links"
            className="edit-btn--inline"
            onClick={() => setEditSection('socials')}
          />
        }
      />

      <section className="exp-section exp-actions">
        <EditButton
          label="Edit action buttons"
          className="edit-btn--actions"
          onClick={() => setEditSection('actions')}
        />
        <button type="button" className="exp-book" onClick={handleBook}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="5" width="18" height="16" rx="2" />
            <path d="M16 3v4M8 3v4M3 11h18" />
          </svg>
          Book Appointment
        </button>

        {whatsapp !== null && (
          <button
            type="button"
            className="exp-message"
            onClick={() => openExternal(whatsapp)}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" />
            </svg>
            Message on WhatsApp
          </button>
        )}
      </section>

      <section className="exp-section">
        <div className="exp-reviews__header">
          <h2 className="exp-reviews__title">Client Reviews</h2>
          {average !== null && (
            <span className="exp-reviews__rating">
              <span className="exp-reviews__average">{average.toFixed(1)}</span>
              <StarRating rating={average} />
            </span>
          )}
        </div>

        {reviews.length === 0 ? (
          <p className="exp-reviews__empty">No reviews yet — be the first to share one.</p>
        ) : (
          <div className="exp-reviews__list">
            {visibleReviews.map((review) => (
              <ReviewCard key={review.id} review={review} />
            ))}
          </div>
        )}

        {!showAllReviews && reviews.length > 1 && (
          <button
            type="button"
            className="exp-reviews__expand"
            onClick={() => setShowAllReviews(true)}
          >
            See all {reviews.length} reviews
          </button>
        )}

        <button
          type="button"
          className="exp-share-experience"
          onClick={() => setSubmitOpen(true)}
        >
          <span className="exp-share-experience__icon">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
          </span>
          <span className="exp-share-experience__text">
            <span className="exp-share-experience__title">Share your experience</span>
            <span className="exp-share-experience__sub">
              Help others find the right products
            </span>
          </span>
          <svg
            className="exp-share-experience__arrow"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </button>
      </section>

      <ReviewSubmitSheet isOpen={submitOpen} onClose={() => setSubmitOpen(false)} />

      {/* Admin-only; render nothing for everyone else. */}
      <EditModeToggle />
      <ExpertEditSheet section={editSection} onClose={() => setEditSection(null)} />
    </div>
  );
}
