import { useEffect, useRef, useState, type DragEvent, type ChangeEvent } from 'react';
import { isAcceptedImageType, MAX_IMAGE_BYTES } from '../../lib/imageResize';
import type { FormImage } from '../../types';

interface ImageUploaderProps {
  /** Current images in display order (existing URLs and pending files). */
  images: FormImage[];
  onAddFiles: (files: File[]) => void;
  onRemove: (id: string) => void;
  /** True while images are uploading to Supabase Storage. */
  isUploading: boolean;
  /** Upload failure message (with retry handled by re-submitting the form). */
  uploadError: string | null;
}

export function ImageUploader({
  images,
  onAddFiles,
  onRemove,
  isUploading,
  uploadError,
}: ImageUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [previewUrls, setPreviewUrls] = useState<Map<string, string>>(new Map());

  // Object URLs for pending files, keyed by image id; revoked on change/unmount.
  useEffect(() => {
    const urls = new Map<string, string>();
    for (const image of images) {
      if (image.file) {
        urls.set(image.id, URL.createObjectURL(image.file));
      }
    }
    setPreviewUrls(urls);
    return () => {
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [images]);

  const acceptFiles = (files: File[]) => {
    if (files.length === 0) return;
    const rejected: string[] = [];
    const accepted: File[] = [];
    for (const file of files) {
      if (!isAcceptedImageType(file)) {
        rejected.push(`'${file.name}' is not a JPG, PNG, or WebP image.`);
      } else if (file.size > MAX_IMAGE_BYTES) {
        rejected.push(`'${file.name}' exceeds 10MB.`);
      } else {
        accepted.push(file);
      }
    }
    setFileError(rejected.length > 0 ? rejected.join(' ') : null);
    if (accepted.length > 0) onAddFiles(accepted);
  };

  const handleDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    setIsDragging(false);
    acceptFiles(Array.from(e.dataTransfer.files));
  };

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    acceptFiles(Array.from(e.target.files ?? []));
    e.target.value = '';
  };

  const dragProps = {
    onDragOver: (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      setIsDragging(true);
    },
    onDragLeave: () => setIsDragging(false),
    onDrop: handleDrop,
  };

  return (
    <div className="image-uploader">
      {images.length === 0 ? (
        <div
          className={`image-uploader__dropzone${isDragging ? ' image-uploader__dropzone--active' : ''}`}
          {...dragProps}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
          role="button"
          tabIndex={0}
          aria-label="Upload product images"
        >
          <svg
            className="image-uploader__icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
          <p className="image-uploader__hint">
            Drag &amp; drop images, or tap to choose
          </p>
          <p className="image-uploader__sub-hint">JPG, PNG or WebP — max 10MB each</p>
        </div>
      ) : (
        <ul className="image-uploader__grid" {...dragProps}>
          {images.map((image, index) => {
            const src = image.url ?? previewUrls.get(image.id);
            return (
              <li key={image.id} className="image-uploader__item">
                {src && (
                  <img
                    src={src}
                    alt={`Product image ${index + 1}`}
                    className="image-uploader__thumb"
                  />
                )}
                {index === 0 && <span className="image-uploader__cover-tag">Cover</span>}
                <button
                  type="button"
                  className="image-uploader__remove"
                  onClick={() => {
                    setFileError(null);
                    onRemove(image.id);
                  }}
                  aria-label={`Remove image ${index + 1}`}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </li>
            );
          })}
          <li className="image-uploader__item">
            <button
              type="button"
              className={`image-uploader__add${isDragging ? ' image-uploader__add--active' : ''}`}
              onClick={() => inputRef.current?.click()}
              aria-label="Add more images"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              <span>Add</span>
            </button>
          </li>
        </ul>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        onChange={handleInputChange}
        className="visually-hidden"
        aria-label="Choose product image files"
      />

      {isUploading && (
        <div
          className="upload-progress"
          role="progressbar"
          aria-label="Uploading images"
        >
          <div className="upload-progress__bar" />
        </div>
      )}

      {(fileError || uploadError) && (
        <p className="form-error" role="alert">
          {fileError ?? uploadError}
        </p>
      )}
    </div>
  );
}
