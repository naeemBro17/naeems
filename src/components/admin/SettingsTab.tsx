import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase, STORAGE_BUCKET } from '../../lib/supabase';
import { clearCache } from '../../lib/cache';
import {
  BANNER_SLIDES_KEY,
  CTA_ACTION_LABELS,
  emptyBannerSlide,
  serializeBannerSlides,
} from '../../lib/bannerSlides';
import { resizeImage, isAcceptedImageType, MAX_IMAGE_BYTES } from '../../lib/imageResize';
import { useAuth } from '../../contexts/AuthContext';
import { useProducts, type TextSettingKey } from '../../contexts/ProductContext';
import { useToast } from '../../hooks/useToast';
import type { AppSettings, BannerSlide, BannerCtaAction } from '../../types';

const PASSWORD_MIN_LENGTH = 8;
const EXPERT_PHOTO_PATH = 'settings/expert-photo.webp';

/** The plain-text expert-profile keys the Settings form edits. */
const PROFILE_FIELDS = [
  { key: 'expert_location', label: 'Location', placeholder: 'Dhaka, Bangladesh' },
  { key: 'expert_title', label: 'Title', placeholder: 'Skincare Expert & Consultant' },
  {
    key: 'expert_reply_time',
    label: 'Reply Time',
    placeholder: 'Typically replies within a few hours',
  },
  { key: 'expert_facebook_url', label: 'Facebook URL', placeholder: 'https://facebook.com/...' },
  {
    key: 'expert_whatsapp_url',
    label: 'WhatsApp (link or phone number)',
    placeholder: '8801XXXXXXXXX',
  },
  { key: 'expert_instagram_url', label: 'Instagram URL', placeholder: 'https://instagram.com/...' },
  { key: 'expert_instagram_handle', label: 'Instagram Handle', placeholder: '@naeem.skin' },
  { key: 'expert_threads_url', label: 'Threads URL', placeholder: 'https://threads.net/...' },
  { key: 'expert_threads_handle', label: 'Threads Handle', placeholder: '@naeem.skin' },
  { key: 'expert_youtube_url', label: 'YouTube URL', placeholder: 'https://youtube.com/@...' },
  {
    key: 'expert_appointment_url',
    label: 'Appointment Booking URL',
    placeholder: 'https://calendly.com/...',
  },
  { key: 'expert_stat_1_value', label: 'Stat 1 Value', placeholder: '500+' },
  { key: 'expert_stat_1_label', label: 'Stat 1 Label', placeholder: 'Happy Clients' },
  { key: 'expert_stat_2_value', label: 'Stat 2 Value', placeholder: '5+' },
  { key: 'expert_stat_2_label', label: 'Stat 2 Label', placeholder: 'Rating' },
  { key: 'expert_stat_3_value', label: 'Stat 3 Value', placeholder: '3yr' },
  { key: 'expert_stat_3_label', label: 'Stat 3 Label', placeholder: 'Expertise' },
] as const satisfies readonly { key: TextSettingKey; label: string; placeholder: string }[];

type ProfileFieldKey = (typeof PROFILE_FIELDS)[number]['key'];

function blankProfileFields(): Record<ProfileFieldKey, string> {
  const blank = {} as Record<ProfileFieldKey, string>;
  for (const { key } of PROFILE_FIELDS) blank[key] = '';
  return blank;
}

function readProfileFields(settings: AppSettings): Record<ProfileFieldKey, string> {
  const values = {} as Record<ProfileFieldKey, string>;
  for (const { key } of PROFILE_FIELDS) values[key] = settings[key];
  return values;
}

