import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { supabase } from '../../../lib/supabase';
import { useProducts, type TextSettingKey } from '../../../contexts/ProductContext';
import { useToast } from '../../../hooks/useToast';
import { saveSettings } from '../../../lib/settingsLists';
import { isAcceptedImageType, MAX_IMAGE_BYTES, resizeImage } from '../../../lib/imageResize';
import { BottomSheet } from '../../shared/BottomSheet';
import { SheetFooter } from './SheetChrome';

export type ExpertEditSection = 'hero' | 'stats' | 'bio' | 'socials' | 'actions';

interface ExpertEditSheetProps {
  section: ExpertEditSection | null;
  onClose: () => void;
}

interface FieldSpec {
  key: TextSettingKey;
  label: string;
  placeholder?: string;
  multiline?: boolean;
}

/** Storage bucket + fixed path for the expert photo (created in migration-010). */
const EXPERT_PHOTO_BUCKET = 'expert-photos';
const EXPERT_PHOTO_PATH = 'expert-photo.webp';

const SECTIONS: Record<ExpertEditSection, { title: string; fields: FieldSpec[] }> = {
  hero: {
    title: 'Profile',
    fields: [
      { key: 'expert_name', label: 'Name', placeholder: 'Naeem' },
      { key: 'expert_title', label: 'Title', placeholder: 'Skincare Expert & Consultant' },
      { key: 'expert_location', label: 'Location', placeholder: 'Dhaka, Bangladesh' },
      {
        key: 'expert_reply_time',
        label: 'Reply time',
        placeholder: 'Typically replies within a few hours',
      },
    ],
  },
  stats: {
    title: 'Stats',
    fields: [
      { key: 'expert_stat_1_value', label: 'Stat 1 value', placeholder: '500+' },
      { key: 'expert_stat_1_label', label: 'Stat 1 label', placeholder: 'Happy Clients' },
      { key: 'expert_stat_2_value', label: 'Stat 2 value', placeholder: '5+' },
      { key: 'expert_stat_2_label', label: 'Stat 2 label', placeholder: 'Rating' },
      { key: 'expert_stat_3_value', label: 'Stat 3 value', placeholder: '3yr' },
      { key: 'expert_stat_3_label', label: 'Stat 3 label', placeholder: 'Expertise' },
    ],
  },
  bio: {
    title: 'About',
    fields: [{ key: 'expert_bio', label: 'Bio', multiline: true }],
  },
  socials: {
    title: 'Connect',
    fields: [
      { key: 'expert_facebook_url', label: 'Facebook URL', placeholder: 'https://facebook.com/…' },
      { key: 'messenger_link', label: 'Messenger link', placeholder: 'https://m.me/…' },
      { key: 'expert_instagram_url', label: 'Instagram URL', placeholder: 'https://instagram.com/…' },
      { key: 'expert_instagram_handle', label: 'Instagram handle', placeholder: '@naeem.skin' },
      {
        key: 'expert_whatsapp_url',
        label: 'WhatsApp (link or phone number)',
        placeholder: '8801XXXXXXXXX',
      },
      { key: 'expert_youtube_url', label: 'YouTube URL', placeholder: 'https://youtube.com/@…' },
      { key: 'expert_threads_url', label: 'Threads URL', placeholder: 'https://threads.net/…' },
      { key: 'expert_threads_handle', label: 'Threads handle', placeholder: '@naeem.skin' },
    ],
  },
  actions: {
    title: 'Action Buttons',
    fields: [
      {
        key: 'expert_appointment_url',
        label: 'Appointment booking URL',
        placeholder: 'https://calendly.com/…',
      },
      {
        key: 'expert_whatsapp_url',
        label: 'WhatsApp (link or phone number)',
        placeholder: '8801XXXXXXXXX',
      },
    ],
  },
};

/**
 * One sheet for every editable section of the expert profile page. Each
 * section is a list of app_settings text keys; the hero section also carries
 * the photo, which uploads on selection (with progress) and is written to
 * expert_photo_url alongside the other fields on Save.
 */
