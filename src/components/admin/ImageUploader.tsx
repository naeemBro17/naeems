import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ChangeEvent,
  type WheelEvent,
} from 'react';
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { isAcceptedImageType, MAX_IMAGE_BYTES } from '../../lib/imageResize';
import type { FormImage } from '../../types';

interface ImageUploaderProps {
  /** Current images in display order (existing URLs and pending files). */
  images: FormImage[];
  onAddFiles: (files: File[]) => void;
  onRemove: (id: string) => void;
  /** Called with the whole list in its new order after a drag. */
  onReorder: (next: FormImage[]) => void;
  /** True while images are uploading to Supabase Storage. */
  isUploading: boolean;
  /** Upload failure message (with retry handled by re-submitting the form). */
  uploadError: string | null;
}

/** Batch 33: a finger holds this long before a thumbnail lifts, so a normal
 *  swipe still scrolls the row. */
const TOUCH_HOLD_MS = 200;

/** The row only moves sideways — keep the lifted thumbnail on its line. */
const horizontalOnly: Modifier = ({ transform }) => ({ ...transform, y: 0 });

/** Adds a retry marker so a fresh copy is asked for instead of the one
 *  that just failed. */
function withRetry(url: string, attempt: number): string {
  if (attempt === 0) return url;
  return `${url}${url.includes('?') ? '&' : '?'}retry=${attempt}`;
}

interface ThumbProps {
  image: FormImage;
  index: number;
  count: number;
  onRemove: (id: string) => void;
}

/**
 * One thumbnail. It owns its preview: a just-picked file gets one local
 * object-URL for as long as this thumbnail exists (kept across reorders and
 * new additions, released only when it is removed or the editor closes);
 * a saved photo tries its small copy, then the full photo. If nothing
 * loads, a calm placeholder with Retry — never the browser's broken icon.
 */
function SortableThumb({ image, index, count, onRemove }: ThumbProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: image.id, disabled: count < 2 });

  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [candidate, setCandidate] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!image.file) return;
    const url = URL.createObjectURL(image.file);
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [image.file, attempt]);

  const candidates: string[] = image.file
    ? blobUrl
      ? [blobUrl]
      : []
    : [image.thumbUrl, image.url].filter((u): u is string => Boolean(u));
  const current = candidates[candidate];
  const src = current ? (image.file ? current : withRetry(current, attempt)) : null;

  const handleError = () => {
    if (candidate + 1 < candidates.length) setCandidate(candidate + 1);
    else setFailed(true);
  };

  const retry = () => {
    setFailed(false);
    setCandidate(0);
    setAttempt((n) => n + 1);
  };

  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
  };

  return (
    <li
      ref={(node) => {
        setNodeRef(node);
        setActivatorNodeRef(node);
      }}
      className={`image-uploader__item${isDragging ? ' image-uploader__item--dragging' : ''}`}
      style={style}
      data-testid="image-uploader-item"
      data-image-id={image.id}
      onContextMenu={(e) => e.preventDefault()}
      {...attributes}
      {...listeners}
      aria-label={
        count > 1
          ? `Image ${index + 1} of ${count}${index === 0 ? ', main image' : ''}. Press space to move it, then the arrow keys.`
          : `Image 1${index === 0 ? ', main image' : ''}`
      }
    >
      {failed || !src ? (
        <div className="image-uploader__placeholder" data-testid="image-uploader-placeholder">
          {failed ? (
            <button
              type="button"
              className="image-uploader__retry"
              onClick={retry}
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              aria-label={`Image ${index + 1} did not load — retry`}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M20 12a8 8 0 1 1-2.34-5.66" />
                <path d="M20 4v5h-5" />
              </svg>
              <span>Retry</span>
            </button>
          ) : null}
        </div>
      ) : (
        <img
          key={src}
          src={src}
          alt={`Product image ${index + 1}`}
          className="image-uploader__thumb"
          draggable={false}
          onError={handleError}
        />
      )}
      {index === 0 && <span className="image-uploader__main-tag">Main</span>}
      <button
        type="button"
        className="image-uploader__remove"
        onClick={() => onRemove(image.id)}
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
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
  const [isFileOver, setIsFileOver] = useState(false);

  // Batch 33: one standard library (dnd-kit) for every way of reordering —
  // mouse on PC (moves after 6 px, so a click is still a click), a finger
  // held ~200 ms on a phone (a quick swipe still scrolls the row), and the
  // keyboard (space, arrows, space). It auto-scrolls the row at its edges.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: TOUCH_HOLD_MS, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = images.findIndex((img) => img.id === active.id);
    const to = images.findIndex((img) => img.id === over.id);
    if (from === -1 || to === -1) return;
    onReorder(arrayMove(images, from, to));
  };

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
    setIsFileOver(false);
    acceptFiles(Array.from(e.dataTransfer.files));
  };

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    acceptFiles(Array.from(e.target.files ?? []));
    e.target.value = '';
  };

  // Files dragged in from the desktop (PC). Reordering never uses the
  // browser's own drag-and-drop, so the two can't get in each other's way.
  const fileDropProps = {
    onDragOver: (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      setIsFileOver(true);
    },
    onDragLeave: () => setIsFileOver(false),
    onDrop: handleDrop,
  };

  // A plain vertical mouse wheel does nothing to a horizontally-scrolling
  // row by default, so a mouse user with no trackpad could not reach the
  // rest of it. Redirect vertical wheel delta into horizontal scroll.
  // Touch scrolling never fires wheel events, so this is desktop-only.
  const handleWheel = (e: WheelEvent<HTMLUListElement>) => {
    if (e.deltaY === 0) return;
    e.currentTarget.scrollLeft += e.deltaY;
  };

  return (
    <div className="image-uploader">
      {images.length === 0 ? (
        <div
          className={`image-uploader__dropzone${isFileOver ? ' image-uploader__dropzone--active' : ''}`}
          {...fileDropProps}
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
        <>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[horizontalOnly]}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={images.map((img) => img.id)} strategy={horizontalListSortingStrategy}>
              <ul
                className="image-uploader__grid"
                aria-label="Product images — scroll to see more"
                onWheel={handleWheel}
                {...fileDropProps}
              >
                {images.map((image, index) => (
                  <SortableThumb
                    key={image.id}
                    image={image}
                    index={index}
                    count={images.length}
                    onRemove={(id) => {
                      setFileError(null);
                      onRemove(id);
                    }}
                  />
                ))}
                <li className="image-uploader__item image-uploader__item--add">
                  <button
                    type="button"
                    className={`image-uploader__add${isFileOver ? ' image-uploader__add--active' : ''}`}
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
            </SortableContext>
          </DndContext>
          {images.length > 1 && (
            <p className="image-uploader__sub-hint image-uploader__order-hint">
              Hold and drag a photo to reorder. The first one is the main photo.
            </p>
          )}
        </>
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
