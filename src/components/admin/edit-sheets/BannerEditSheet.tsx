import { useEffect, useState, type FormEvent } from 'react';
import { useProducts } from '../../../contexts/ProductContext';
import { useToast } from '../../../hooks/useToast';
import { useReorder } from '../../../hooks/useReorder';
import {
  BANNER_SLIDES_KEY,
  CTA_ACTION_LABELS,
  emptyBannerSlide,
  serializeBannerSlides,
} from '../../../lib/bannerSlides';
import { saveSettings } from '../../../lib/settingsLists';
import { BottomSheet } from '../../shared/BottomSheet';
import { AdminImagePicker } from '../AdminImagePicker';
import {
  PencilGlyph,
  ReorderRow,
  RowIconButton,
  SheetFooter,
  Toggle,
  TrashGlyph,
} from './SheetChrome';
import type { BannerCtaAction, BannerSlide } from '../../../types';

interface BannerEditSheetProps {
  isOpen: boolean;
  onClose: () => void;
}

const CTA_ACTIONS = Object.keys(CTA_ACTION_LABELS) as BannerCtaAction[];

/** Hex colour input that tolerates a value the native picker can't show. */
function isHex(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

/**
 * Banner slide editor. The whole slide array is one app_settings row, so
 * every action edits a local draft and the single Save writes it back — the
 * live banner only changes after that write succeeds and settings refetch.
 */
export function BannerEditSheet({ isOpen, onClose }: BannerEditSheetProps) {
  const { settings, refetch } = useProducts();
  const { showToast } = useToast();

  const [slides, setSlides] = useState<BannerSlide[]>([]);
  /** Index of the slide open in the sub-form; -1 = adding a new one. */
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [slideDraft, setSlideDraft] = useState<BannerSlide | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setSlides(settings.banner_slides);
    setEditingIndex(null);
    setSlideDraft(null);
  }, [isOpen, settings.banner_slides]);

  const reorder = useReorder(slides, setSlides);

  const startEdit = (index: number) => {
    setEditingIndex(index);
    setSlideDraft({ ...slides[index] });
  };

  const startAdd = () => {
    setEditingIndex(-1);
    setSlideDraft(emptyBannerSlide());
  };

  const applySlideDraft = () => {
    if (!slideDraft || editingIndex === null) return;
    // Title is only shown on the slide (and required) when there's no photo
    // — a photo slide's title field is hidden, so it can't be required here.
    if (slideDraft.image_url === null && slideDraft.title.trim() === '') {
      showToast('Slide title is required', 'error');
      return;
    }
    const next = editingIndex === -1 ? [...slides, slideDraft] : slides.map((s, i) => (i === editingIndex ? slideDraft : s));
    setSlides(next);
    setEditingIndex(null);
    setSlideDraft(null);
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    const error = await saveSettings({ [BANNER_SLIDES_KEY]: serializeBannerSlides(slides) });
    if (error) {
      console.error('Banner save failed:', error);
      setIsSaving(false);
      showToast('Could not save the banner', 'error');
      return;
    }
    await refetch();
    setIsSaving(false);
    showToast('Saved');
    onClose();
  };

  const patchSlide = (changes: Partial<BannerSlide>) =>
    setSlideDraft((current) => (current ? { ...current, ...changes } : current));

  return (
    <BottomSheet isOpen={isOpen} onClose={onClose} title="Banner Slides">
      {slideDraft !== null ? (
        <div className="form edit-sheet">
          <h3 className="edit-sheet__subtitle">
            {editingIndex === -1 ? 'New Slide' : 'Edit Slide'}
          </h3>

          {/* Once a photo is uploaded, the app draws no heading/eyebrow text
              over it (see the image field's own helper below) — these
              fields would do nothing, so they're hidden rather than shown
              greyed-out. They still matter for the plain-background
              fallback below, and reappear the moment the image is removed. */}
          {slideDraft.image_url === null && (
            <>
              <div className="form-field">
                <label className="form-label" htmlFor="bs-eyebrow">Eyebrow text</label>
                <input
                  id="bs-eyebrow"
                  type="text"
                  className="form-input"
                  placeholder="Direct from Australia"
                  value={slideDraft.eyebrow_text}
                  onChange={(e) => patchSlide({ eyebrow_text: e.target.value })}
                />
              </div>

              <div className="form-field">
                <label className="form-label" htmlFor="bs-title">
                  Title <span className="form-required" aria-hidden="true">*</span>
                </label>
                <input
                  id="bs-title"
                  type="text"
                  className="form-input"
                  maxLength={80}
                  value={slideDraft.title}
                  onChange={(e) => patchSlide({ title: e.target.value })}
                />
                <p className="form-helper">Clamped to two lines on the banner.</p>
              </div>
            </>
          )}

          <div className="form-field">
            <span className="form-label">Banner image (optional)</span>
            <AdminImagePicker
              path={`banners/${slideDraft.id}.webp`}
              value={slideDraft.image_url}
              onChange={(image_url) => patchSlide({ image_url })}
              shape="rect"
              label="Banner slide image"
              placeholderIcon={
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <path d="M21 15l-5-5L5 21" />
                </svg>
              }
            />
            <p className="form-helper">
              Recommended: 1200×460px or larger, same ~2.6:1 aspect ratio (a
              wide banner shape) — any heading or text should already be part
              of the photo, since the app no longer draws text over it. With
              no image, the banner falls back to the plain background and the
              Eyebrow/Title fields above.
            </p>
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="bs-cta-text">CTA button text</label>
            <input
              id="bs-cta-text"
              type="text"
              className="form-input"
              value={slideDraft.cta_button_text}
              onChange={(e) => patchSlide({ cta_button_text: e.target.value })}
            />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="bs-cta-action">CTA action</label>
            <select
              id="bs-cta-action"
              className="form-input form-select"
              value={slideDraft.cta_action}
              onChange={(e) => patchSlide({ cta_action: e.target.value as BannerCtaAction })}
            >
              {CTA_ACTIONS.map((action) => (
                <option key={action} value={action}>
                  {CTA_ACTION_LABELS[action]}
                </option>
              ))}
            </select>
          </div>

          {slideDraft.cta_action === 'open_url' && (
            <div className="form-field">
              <label className="form-label" htmlFor="bs-cta-url">CTA URL</label>
              <input
                id="bs-cta-url"
                type="url"
                className="form-input"
                placeholder="https://…"
                value={slideDraft.cta_url}
                onChange={(e) => patchSlide({ cta_url: e.target.value })}
              />
            </div>
          )}

          <div className="form-field">
            <label className="form-label" htmlFor="bs-color">Background colour</label>
            <div className="inline-mini-form">
              <input
                type="color"
                className="edit-sheet__color"
                value={isHex(slideDraft.background_color) ? slideDraft.background_color : '#FFF3EE'}
                onChange={(e) => patchSlide({ background_color: e.target.value })}
                aria-label="Pick background colour"
              />
              <input
                id="bs-color"
                type="text"
                className="form-input"
                value={slideDraft.background_color}
                onChange={(e) => patchSlide({ background_color: e.target.value })}
                placeholder="#FFF3EE"
              />
            </div>
          </div>

          <div className="form-field form-field--toggle">
            <span className="toggle-label">Active</span>
            <Toggle
              checked={slideDraft.is_active}
              onChange={(is_active) => patchSlide({ is_active })}
              label="Slide active"
            />
          </div>

          <div className="edit-sheet__footer">
            <button
              type="button"
              className="edit-sheet__cancel"
              onClick={() => {
                setEditingIndex(null);
                setSlideDraft(null);
              }}
            >
              Back to list
            </button>
            <button type="button" className="edit-sheet__save" onClick={applySlideDraft}>
              {editingIndex === -1 ? 'Add Slide' : 'Apply'}
            </button>
          </div>
        </div>
      ) : (
        <form className="form edit-sheet" onSubmit={handleSave} noValidate>
          {slides.length === 0 ? (
            <p className="edit-sheet__empty">No slides yet — add one below.</p>
          ) : (
            <ul className="edit-list">
              {slides.map((slide, index) => (
                <ReorderRow
                  key={slide.id}
                  index={index}
                  count={slides.length}
                  dragIndex={reorder.dragIndex}
                  onDragStart={reorder.setDragIndex}
                  onDragEnd={() => reorder.setDragIndex(null)}
                  onDrop={reorder.dropOn}
                  onMove={reorder.move}
                  label={slide.title || `slide ${index + 1}`}
                  className={slide.is_active ? undefined : 'edit-row--muted'}
                >
                  <span className="edit-row__text">{slide.title || 'Untitled slide'}</span>
                  <Toggle
                    small
                    checked={slide.is_active}
                    onChange={(is_active) =>
                      setSlides(slides.map((s, i) => (i === index ? { ...s, is_active } : s)))
                    }
                    label={`${slide.title || 'Slide'} active`}
                  />
                  <RowIconButton label={`Edit ${slide.title}`} onClick={() => startEdit(index)}>
                    <PencilGlyph />
                  </RowIconButton>
                  <RowIconButton
                    label={`Delete ${slide.title}`}
                    variant="danger"
                    onClick={() => setSlides(slides.filter((_, i) => i !== index))}
                  >
                    <TrashGlyph />
                  </RowIconButton>
                </ReorderRow>
              ))}
            </ul>
          )}

          <button type="button" className="button button--secondary button--full" onClick={startAdd}>
            + Add Slide
          </button>

          <SheetFooter onCancel={onClose} isSaving={isSaving} />
        </form>
      )}
    </BottomSheet>
  );
}
