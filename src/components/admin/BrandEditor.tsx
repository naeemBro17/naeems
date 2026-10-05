import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { BRAND_SLUG_PATTERN, brandSlugify } from '../../lib/brands';
import { checkMediaFile, saveBrand, uploadBrandMedia, type MediaKind } from '../../lib/brandAdmin';
import { extractYouTubeId } from '../../lib/youtube';
import { formatDhakaTime } from '../../lib/staff';
import { AdminIcon } from './ui/AdminIcon';
import { BrandLogoImage, brandCardStyle, useBrandLogo } from '../viewer/BrandLogo';
import type { Brand } from '../../types';

interface BrandEditorProps {
  /** null = a new brand. */
  brand: Brand | null;
  nextOrder: number;
  productCount: number;
  onSaved: (brand: Brand) => void | Promise<void>;
  onCancel: () => void;
  onDelete: () => void;
}

type VideoSource = 'upload' | 'youtube';

interface FormState {
  name: string;
  slug: string;
  logo_url: string | null;
  logo_dark_url: string | null;
  banner_image_url: string | null;
  banner_video_url: string | null;
  banner_youtube_url: string;
  show_on_home: boolean;
}

function initialState(brand: Brand | null): FormState {
  return {
    name: brand?.name ?? '',
    slug: brand?.slug ?? '',
    logo_url: brand?.logo_url ?? null,
    logo_dark_url: brand?.logo_dark_url ?? null,
    banner_image_url: brand?.banner_image_url ?? null,
    banner_video_url: brand?.banner_video_url ?? null,
    banner_youtube_url: brand?.banner_youtube_url ?? '',
    show_on_home: brand?.show_on_home ?? false,
  };
}

/** One preview card — the shop's own brand card, logo rule and clean-up
 *  (BrandLogo.tsx), so it shows exactly what customers will see. */
function PreviewCard({
  label,
  logo,
  logoDark,
  theme,
  testId,
}: {
  label: string;
  logo: string | null;
  logoDark: string | null;
  theme: 'light' | 'dark';
  testId: string;
}) {
  const view = useBrandLogo({ logo_url: logo, logo_dark_url: logoDark }, theme);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showLogo = view.src !== null && view.src !== failedSrc;
  return (
    <span
      className={`brand-card brand-card--${view.tone} adm-brand-preview__card adm-brand-preview__card--on-${theme}`}
      style={brandCardStyle(view)}
      data-testid={testId}
    >
      {showLogo ? (
        <BrandLogoImage view={view} className="brand-card__logo" width={160} height={80} onError={() => setFailedSrc(view.src)} />
      ) : (
        <span className="brand-card__name">{label}</span>
      )}
    </span>
  );
}

/** How a logo will look in the shop: a light card and a dark card. */
function LogoPreview({ name, logo, logoDark }: { name: string; logo: string | null; logoDark: string | null }) {
  const label = name.trim() || 'Brand';
  return (
    <div className="adm-brand-preview" aria-label="Preview">
      <div className="adm-brand-preview__col">
        <span className="adm-brand-preview__caption">Light mode</span>
        <PreviewCard label={label} logo={logo} logoDark={logoDark} theme="light" testId="logo-preview-light" />
      </div>
      <div className="adm-brand-preview__col">
        <span className="adm-brand-preview__caption">Dark mode</span>
        <PreviewCard label={label} logo={logo} logoDark={logoDark} theme="dark" testId="logo-preview-dark" />
      </div>
    </div>
  );
}

