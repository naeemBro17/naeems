import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ChangeEvent,
  type WheelEvent,
} from 'react';
import { isAcceptedImageType, MAX_IMAGE_BYTES } from '../../lib/imageResize';
import { useDragReorder } from '../../hooks/useDragReorder';
import type { FormImage } from '../../types';

interface ImageUploaderProps {
  /** Current images in display order (existing URLs and pending files). */
  images: FormImage[];
  onAddFiles: (files: File[]) => void;
  onRemove: (id: string) => void;
  /** Hold-to-drag reorder — mirrors ImageStrip's own contract so both admin
   *  product editors behave the same way. */
  onReorder: (next: FormImage[]) => void;
  /** True while images are uploading to Supabase Storage. */
  isUploading: boolean;
  /** Upload failure message (with retry handled by re-submitting the form). */
  uploadError: string | null;
}

/** Hold time on the handle before a thumbnail lifts — matches ImageStrip. */
const HANDLE_LONG_PRESS_MS = 500;

function HandleGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="9" cy="6" r="1.7" />
      <circle cx="15" cy="6" r="1.7" />
      <circle cx="9" cy="12" r="1.7" />
      <circle cx="15" cy="12" r="1.7" />
      <circle cx="9" cy="18" r="1.7" />
      <circle cx="15" cy="18" r="1.7" />
    </svg>
  );
}

export function ImageUploader({
  images,
  onAddFiles,
  onRemove,
  onReorder,
  isUploading,
  uploadError,
}: ImageUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [previewUrls, setPreviewUrls] = useState<Map<string, string>>(new Map());

  // Same mechanism as ImageStrip (product edit sheet's own image list) — a
  // horizontal row so drag can resolve position along one axis. This grid
  // used to wrap to multiple rows with no reordering at all; a 2D grid
  // can't reuse this same one-axis hit-testing, so it's now a single
  // scrolling row instead, matching the sheet's own pattern exactly rather
  // than inventing separate reorder logic for a grid.
  const drag = useDragReorder<FormImage>({
    items: images,
    onReorder: (next) => onReorder(next),
    mode: 'move',
    axis: 'x',
    enabled: images.length > 1,
    longPressMs: HANDLE_LONG_PRESS_MS,
    keyOf: (image) => image.id,
  });

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

  // A plain vertical mouse wheel does nothing to a horizontally-scrolling
  // row by default, and this row deliberately stays single-line (see the
  // CSS comment on .image-uploader__grid) — so once it overflows, a mouse
  // user with no trackpad or precise scrollbar aim had no way to reach the
  // rest of it. Redirect vertical wheel delta into horizontal scroll.
  // Touch scrolling already works natively and never fires wheel events, so
  // this is desktop-only and changes nothing on mobile.
  const handleWheel = (e: WheelEvent<HTMLUListElement>) => {
    if (e.deltaY === 0) return;
    e.currentTarget.scrollLeft += e.deltaY;
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
        <ul
          className="image-uploader__grid"
          tabIndex={0}
          aria-label="Product images — scroll to see more"
          onWheel={handleWheel}
          {...dragProps}
        >
          {images.map((image, index) => {
            const src = image.url ?? previewUrls.get(image.id);
            const isDragged = drag.dragIndex === index;
            const style: CSSProperties = {};
            if (isDragged) {
              style.transform = `translateX(${drag.delta.x}px) scale(1.03)`;
            } else {
              const shift = drag.shiftFor(index);
              if (shift !== 0) style.transform = `translateX(${shift}px)`;
            }
            return (
              <li
                key={image.id}
                ref={drag.registerItem(index)}
                className={`image-uploader__item${isDragged ? ' image-uploader__item--dragging' : ''}${
                  isDragged && drag.isDragging ? ' image-uploader__item--live' : ''
                }`}
                style={style}
              >
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
                {images.length > 1 && (
                  <span
                    ref={drag.registerHandle(index)}
                    className="image-uploader__handle"
                    role="button"
                    tabIndex={-1}
                    aria-label={`Hold to drag image ${index + 1}`}
                  >
                    <HandleGlyph />
                  </span>
                )}
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
