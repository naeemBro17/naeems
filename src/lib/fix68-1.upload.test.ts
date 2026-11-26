import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAcceptedImageType, PhotoStepError, resizeProductPhotoPair, withImageType } from './imageResize';
import { describeUploadError, withUploadRetry } from './uploadError';

/** A Supabase storage error as storage-js builds it. */
function storageError(message: string, status?: number, originalError?: unknown) {
  const error = new Error(message) as Error & { __isStorageError: boolean; status?: number; originalError?: unknown };
  error.name = status === undefined ? 'StorageUnknownError' : 'StorageApiError';
  error.__isStorageError = true;
  if (status !== undefined) error.status = status;
  if (originalError !== undefined) error.originalError = originalError;
  return error;
}

describe('Fix 68.1 Part 1: the real reason a photo upload failed', () => {
  it('a photo that cannot be opened', () => {
    expect(describeUploadError(new PhotoStepError('Reading the photo failed', 'decode'))).toBe(
      'This phone could not open the photo. Try a smaller photo or a screenshot of it.'
    );
  });

  it('memory, canvas or encoding failed', () => {
    const line =
      'The phone ran out of memory while making the photo smaller. Close other apps and try one photo at a time.';
    expect(describeUploadError(new PhotoStepError('Saving the large photo failed', 'memory'))).toBe(line);
    expect(describeUploadError(new RangeError('Array buffer allocation failed'))).toBe(line);
  });

  it('a dropped connection', () => {
    const line = 'The connection dropped while uploading. Check the internet and try again.';
    expect(describeUploadError(new TypeError('Failed to fetch'))).toBe(line);
    expect(describeUploadError(storageError('Failed to fetch', undefined, new TypeError('Failed to fetch')))).toBe(line);
  });

  it('a storage error shows its own message and status', () => {
    expect(describeUploadError(storageError('new row violates row-level security policy', 403))).toBe(
      'Storage said: new row violates row-level security policy (403)'
    );
  });

  it('anything else, cut at 120 characters', () => {
    expect(describeUploadError(new Error('Something odd'))).toBe('Unexpected error: Something odd');
    const long = describeUploadError(new Error('x'.repeat(300)));
    expect(long.startsWith('Unexpected error: ')).toBe(true);
    expect(long.length).toBe('Unexpected error: '.length + 120);
  });
});

describe('Fix 68.1 Part 4: phone pickers that give no file type', () => {
  it('an empty type is judged by the name; a real type as before', () => {
    expect(isAcceptedImageType(new File(['x'], 'IMG_2041.JPG', { type: '' }))).toBe(true);
    expect(isAcceptedImageType(new File(['x'], 'invoice.pdf', { type: '' }))).toBe(false);
    expect(isAcceptedImageType(new File(['x'], 'photo.jpg', { type: 'image/jpeg' }))).toBe(true);
    expect(isAcceptedImageType(new File(['x'], 'anim.gif', { type: 'image/gif' }))).toBe(false);
    expect(isAcceptedImageType(new File(['x'], 'anim.jpg', { type: 'image/gif' }))).toBe(false);
  });

  it('an accepted file with no type is given the type its name stands for', () => {
    expect(withImageType(new File(['x'], 'IMG_2041.JPEG', { type: '' })).type).toBe('image/jpeg');
    expect(withImageType(new File(['x'], 'shot.Png', { type: '' })).type).toBe('image/png');
    const typed = new File(['x'], 'photo.jpg', { type: 'image/jpeg' });
    expect(withImageType(typed)).toBe(typed);
  });
});

describe('Fix 68.1 Part 3: flaky uploads are tried again', () => {
  const noWait = vi.fn(async () => undefined);

  it('a network failure then success: success after 2 calls, the retry with upsert', async () => {
    const run = vi
      .fn<(isRetry: boolean) => Promise<{ error: unknown }>>()
      .mockResolvedValueOnce({ error: storageError('Failed to fetch', undefined, new TypeError('Failed to fetch')) })
      .mockResolvedValueOnce({ error: null });
    const result = await withUploadRetry(run, noWait);
    expect(result.error).toBeNull();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls.map((c) => c[0])).toEqual([false, true]);
  });

  it('a 403 is not tried again', async () => {
    const run = vi.fn(async () => ({ error: storageError('Unauthorized', 403) }));
    const result = await withUploadRetry(run, noWait);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.error).toBeTruthy();
  });

  it('three network failures give up and throw', async () => {
    const run = vi.fn(async (): Promise<{ error: unknown }> => {
      throw new TypeError('Failed to fetch');
    });
    const waits: number[] = [];
    await expect(
      withUploadRetry(run, async (ms) => {
        waits.push(ms);
      })
    ).rejects.toThrow('Failed to fetch');
    expect(run).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([700, 1500]);
  });

  it('a 503 is tried again, the last failure is returned', async () => {
    const run = vi.fn(async () => ({ error: storageError('Service Unavailable', 503) }));
    const result = await withUploadRetry(run, noWait);
    expect(run).toHaveBeenCalledTimes(3);
    expect(result.error).toBeTruthy();
  });
});