/** Expert contact settings — powers the /contact page and the floating button. */
function ExpertSettingsPanel() {
  const { settings, refetch } = useProducts();
  const { showToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [messengerLink, setMessengerLink] = useState('');
  const [expertName, setExpertName] = useState('');
  const [expertBio, setExpertBio] = useState('');
  // Every additional expert-profile key, kept in one record so the form and
  // the save payload stay in step as fields are added.
  const [profileFields, setProfileFields] = useState<Record<ProfileFieldKey, string>>(
    () => blankProfileFields()
  );
  const [storedPhotoUrl, setStoredPhotoUrl] = useState('');
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingPreview, setPendingPreview] = useState<string | null>(null);
  const [photoRemoved, setPhotoRemoved] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Sync local fields from context whenever the fetched settings change.
  useEffect(() => {
    setMessengerLink(settings.messenger_link);
    setExpertName(settings.expert_name);
    setExpertBio(settings.expert_bio);
    setProfileFields(readProfileFields(settings));
    setStoredPhotoUrl(settings.expert_photo_url);
    setPendingFile(null);
    setPendingPreview(null);
    setPhotoRemoved(false);
    setFileError(null);
  }, [settings]);

  // Object URL for the pending photo preview; revoked on change/unmount.
  useEffect(() => {
    if (!pendingFile) {
      setPendingPreview(null);
      return;
    }
    const url = URL.createObjectURL(pendingFile);
    setPendingPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingFile]);

  const displayPhoto = pendingPreview ?? (photoRemoved ? null : storedPhotoUrl || null);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!isAcceptedImageType(file)) {
      setFileError('Choose a JPG, PNG, or WebP image.');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setFileError('Image exceeds 10MB.');
      return;
    }
    setFileError(null);
    setPhotoRemoved(false);
    setPendingFile(file);
  };

  const handleRemovePhoto = () => {
    setPendingFile(null);
    setPhotoRemoved(true);
    setFileError(null);
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      let finalPhotoUrl = storedPhotoUrl;
      if (pendingFile) {
        const blob = await resizeImage(pendingFile);
        const { error } = await supabase.storage
          .from(STORAGE_BUCKET)
          .upload(EXPERT_PHOTO_PATH, blob, {
            contentType: 'image/webp',
            upsert: true,
          });
        if (error) throw error;
        const { data } = supabase.storage
          .from(STORAGE_BUCKET)
          .getPublicUrl(EXPERT_PHOTO_PATH);
        // Cache-bust so the new photo shows despite the stable storage path.
        finalPhotoUrl = `${data.publicUrl}?v=${Date.now()}`;
      } else if (photoRemoved) {
        finalPhotoUrl = '';
      }

      const { error } = await supabase.from('app_settings').upsert(
        [
          { key: 'messenger_link', value: messengerLink.trim() },
          { key: 'expert_name', value: expertName.trim() },
          { key: 'expert_bio', value: expertBio },
          { key: 'expert_photo_url', value: finalPhotoUrl },
          ...PROFILE_FIELDS.map(({ key }) => ({
            key,
            value: profileFields[key].trim(),
          })),
        ],
        { onConflict: 'key' }
      );
      if (error) throw error;

      await refetch();
      showToast('Contact settings saved');
    } catch (error) {
      console.error('Settings save failed:', error);
      showToast('Could not save contact settings. Please try again.', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="admin-panel">
      <h3 className="admin-panel__title">Talk to an Expert</h3>
      <p className="admin-panel__description">
        Shown on the contact page and the floating chat button on the homepage.
      </p>
      <form onSubmit={handleSave} className="form" noValidate>
        <div className="form-field">
          <label className="form-label" htmlFor="settings-messenger">
            Messenger Link
          </label>
          <input
            id="settings-messenger"
            type="url"
            className="form-input"
            placeholder="https://m.me/your-page-username"
            value={messengerLink}
            onChange={(e) => setMessengerLink(e.target.value)}
          />
        </div>

        <div className="form-field">
          <label className="form-label" htmlFor="settings-expert-name">
            Expert Name
          </label>
          <input
            id="settings-expert-name"
            type="text"
            className="form-input"
            value={expertName}
            onChange={(e) => setExpertName(e.target.value)}
          />
        </div>

        <div className="form-field">
          <label className="form-label" htmlFor="settings-expert-bio">
            Expert Bio
          </label>
          <textarea
            id="settings-expert-bio"
            className="form-input form-textarea"
            rows={4}
            placeholder="A short intro — who you are and what you can help with."
            value={expertBio}
            onChange={(e) => setExpertBio(e.target.value)}
          />
        </div>

        <div className="form-field">
          <span className="form-label">Expert Photo</span>
          <div className="expert-photo-uploader">
            <div className="expert-photo-uploader__preview">
              {displayPhoto ? (
                <img src={displayPhoto} alt="Expert" />
              ) : (
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
              )}
            </div>
            <div className="expert-photo-uploader__actions">
              <button
                type="button"
                className="button button--secondary button--small"
                onClick={() => fileInputRef.current?.click()}
              >
                {displayPhoto ? 'Change photo' : 'Upload photo'}
              </button>
              {displayPhoto && (
                <button
                  type="button"
                  className="button button--danger-outline button--small"
                  onClick={handleRemovePhoto}
                >
                  Remove photo
                </button>
              )}
            </div>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={handleFileChange}
            className="visually-hidden"
            aria-label="Choose expert photo"
          />
          {fileError && (
            <p className="form-error" role="alert">
              {fileError}
            </p>
          )}
        </div>

        {PROFILE_FIELDS.map(({ key, label, placeholder }) => (
          <div className="form-field" key={key}>
            <label className="form-label" htmlFor={`settings-${key}`}>
              {label}
            </label>
            <input
              id={`settings-${key}`}
              type="text"
              className="form-input"
              placeholder={placeholder}
              value={profileFields[key]}
              onChange={(e) =>
                setProfileFields((current) => ({ ...current, [key]: e.target.value }))
              }
            />
          </div>
        ))}

        <button type="submit" className="button button--primary" disabled={isSaving}>
          {isSaving ? <span className="spinner" aria-hidden="true" /> : 'Save'}
        </button>
      </form>
    </div>
  );
}

