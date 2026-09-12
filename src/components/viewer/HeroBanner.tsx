import { useCallback, useEffect, useRef, useState, type UIEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAdminEdit } from '../../contexts/AdminEditContext';
import { EditButton } from '../admin/EditButton';
import { BannerEditSheet } from '../admin/edit-sheets/BannerEditSheet';
import type { BannerSlide } from '../../types';

interface HeroBannerProps {
  slides: BannerSlide[];
  /** Scrolls the page to the All Products grid (the 'scroll_to_products' CTA). */
  onScrollToProducts: () => void;
}

/** How often the banner advances on its own. */
const AUTO_ADVANCE_MS = 5000;
/** Auto-advance pauses for this long after any manual interaction. */
const INTERACTION_PAUSE_MS = 10000;

export function HeroBanner({ slides, onScrollToProducts }: HeroBannerProps) {
  const navigate = useNavigate();
  const { isEditMode } = useAdminEdit();
  const [editorOpen, setEditorOpen] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  // Mirrors activeIndex for the interval, which must not read stale state and
  // must not compute the next slide inside a state updater (StrictMode runs
  // updaters twice).
  const activeIndexRef = useRef(0);
  // Timestamp of the last manual swipe/tap; auto-advance stays off until
  // INTERACTION_PAUSE_MS has elapsed since it.
  const lastInteractionRef = useRef(0);

  const activeSlides = slides.filter((s) => s.is_active);
  const slideCount = activeSlides.length;

  const goToSlide = useCallback((index: number) => {
    const track = trackRef.current;
    if (!track) return;
    track.scrollTo({ left: index * track.clientWidth, behavior: 'smooth' });
  }, []);

  // Auto-advance, suspended while the reader has recently interacted.
  useEffect(() => {
    if (slideCount < 2) return;
    const timer = window.setInterval(() => {
      if (Date.now() - lastInteractionRef.current < INTERACTION_PAUSE_MS) return;
      const next = (activeIndexRef.current + 1) % slideCount;
      activeIndexRef.current = next;
      setActiveIndex(next);
      goToSlide(next);
    }, AUTO_ADVANCE_MS);
    return () => window.clearInterval(timer);
  }, [slideCount, goToSlide]);

  const handleScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const index = Math.max(0, Math.min(slideCount - 1, Math.round(el.scrollLeft / el.clientWidth)));
    activeIndexRef.current = index;
    setActiveIndex(index);
  };

  const markInteraction = () => {
    lastInteractionRef.current = Date.now();
  };

  const handleCta = (slide: BannerSlide) => {
    markInteraction();
    if (slide.cta_action === 'open_contact') {
      navigate('/contact');
      return;
    }
    if (slide.cta_action === 'open_url') {
      if (slide.cta_url.trim() !== '') {
        window.open(slide.cta_url, '_blank', 'noopener,noreferrer');
      }
      return;
    }
    onScrollToProducts();
  };

  const editor = (
    <>
      <EditButton
        label="Edit banner slides"
        className="edit-btn--banner"
        onClick={() => setEditorOpen(true)}
      />
      <BannerEditSheet isOpen={editorOpen} onClose={() => setEditorOpen(false)} />
    </>
  );

  if (slideCount === 0) {
    // Nothing for customers; in Edit Mode the admin still needs a way in.
    if (!isEditMode) return null;
    return (
      <section className="hero-banner hero-banner--empty" aria-label="Promotions">
        <p className="hero-banner__empty-text">No active banner slides</p>
        {editor}
      </section>
    );
  }

  return (
    <section className="hero-banner" aria-label="Promotions">
      <div
        ref={trackRef}
        className="hero-banner__track"
        onScroll={handleScroll}
        onPointerDown={markInteraction}
        onTouchStart={markInteraction}
      >
        {activeSlides.map((slide, index) => (
          <article
            key={`${slide.title}-${index}`}
            className="hero-banner__slide"
            aria-label={`Slide ${index + 1} of ${slideCount}`}
          >
            <span className="hero-banner__circle hero-banner__circle--one" aria-hidden="true" />
            <span className="hero-banner__circle hero-banner__circle--two" aria-hidden="true" />
            <div className="hero-banner__content">
              {slide.eyebrow_text !== '' && (
                <p className="hero-banner__eyebrow">{slide.eyebrow_text}</p>
              )}
              <h2 className="hero-banner__title">{slide.title}</h2>
              {slide.cta_button_text !== '' && (
                <button
                  type="button"
                  className="hero-banner__cta"
                  onClick={() => handleCta(slide)}
                >
                  {slide.cta_button_text}
                </button>
              )}
            </div>
          </article>
        ))}
      </div>

      {slideCount > 1 && (
        <div className="hero-banner__dots">
          {activeSlides.map((slide, index) => (
            <button
              key={`dot-${slide.title}-${index}`}
              type="button"
              className={`hero-banner__dot${
                index === activeIndex ? ' hero-banner__dot--active' : ''
              }`}
              onClick={() => {
                markInteraction();
                activeIndexRef.current = index;
                setActiveIndex(index);
                goToSlide(index);
              }}
              aria-label={`Go to slide ${index + 1}`}
              aria-current={index === activeIndex}
            />
          ))}
        </div>
      )}

      {editor}
    </section>
  );
}