describe('Fix 68.1 Part 2: the photo is decoded once, one step at a time', () => {
  interface FakeContext {
    drawImage: ReturnType<typeof vi.fn>;
    imageSmoothingEnabled: boolean;
    imageSmoothingQuality: string;
  }
  interface FakeCanvas {
    width: number;
    height: number;
    ctx: FakeContext;
    getContext: () => FakeContext;
    toBlob: (cb: (blob: Blob | null) => void, type: string, quality: number) => void;
  }

  let canvases: FakeCanvas[];
  let events: string[];
  let toBlobResult: (type: string) => Blob | null;
  let bitmapClose: ReturnType<typeof vi.fn>;
  let createImageBitmapMock: ReturnType<typeof vi.fn>;
  const realCreateElement = document.createElement.bind(document);
  const realCreateObjectURL = URL.createObjectURL;
  const realRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    canvases = [];
    events = [];
    toBlobResult = (type) => new Blob(['x'], { type });
    bitmapClose = vi.fn();

    class FakeImage {
      naturalWidth = 4000;
      naturalHeight = 3000;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(value: string) {
        if (value) queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal('Image', FakeImage);
    URL.createObjectURL = vi.fn(() => 'blob:fake');
    URL.revokeObjectURL = vi.fn();
    createImageBitmapMock = vi.fn(async (_file: Blob, options: ImageBitmapOptions) => ({
      width: options.resizeWidth ?? 4000,
      height: options.resizeHeight ?? 3000,
      close: bitmapClose,
    }));
    vi.stubGlobal('createImageBitmap', createImageBitmapMock);

    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag !== 'canvas') return realCreateElement(tag);
      const index = canvases.length;
      const ctx: FakeContext = { drawImage: vi.fn(), imageSmoothingEnabled: false, imageSmoothingQuality: 'low' };
      const canvas: FakeCanvas = {
        width: 0,
        height: 0,
        ctx,
        getContext: () => ctx,
        toBlob: (cb, type, quality) => {
          events.push(`start ${index} ${type} ${quality}`);
          setTimeout(() => {
            events.push(`end ${index}`);
            cb(toBlobResult(type));
          }, 5);
        },
      };
      canvases.push(canvas);
      return canvas as unknown as HTMLCanvasElement;
    }) as typeof document.createElement);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    URL.createObjectURL = realCreateObjectURL;
    URL.revokeObjectURL = realRevokeObjectURL;
  });

  it('decodes once at the large size, draws the card from the large canvas, encodes one after the other', async () => {
    const pair = await resizeProductPhotoPair(new Blob(['photo'], { type: 'image/jpeg' }));

    expect(createImageBitmapMock).toHaveBeenCalledTimes(1);
    expect(createImageBitmapMock.mock.calls[0][1]).toMatchObject({
      imageOrientation: 'from-image',
      resizeWidth: 1400,
      resizeHeight: 1050,
    });
    expect(bitmapClose).toHaveBeenCalledTimes(1);

    expect(canvases).toHaveLength(2);
    const [largeCanvas, cardCanvas] = canvases;
    expect(cardCanvas.ctx.drawImage).toHaveBeenCalledWith(largeCanvas, 0, 0, 480, 360);
    expect(events).toEqual(['start 0 image/webp 0.85', 'end 0', 'start 1 image/webp 0.82', 'end 1']);
    expect(largeCanvas.width).toBe(0);
    expect(cardCanvas.width).toBe(0);
    expect(pair.large.type).toBe('image/webp');
    expect(pair.card.type).toBe('image/webp');
  });

  it('a small photo is never enlarged', async () => {
    class SmallImage {
      naturalWidth = 800;
      naturalHeight = 600;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(value: string) {
        if (value) queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal('Image', SmallImage);
    createImageBitmapMock.mockImplementation(async () => ({ width: 800, height: 600, close: bitmapClose }));
    await resizeProductPhotoPair(new Blob(['photo']));
    expect(createImageBitmapMock.mock.calls[0][1]).toEqual({ imageOrientation: 'from-image' });
    expect(canvases[0].ctx.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 800, 600);
  });

  it('a null toBlob throws an error that says which step failed', async () => {
    toBlobResult = () => null;
    const failure = resizeProductPhotoPair(new Blob(['photo']));
    await expect(failure).rejects.toBeInstanceOf(PhotoStepError);
    await expect(failure).rejects.toThrow('Saving the large photo failed');
  });

  it('a browser that cannot make WebP gets JPEG files', async () => {
    toBlobResult = (type) => new Blob(['x'], { type: type === 'image/webp' ? 'image/png' : type });
    const pair = await resizeProductPhotoPair(new Blob(['photo']));
    expect(pair.large.type).toBe('image/jpeg');
    expect(pair.card.type).toBe('image/jpeg');
  });

  it('without createImageBitmap the loaded image is drawn, still once', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    const pair = await resizeProductPhotoPair(new Blob(['photo']));
    expect(canvases[0].ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(canvases[0].ctx.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1400, 1050);
    expect(pair.large.type).toBe('image/webp');
  });
});
