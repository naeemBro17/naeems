import { useRef, useState, type ChangeEvent } from 'react';
import { supabase, uploadAdminImage } from '../../lib/supabase';
import { isAcceptedImageType, MAX_IMAGE_BYTES } from '../../lib/imageResize';
import { useProducts } from '../../contexts/ProductContext';
import { useToast } from '../../hooks/useToast';

const SETTING_KEY = 'account_intro_image';
const UPLOAD_PATH = 'settings/account-intro.webp';
const DEFAULT_PICTURE = '/brand/account-intro.jpg';

/**
 * Batch 68: the picture on the Account tab's Intro screen (before a customer
 * signs in). Uploaded and compressed like every other admin photo
 * (uploadAdminImage); stored as a public URL in app_settings. Empty = the
 * built-in picture.
 */
export function AccountIntroPicturePanel() {
  const { settings, refetch } = useProducts();
  const { showToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const stored = settings.account_intro_image?.trim() ?? '';
  const preview = stored || DEFAULT_PICTURE;

  const saveUrl = async (value: string, message: string) => {
    const { error } = await supabase.from('app_settings').upsert([{ key: SETTING_KEY, value }], { onConflict: 'key' });
    if (error) throw error;
    await refetch();
    showToast(message);
  };

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
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
    setIsBusy(true);
    try {
      const url = await uploadAdminImage(UPLOAD_PATH, file);
      await saveUrl(url, 'Picture saved');
    } catch (error) {
      console.error('Account intro picture save failed:', error);
      showToast('Could not save the picture. Please try again.', 'error');
    } finally {
      setIsBusy(false);
    }
  };

  const handleUseDefault = async () => {
    setIsBusy(true);
    try {
      await saveUrl('', 'Back to the default picture');
    } catch (error) {
      console.error('Account intro picture reset failed:', error);
      showToast('Could not save. Please try again.', 'error');
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="admin-panel" data-testid="account-intro-picture">
      <h3 className="admin-panel__title">Account intro picture</h3>
      <p className="admin-panel__description">
        Shown on the Account tab before a customer signs in. Use a picture with the same orange background (#FF7A45).
      </p>
      <div className="form-field">
        <div className="expert-photo-uploader">
          <div className="expert-photo-uploader__preview account-intro-preview">
            <img src={preview} alt="Account intro picture" />
          </div>
          <div className="expert-photo-uploader__actions">
            <button
              type="button"
              className="button button--secondary button--small"
              onClick={() => fileInputRef.current?.click()}
              disabled={isBusy}
            >
              {isBusy ? <span className="spinner" aria-hidden="true" /> : 'Change picture'}
            </button>
            {stored !== '' && (
              <button
                type="button"
                className="button button--secondary button--small"
                onClick={handleUseDefault}
                disabled={isBusy}
              >
                Use default
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
          aria-label="Choose account intro picture"
        />
        {fileError && (
          <p className="form-error" role="alert">
            {fileError}
          </p>
        )}
      </div>
    </div>
  );
}
