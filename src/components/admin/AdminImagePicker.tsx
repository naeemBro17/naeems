import { useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from 'react';
import { isAcceptedImageType, MAX_IMAGE_BYTES } from '../../lib/imageResize';
import { uploadAdminImage } from '../../lib/supabase';

interface AdminImagePickerProps {
  /** Fixed storage path (e.g. `banners/{id}.webp`) — upserted, so re-uploading
   *  replaces the same file instead of leaving the old one orphaned. */
  path: string;
  /** The field's current stored URL, or null if none is set. */
  value: string | null;
  onChange: (url: string | null) => void;
  shape?: 'circle' | 'rect';
  /** Accessible name for the hidden file input, e.g. "Banner slide image". */
  label: string;
  placeholderIcon?: ReactNode;
}

/**
 * The one admin "optional photo" field, used everywhere a single image is
 * uploaded outside the product multi-image flow (banner slides, category
 * circles, the expert photo). Uploads immediately on file choice — there is
 * no separate "pending file" step, so the preview always reflects what is
 * actually in Storage right now. The surrounding form still owns saving the
 * resulting URL into its own record.
 */
export function AdminImagePicker({
  path,
  value,
  onChange,
  shape = 'circle',
  label,
  placeholderIcon,
}: AdminImagePickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const uploadFile = async (file: File) => {
    if (!isAcceptedImageType(file)) {
      setError('Choose a JPG, PNG, or WebP image.');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setError('Image exceeds 10MB.');
      return;
    }
    setError(null);
    setIsUploading(true);
    try {
      const url = await uploadAdminImage(path, file);
      onChange(url);
    } catch (err) {
      console.error('Image upload failed:', err);
      setError('Could not upload the image. Please try again.');
    } finally {
      setIsUploading(false);
    }
  };

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await uploadFile(file);
  };

  // Desktop-only — touch devices have no drag-and-drop, so this only ever
  // arms on a mouse-driven drag (see ImageUploader, the multi-image field
  // this mirrors).
  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => setIsDragging(false);

  const handleDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (!isUploading && file) await uploadFile(file);
  };

  return (
    <div className="admin-image-picker">
      <div
        className={`admin-image-picker__preview admin-image-picker__preview--${shape}${
          isDragging ? ' admin-image-picker__preview--dragging' : ''
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {value ? <img src={value} alt="" /> : placeholderIcon}
      </div>
      <div className="admin-image-picker__actions">
        <button
          type="button"
          className="button button--secondary button--small"
          onClick={() => inputRef.current?.click()}
          disabled={isUploading}
        >
          {isUploading ? (
            <span className="spinner" aria-hidden="true" />
          ) : value ? (
            'Change image'
          ) : (
            'Upload image'
          )}
        </button>
        {value && (
          <button
            type="button"
            className="button button--danger-outline button--small"
            onClick={() => onChange(null)}
            disabled={isUploading}
          >
            Remove image
          </button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={handleFileChange}
        className="visually-hidden"
        aria-label={label}
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