/** The WhatsApp number OrderSuccessPage sends the manual order handoff to. */
function ShopWhatsAppPanel() {
  const { settings, refetch } = useProducts();
  const { showToast } = useToast();

  const [whatsAppNumber, setWhatsAppNumber] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setWhatsAppNumber(settings.shop_whatsapp_number);
  }, [settings]);

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    const { error } = await supabase
      .from('app_settings')
      .upsert([{ key: 'shop_whatsapp_number', value: whatsAppNumber.trim() }], {
        onConflict: 'key',
      });
    setIsSaving(false);
    if (error) {
      console.error('WhatsApp number save failed:', error);
      showToast('Could not save the WhatsApp number. Please try again.', 'error');
      return;
    }
    await refetch();
    showToast('WhatsApp number saved');
  };

  return (
    <div className="admin-panel">
      <h3 className="admin-panel__title">Checkout WhatsApp Number</h3>
      <p className="admin-panel__description">
        Customers send their order summary here from the checkout confirmation screen.
      </p>
      <form onSubmit={handleSave} className="form" noValidate>
        <div className="form-field">
          <label className="form-label" htmlFor="settings-shop-whatsapp">
            WhatsApp number (or link)
          </label>
          <input
            id="settings-shop-whatsapp"
            type="text"
            className="form-input"
            placeholder="8801XXXXXXXXX"
            value={whatsAppNumber}
            onChange={(e) => setWhatsAppNumber(e.target.value)}
          />
        </div>
        <button type="submit" className="button button--primary" disabled={isSaving}>
          {isSaving ? <span className="spinner" aria-hidden="true" /> : 'Save'}
        </button>
      </form>
    </div>
  );
}

/** bKash advance-payment number + the two delivery zone fees (Batch 18) —
 *  the same app_settings rows place_order() reads server-side
 *  (migration-021), so a change here takes effect for both what the
 *  customer sees at checkout and what the order is actually priced at. */