function MediaField({
  kind,
  label,
  help,
  value,
  onChange,
  testId,
}: {
  kind: MediaKind;
  label: string;
  help: string;
  value: string | null;
  onChange: (url: string | null) => void;
  testId: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const problem = checkMediaFile(kind, file);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      onChange(await uploadBrandMedia(kind, file));
    } catch (err) {
      console.error('Brand upload failed:', err);
      setError('Could not upload. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const isVideo = kind === 'video';
  const accept = isVideo ? 'video/mp4,video/webm' : 'image/png,image/jpeg,image/webp';

  return (
    <div className="form-field adm-media-field">
      <span className="form-label">{label}</span>
      <p className="form-helper adm-media-field__help">{help}</p>
      <div className={`adm-media-field__box adm-media-field__box--${kind}`}>
        {value ? (
          isVideo ? (
            <video className="adm-media-field__preview" src={value} muted loop autoPlay playsInline aria-label={label} />
          ) : (
            <img className="adm-media-field__preview" src={value} alt={label} data-testid={`${testId}-img`} />
          )
        ) : (
          <span className="adm-media-field__empty">
            <AdminIcon name={isVideo ? 'video' : 'plus'} />
            {isVideo ? 'No video' : 'No picture yet'}
          </span>
        )}
        {busy && (
          <span className="adm-media-field__busy" role="status" aria-label="Uploading">
            <span className="spinner" aria-hidden="true" />
          </span>
        )}
      </div>
      <div className="adm-media-field__actions">
        <button type="button" className="adm-btn adm-btn--ghost adm-btn--sm" disabled={busy} onClick={() => inputRef.current?.click()}>
          {value ? 'Replace' : 'Upload'}
        </button>
        {value && (
          <button type="button" className="adm-btn adm-btn--ghost adm-btn--sm adm-btn--danger-text" disabled={busy} onClick={() => onChange(null)}>
            Remove
          </button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="visually-hidden"
        onChange={(e) => void choose(e)}
        aria-label={label}
        data-testid={`${testId}-input`}
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Add / edit one brand (Batch 26 Part 2), with plain-English help under
 * every field. Pictures upload as soon as they're chosen (logos are trimmed
 * and resized in the browser first); nothing is saved to the brand until
 * Save.
 */
export function BrandEditor({ brand, nextOrder, productCount, onSaved, onCancel, onDelete }: BrandEditorProps) {
  const [form, setForm] = useState<FormState>(() => initialState(brand));
  // A new brand's link follows its name until someone edits the link.
  const [slugTouched, setSlugTouched] = useState(brand !== null);
  const [videoSource, setVideoSource] = useState<VideoSource>(
    brand?.banner_youtube_url && !brand.banner_video_url ? 'youtube' : 'upload'
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const slug = slugTouched ? form.slug : brandSlugify(form.name);
  const slugOk = BRAND_SLUG_PATTERN.test(slug);
  const youtubeOk = form.banner_youtube_url.trim() === '' || extractYouTubeId(form.banner_youtube_url) !== null;
  const nameOk = form.name.trim().length > 0 && form.name.trim().length <= 60;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!nameOk) {
      setError('Type the brand name.');
      return;
    }
    if (!slugOk) {
      setError('The link may only have small letters, numbers and single dashes, e.g. la-roche-posay.');
      return;
    }
    if (videoSource === 'youtube' && !youtubeOk) {
      setError('That is not a YouTube link.');
      return;
    }
    setError(null);
    setSaving(true);
    const result = await saveBrand(
      brand?.id ?? null,
      {
        name: form.name.trim(),
        slug,
        logo_url: form.logo_url,
        logo_dark_url: form.logo_dark_url,
        banner_image_url: form.banner_image_url,
        banner_video_url: videoSource === 'upload' ? form.banner_video_url : null,
        banner_youtube_url: videoSource === 'youtube' && form.banner_youtube_url.trim() !== '' ? form.banner_youtube_url.trim() : null,
        show_on_home: form.show_on_home,
      },
      nextOrder
    );
    setSaving(false);
    if (result.error || !result.brand) {
      setError(result.error ?? 'Could not save the brand.');
      return;
    }
    await onSaved(result.brand);
  };

  return (
    <form className="form adm-brand-form" onSubmit={(e) => void submit(e)} noValidate>
      {brand?.updated_by && brand.updated_by !== 'system' && (
        <p className="adm-editor-edited">
          Last updated by {brand.updated_by} · {formatDhakaTime(brand.updated_at)}
        </p>
      )}

      <div className="form-field">
        <label className="form-label" htmlFor="bf-name">
          Name <span className="form-required" aria-hidden="true">*</span>
        </label>
        <input
          id="bf-name"
          className="form-input"
          value={form.name}
          maxLength={60}
          onChange={(e) => set('name', e.target.value)}
          placeholder="e.g. La Roche-Posay"
          required
        />
        <p className="form-helper">
          {brand && productCount > 0
            ? `A new name shows on all ${productCount} of its products straight away.`
            : 'As customers should see it, with the brand’s own capitals.'}
        </p>
      </div>

      <div className="form-field">
        <label className="form-label" htmlFor="bf-slug">
          Link
        </label>
        <input
          id="bf-slug"
          className={`form-input${slugOk ? '' : ' form-input--error'}`}
          value={slug}
          maxLength={80}
          onChange={(e) => {
            setSlugTouched(true);
            set('slug', e.target.value.toLowerCase().replace(/\s+/g, '-'));
          }}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        <p className="form-helper adm-brand-form__link" data-testid="brand-link-preview">
          {window.location.host}/brand/{slug || '…'}
        </p>
        <p className="form-helper">
          Made from the name. Changing it later breaks links people already shared.
        </p>
      </div>

      <MediaField
        kind="logo"
        label="Logo"
        help="One-colour logo: upload a normal and a white version. Logo with a coloured background: upload one; it fills the card in both modes."
        value={form.logo_url}
        onChange={(url) => set('logo_url', url)}
        testId="brand-logo"
      />
      <MediaField
        kind="logo-dark"
        label="Logo for dark mode (optional)"
        help="A white version of the logo. If empty, the normal logo is shown on a light card in dark mode too."
        value={form.logo_dark_url}
        onChange={(url) => set('logo_dark_url', url)}
        testId="brand-logo-dark"
      />
      <LogoPreview name={form.name} logo={form.logo_url} logoDark={form.logo_dark_url} />

      <MediaField
        kind="banner"
        label="Banner image"
        help="Wide picture for the top of the brand page."
        value={form.banner_image_url}
        onChange={(url) => set('banner_image_url', url)}
        testId="brand-banner"
      />

      <div className="form-field">
        <span className="form-label">Banner video (optional)</span>
        <p className="form-helper">A short clip (5–20 seconds). It plays silently in a loop. Max 15 MB.</p>
        <div className="adm-segment" role="radiogroup" aria-label="Video source">
          <button
            type="button"
            role="radio"
            aria-checked={videoSource === 'upload'}
            className={`adm-segment__item${videoSource === 'upload' ? ' adm-segment__item--on' : ''}`}
            onClick={() => setVideoSource('upload')}
          >
            Upload video (recommended)
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={videoSource === 'youtube'}
            className={`adm-segment__item${videoSource === 'youtube' ? ' adm-segment__item--on' : ''}`}
            onClick={() => setVideoSource('youtube')}
          >
            YouTube link
          </button>
        </div>
      </div>
      {videoSource === 'upload' ? (
        <MediaField
          kind="video"
          label="Video file"
          help="MP4 works on every phone. The banner image is shown while it loads."
          value={form.banner_video_url}
          onChange={(url) => set('banner_video_url', url)}
          testId="brand-video"
        />
      ) : (
        <div className="form-field">
          <label className="form-label" htmlFor="bf-youtube">
            YouTube link
          </label>
          <input
            id="bf-youtube"
            className={`form-input${youtubeOk ? '' : ' form-input--error'}`}
            value={form.banner_youtube_url}
            onChange={(e) => set('banner_youtube_url', e.target.value)}
            placeholder="https://youtu.be/…"
            inputMode="url"
          />
          <p className="form-helper">
            YouTube shows its own title for a moment when the clip starts. An uploaded MP4 looks cleaner.
          </p>
        </div>
      )}

      <div className="form-field adm-brand-form__home">
        <div>
          <span className="form-label">Show on home</span>
          <p className="form-helper">In the "Shop by Brand" row on the shop's Home (only while it has live products).</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={form.show_on_home}
          aria-label="Show on home"
          className={`adm-switch${form.show_on_home ? ' adm-switch--on' : ''}`}
          onClick={() => set('show_on_home', !form.show_on_home)}
        >
          <span className="adm-switch__thumb" aria-hidden="true" />
        </button>
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <div className="adm-brand-form__footer">
        <button type="button" className="adm-btn adm-btn--ghost adm-btn--lg" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="adm-btn adm-btn--primary adm-btn--lg" disabled={saving}>
          {saving ? <span className="spinner" aria-hidden="true" /> : brand ? 'Save' : 'Add brand'}
        </button>
      </div>
      {brand && (
        <button type="button" className="adm-btn adm-btn--ghost adm-btn--danger-text adm-brand-form__delete" onClick={onDelete}>
          <AdminIcon name="trash" /> Delete brand
        </button>
      )}
    </form>
  );
}
