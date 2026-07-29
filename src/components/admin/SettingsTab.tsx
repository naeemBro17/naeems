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
import { resizeImage, isAcceptedImageType, MAX_IMAGE_BYTES } from '../../lib/imageResize';
import { useAuth } from '../../contexts/AuthContext';
import { useProducts } from '../../contexts/ProductContext';
import { useToast } from '../../hooks/useToast';

const PASSWORD_MIN_LENGTH = 8;
const EXPERT_PHOTO_PATH = 'settings/expert-photo.webp';

/** Expert contact settings — powers the /contact page and the floating button. */
function ExpertSettingsPanel() {
  const { settings, refetch } = useProducts();
  const { showToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [messengerLink, setMessengerLink] = useState('');
  const [expertName, setExpertName] = useState('');
  const [expertBio, setExpertBio] = useState('');
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
        ],
        { onConflict: 'key' }
      );
      if (error) throw error;

      await refetch();
showToast("Contact settings saved");
} catch (error) {
  alert(
    "SETTINGS SAVE ERROR:\n\n" +
    JSON.stringify(error, null, 2)
  );

  console.error("Settings save failed:", error);

  showToast(
    "Could not save contact settings. Please try again.",
    "error"
  );
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

        <button type="submit" className="button button--primary" disabled={isSaving}>
          {isSaving ? <span className="spinner" aria-hidden="true" /> : 'Save'}
        </button>
      </form>
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