function OrderPaymentSettingsPanel() {
  const { settings, refetch } = useProducts();
  const { showToast } = useToast();

  const [bkashNumber, setBkashNumber] = useState('');
  const [feeInsideDhaka, setFeeInsideDhaka] = useState('');
  const [feeOutsideDhaka, setFeeOutsideDhaka] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setBkashNumber(settings.shop_bkash_number);
    setFeeInsideDhaka(settings.delivery_fee_inside_dhaka);
    setFeeOutsideDhaka(settings.delivery_fee_outside_dhaka);
  }, [settings]);

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    const inside = Number(feeInsideDhaka);
    const outside = Number(feeOutsideDhaka);
    if (!Number.isFinite(inside) || inside < 0 || !Number.isFinite(outside) || outside < 0) {
      showToast('Delivery fees must be a positive number', 'error');
      return;
    }
    setIsSaving(true);
    const { error } = await supabase.from('app_settings').upsert(
      [
        { key: 'shop_bkash_number', value: bkashNumber.trim() },
        { key: 'delivery_fee_inside_dhaka', value: String(inside) },
        { key: 'delivery_fee_outside_dhaka', value: String(outside) },
      ],
      { onConflict: 'key' }
    );
    setIsSaving(false);
    if (error) {
      console.error('Order payment settings save failed:', error);
      showToast('Could not save. Please try again.', 'error');
      return;
    }
    await refetch();
    showToast('Saved');
  };

  return (
    <div className="admin-panel">
      <h3 className="admin-panel__title">Orders: Payment &amp; Delivery</h3>
      <p className="admin-panel__description">
        The bKash number customers send advance payment to (leave blank to hide the bKash
        option at checkout), and the delivery fee for each zone.
      </p>
      <form onSubmit={handleSave} className="form" noValidate>
        <div className="form-field">
          <label className="form-label" htmlFor="settings-bkash-number">
            bKash number
          </label>
          <input
            id="settings-bkash-number"
            type="text"
            className="form-input"
            placeholder="01XXXXXXXXX"
            value={bkashNumber}
            onChange={(e) => setBkashNumber(e.target.value)}
          />
        </div>
        <div className="form-row">
          <div className="form-field">
            <label className="form-label" htmlFor="settings-fee-inside">
              Inside Dhaka fee (৳)
            </label>
            <input
              id="settings-fee-inside"
              type="number"
              min="0"
              className="form-input"
              value={feeInsideDhaka}
              onChange={(e) => setFeeInsideDhaka(e.target.value)}
            />
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="settings-fee-outside">
              Outside Dhaka fee (৳)
            </label>
            <input
              id="settings-fee-outside"
              type="number"
              min="0"
              className="form-input"
              value={feeOutsideDhaka}
              onChange={(e) => setFeeOutsideDhaka(e.target.value)}
            />
          </div>
        </div>
        <button type="submit" className="button button--primary" disabled={isSaving}>
          {isSaving ? <span className="spinner" aria-hidden="true" /> : 'Save'}
        </button>
      </form>
    </div>
  );
}

/** Facebook Pixel + GA4 Measurement IDs (Batch 19 Part 2) — blank means that
 *  tracker never loads on the site at all, no errors either way. */