export function ExpertEditSheet({ section, onClose }: ExpertEditSheetProps) {
  const { settings, refetch } = useProducts();
  const { showToast } = useToast();

  const [values, setValues] = useState<Partial<Record<TextSettingKey, string>>>({});
  const [photoUrl, setPhotoUrl] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const spec = section ? SECTIONS[section] : null;

  useEffect(() => {
    if (!section) return;
    const next: Partial<Record<TextSettingKey, string>> = {};
    for (const field of SECTIONS[section].fields) {
      next[field.key] = settings[field.key];
    }
    setValues(next);
    setPhotoUrl(settings.expert_photo_url);
  }, [section, settings]);

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!isAcceptedImageType(file)) {
      showToast('Choose a JPG, PNG, or WebP image', 'error');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      showToast('Image exceeds 10MB', 'error');
      return;
    }
    setIsUploading(true);
    try {
      const blob = await resizeImage(file);
      const { error } = await supabase.storage
        .from(EXPERT_PHOTO_BUCKET)
        .upload(EXPERT_PHOTO_PATH, blob, { contentType: 'image/webp', upsert: true });
      if (error) throw error;
      const { data } = supabase.storage.from(EXPERT_PHOTO_BUCKET).getPublicUrl(EXPERT_PHOTO_PATH);
      // Cache-bust: the path is fixed, so the URL has to change for the new
      // image to show.
      setPhotoUrl(`${data.publicUrl}?v=${Date.now()}`);
      showToast('Photo uploaded — save to apply');
    } catch (error) {
      console.error('Expert photo upload failed:', error);
      showToast('Could not upload the photo', 'error');
    } finally {
      setIsUploading(false);
    }
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (!section) return;
    if (section === 'hero' && (values.expert_name ?? '').trim() === '') {
      showToast('Name is required', 'error');
      return;
    }
    setIsSaving(true);
    const payload: Partial<Record<TextSettingKey, string>> = {};
    for (const field of SECTIONS[section].fields) {
      const raw = values[field.key] ?? '';
      payload[field.key] = field.multiline ? raw : raw.trim();
    }
    if (section === 'hero') payload.expert_photo_url = photoUrl;

    const error = await saveSettings(payload);
    if (error) {
      console.error('Expert settings save failed:', error);
      setIsSaving(false);
      showToast('Could not save', 'error');
      return;
    }
    await refetch();
    setIsSaving(false);
    showToast('Saved');
    onClose();
  };

  return (
    <BottomSheet isOpen={section !== null} onClose={onClose} title={spec?.title ?? 'Edit'}>
      {spec && (
        <form className="form edit-sheet" onSubmit={handleSave} noValidate>
          {section === 'hero' && (
            <div className="form-field">
              <span className="form-label">Photo</span>
              <button
                type="button"
                className="edit-photo"
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploading}
                aria-label={photoUrl ? 'Change photo' : 'Add photo'}
              >
                {photoUrl !== '' ? (
                  <img src={photoUrl} alt="" className="edit-photo__img" />
                ) : (
                  <span className="edit-photo__empty">Tap to add a photo</span>
                )}
                {isUploading && (
                  <span className="edit-photo__progress" role="status" aria-live="polite">
                    <span className="spinner" aria-hidden="true" />
                    Uploading…
                  </span>
                )}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="visually-hidden"
                onChange={(e) => void handleFile(e)}
                tabIndex={-1}
              />
              {photoUrl !== '' && (
                <button
                  type="button"
                  className="edit-sheet__cancel"
                  onClick={() => setPhotoUrl('')}
                  disabled={isUploading}
                >
                  Remove photo
                </button>
              )}
            </div>
          )}

          {spec.fields.map((field) => (
            <div className="form-field" key={field.key}>
              <label className="form-label" htmlFor={`ee-${field.key}`}>
                {field.label}
              </label>
              {field.multiline ? (
                <textarea
                  id={`ee-${field.key}`}
                  className="form-input form-textarea"
                  rows={6}
                  value={values[field.key] ?? ''}
                  onChange={(e) =>
                    setValues((current) => ({ ...current, [field.key]: e.target.value }))
                  }
                />
              ) : (
                <input
                  id={`ee-${field.key}`}
                  type="text"
                  className="form-input"
                  placeholder={field.placeholder}
                  value={values[field.key] ?? ''}
                  onChange={(e) =>
                    setValues((current) => ({ ...current, [field.key]: e.target.value }))
                  }
                />
              )}
            </div>
          ))}

          <SheetFooter onCancel={onClose} isSaving={isSaving} disabled={isUploading} />
        </form>
      )}
    </BottomSheet>
  );
}