function AdTrackingSettingsPanel() {
  const { settings, refetch } = useProducts();
  const { showToast } = useToast();

  const [fbPixelId, setFbPixelId] = useState('');
  const [gaMeasurementId, setGaMeasurementId] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setFbPixelId(settings.fb_pixel_id);
    setGaMeasurementId(settings.ga_measurement_id);
  }, [settings]);

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    const { error } = await supabase.from('app_settings').upsert(
      [
        { key: 'fb_pixel_id', value: fbPixelId.trim() },
        { key: 'ga_measurement_id', value: gaMeasurementId.trim() },
      ],
      { onConflict: 'key' }
    );
    setIsSaving(false);
    if (error) {
      console.error('Ad tracking settings save failed:', error);
      showToast('Could not save. Please try again.', 'error');
      return;
    }
    await refetch();
    showToast('Saved');
  };

  return (
    <div className="admin-panel">
      <h3 className="admin-panel__title">Facebook Pixel &amp; Google Analytics</h3>
      <p className="admin-panel__description">
        Paste the IDs from your Facebook Events Manager and Google Analytics here. Leave a field
        blank to keep that tracker turned off — nothing loads on the site until you fill it in.
      </p>
      <form onSubmit={handleSave} className="form" noValidate>
        <div className="form-field">
          <label className="form-label" htmlFor="settings-fb-pixel">
            Facebook Pixel ID
          </label>
          <input
            id="settings-fb-pixel"
            type="text"
            className="form-input"
            placeholder="123456789012345"
            value={fbPixelId}
            onChange={(e) => setFbPixelId(e.target.value)}
          />
        </div>
        <div className="form-field">
          <label className="form-label" htmlFor="settings-ga-id">
            Google Analytics Measurement ID
          </label>
          <input
            id="settings-ga-id"
            type="text"
            className="form-input"
            placeholder="G-XXXXXXXXXX"
            value={gaMeasurementId}
            onChange={(e) => setGaMeasurementId(e.target.value)}
          />
        </div>
        <button type="submit" className="button button--primary" disabled={isSaving}>
          {isSaving ? <span className="spinner" aria-hidden="true" /> : 'Save'}
        </button>
      </form>
    </div>
  );
}

/** Hero banner slides — the swipeable card at the top of the homepage. */
function BannerSlidesPanel() {
  const { settings, refetch } = useProducts();
  const { showToast } = useToast();

  const [slides, setSlides] = useState<BannerSlide[]>([]);
  const [draft, setDraft] = useState<BannerSlide | null>(null);
  /** Index the draft will be written back to, or null when adding a new slide. */
  const [draftIndex, setDraftIndex] = useState<number | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setSlides(settings.banner_slides);
    setDraft(null);
    setDraftIndex(null);
  }, [settings]);

  const persist = async (next: BannerSlide[]) => {
    setIsSaving(true);
    try {
      const { error } = await supabase
        .from('app_settings')
        .upsert(
          [{ key: BANNER_SLIDES_KEY, value: serializeBannerSlides(next) }],
          { onConflict: 'key' }
        );
      if (error) throw error;
      setSlides(next);
      await refetch();
      showToast('Banner slides saved');
      return true;
    } catch (error) {
      console.error('Banner slides save failed:', error);
      showToast('Could not save banner slides. Please try again.', 'error');
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleActive = (index: number) => {
    void persist(
      slides.map((s, i) => (i === index ? { ...s, is_active: !s.is_active } : s))
    );
  };

  const handleDelete = (index: number) => {
    void persist(slides.filter((_, i) => i !== index));
  };

  const handleDrop = (targetIndex: number) => {
    if (dragIndex === null || dragIndex === targetIndex) {
      setDragIndex(null);
      return;
    }
    const next = [...slides];
    const [moved] = next.splice(dragIndex, 1);
    next.splice(targetIndex, 0, moved);
    setDragIndex(null);
    void persist(next);
  };

  const handleSaveDraft = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    const next =
      draftIndex === null
        ? [...slides, draft]
        : slides.map((s, i) => (i === draftIndex ? draft : s));
    const ok = await persist(next);
    if (ok) {
      setDraft(null);
      setDraftIndex(null);
    }
  };

  const updateDraft = (patch: Partial<BannerSlide>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };

  return (
    <div className="admin-panel">
      <h3 className="admin-panel__title">Banner Slides</h3>
      <p className="admin-panel__description">
        The swipeable hero banner on the homepage. Drag the handle to reorder —
        slides show in this order.
      </p>

      {slides.length === 0 ? (
        <p className="banner-admin__empty">No slides yet.</p>
      ) : (
        <ul className="banner-admin__list">
          {slides.map((slide, index) => (
            <li
              key={`${slide.title}-${index}`}
              className={`banner-admin__row${
                dragIndex === index ? ' banner-admin__row--dragging' : ''
              }`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => handleDrop(index)}
            >
              <span
                className="banner-admin__handle"
                draggable
                onDragStart={() => setDragIndex(index)}
                onDragEnd={() => setDragIndex(null)}
                aria-label={`Reorder ${slide.title || 'untitled slide'}`}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01" />
                </svg>
              </span>

              <span className="banner-admin__preview">
                {slide.title || 'Untitled slide'}
              </span>

              <button
                type="button"
                className={`toggle toggle--small${slide.is_active ? ' toggle--on' : ''}`}
                onClick={() => handleToggleActive(index)}
                disabled={isSaving}
                role="switch"
                aria-checked={slide.is_active}
                aria-label={`${slide.is_active ? 'Hide' : 'Show'} ${
                  slide.title || 'untitled slide'
                }`}
              >
                <span className="toggle__thumb" />
              </button>

              <button
                type="button"
                className="button button--secondary button--small"
                onClick={() => {
                  setDraft(slide);
                  setDraftIndex(index);
                }}
              >
                Edit
              </button>
              <button
                type="button"
                className="button button--danger-outline button--small"
                onClick={() => handleDelete(index)}
                disabled={isSaving}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      {draft === null ? (
        <button
          type="button"
          className="button button--secondary"
          onClick={() => {
            setDraft(emptyBannerSlide());
            setDraftIndex(null);
          }}
        >
          Add Slide
        </button>
      ) : (
        <form onSubmit={handleSaveDraft} className="form banner-admin__form" noValidate>
          <h4 className="banner-admin__form-title">
            {draftIndex === null ? 'New Slide' : 'Edit Slide'}
          </h4>

          <div className="form-field">
            <label className="form-label" htmlFor="banner-eyebrow">
              Eyebrow Text
            </label>
            <input
              id="banner-eyebrow"
              type="text"
              className="form-input"
              placeholder="🇦🇺 Direct from Australia"
              value={draft.eyebrow_text}
              onChange={(e) => updateDraft({ eyebrow_text: e.target.value })}
            />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="banner-title">
              Headline <span className="form-required" aria-hidden="true">*</span>
            </label>
            <input
              id="banner-title"
              type="text"
              className="form-input"
              placeholder="Premium Skincare at Your Fingertips"
              value={draft.title}
              onChange={(e) => updateDraft({ title: e.target.value })}
              required
            />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="banner-cta-text">
              CTA Button Text
            </label>
            <input
              id="banner-cta-text"
              type="text"
              className="form-input"
              placeholder="Shop Now →"
              value={draft.cta_button_text}
              onChange={(e) => updateDraft({ cta_button_text: e.target.value })}
            />
          </div>

          <div className="form-field">
            <label className="form-label" htmlFor="banner-cta-action">
              CTA Action
            </label>
            <select
              id="banner-cta-action"
              className="form-input"
              value={draft.cta_action}
              onChange={(e) =>
                updateDraft({ cta_action: e.target.value as BannerCtaAction })
              }
            >
              {(
                Object.keys(CTA_ACTION_LABELS) as BannerCtaAction[]
              ).map((action) => (
                <option key={action} value={action}>
                  {CTA_ACTION_LABELS[action]}
                </option>
              ))}
            </select>
          </div>

          {draft.cta_action === 'open_url' && (
            <div className="form-field">
              <label className="form-label" htmlFor="banner-cta-url">
                CTA Link <span className="form-required" aria-hidden="true">*</span>
              </label>
              <input
                id="banner-cta-url"
                type="url"
                className="form-input"
                placeholder="https://example.com"
                value={draft.cta_url}
                onChange={(e) => updateDraft({ cta_url: e.target.value })}
                required
              />
            </div>
          )}

          <div className="form-field form-field--toggle">
            <span className="toggle-label">Active</span>
            <button
              type="button"
              className={`toggle${draft.is_active ? ' toggle--on' : ''}`}
              onClick={() => updateDraft({ is_active: !draft.is_active })}
              role="switch"
              aria-checked={draft.is_active}
              aria-label="Slide active"
            >
              <span className="toggle__thumb" />
            </button>
          </div>

          <div className="banner-admin__form-actions">
            <button
              type="submit"
              className="button button--primary"
              disabled={isSaving || draft.title.trim() === ''}
            >
              {isSaving ? <span className="spinner" aria-hidden="true" /> : 'Save Slide'}
            </button>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                setDraft(null);
                setDraftIndex(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export function SettingsTab() {
  const { signOut } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [isSavingPassword, setIsSavingPassword] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const handleChangePassword = async (e: FormEvent) => {
    e.preventDefault();
    setPasswordError(null);
    if (newPassword.length < PASSWORD_MIN_LENGTH) {
      setPasswordError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('Passwords do not match');
      return;
    }
    setIsSavingPassword(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setIsSavingPassword(false);
    if (error) {
      setPasswordError('Could not update password. Please try again.');
      return;
    }
    setNewPassword('');
    setConfirmPassword('');
    showToast('Password updated');
  };

  const handleClearCache = () => {
    clearCache();
    showToast('Saved data cleared');
  };

  const handleSignOut = async () => {
    setIsSigningOut(true);
    // Leave /admin first so ProtectedRoute doesn't read the intentional
    // sign-out as an expired session and show the wrong toast.
    navigate('/');
    await signOut();
  };

  return (
    <section aria-label="Settings">
      <header className="admin-section-header">
        <h2 className="admin-section-title">Settings</h2>
      </header>

      <ExpertSettingsPanel />

      <ShopWhatsAppPanel />

      <OrderPaymentSettingsPanel />

      <AdTrackingSettingsPanel />

      <BannerSlidesPanel />

      <div className="admin-panel">
        <h3 className="admin-panel__title">Change Password</h3>
        <form onSubmit={handleChangePassword} className="form" noValidate>
          <div className="form-field">
            <label className="form-label" htmlFor="settings-new-password">
              New password
            </label>
            <input
              id="settings-new-password"
              type="password"
              className="form-input"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              minLength={PASSWORD_MIN_LENGTH}
            />
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="settings-confirm-password">
              Confirm password
            </label>
            <input
              id="settings-confirm-password"
              type="password"
              className="form-input"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              minLength={PASSWORD_MIN_LENGTH}
            />
          </div>
          {passwordError && (
            <p className="form-error" role="alert">
              {passwordError}
            </p>
          )}
          <button
            type="submit"
            className="button button--primary"
            disabled={isSavingPassword || newPassword === '' || confirmPassword === ''}
          >
            {isSavingPassword ? <span className="spinner" aria-hidden="true" /> : 'Save'}
          </button>
        </form>
      </div>

      <div className="admin-panel">
        <h3 className="admin-panel__title">Clear Saved Data</h3>
        <p className="admin-panel__description">
          Removes the offline copy of products stored on this device.
        </p>
        <button type="button" className="button button--secondary" onClick={handleClearCache}>
          Clear Saved Data
        </button>
      </div>

      <div className="admin-panel">
        <h3 className="admin-panel__title">Sign Out</h3>
        <button
          type="button"
          className="button button--danger-outline"
          onClick={handleSignOut}
          disabled={isSigningOut}
        >
          {isSigningOut ? <span className="spinner" aria-hidden="true" /> : 'Sign Out'}
        </button>
      </div>
    </section>
  );
}
