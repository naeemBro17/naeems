/* Batch 40 Part 2.5: brand banner videos are made small before they are
   stored — H.264 MP4, at most 720p, no sound track, about 1.5 MB for 20
   seconds. Five of the six videos in Storage were 1.7–5.2 MB and every visit
   to a brand page downloaded one again (reports/batch-40.txt Part 0).

   The work happens in the admin's own browser (WebCodecs, through the
   Mediabunny library, loaded only when a video is being made small), so no
   server is needed: Supabase's own video tools are not on the Free plan. */

/** The largest file a banner video may be. */
export const VIDEO_MAX_BYTES = 1.5 * 1024 * 1024;
/** Longer clips are cut to their first 20 seconds: a banner loops anyway. */
export const VIDEO_MAX_SECONDS = 20;
/** 720p: the short side at most 720 px, the long side at most 1280 px. */
export const VIDEO_MAX_SHORT_SIDE = 720;
export const VIDEO_MAX_LONG_SIDE = 1280;
/** Highest frame rate kept; a smooth banner needs no more. */
export const VIDEO_MAX_FPS = 30;
const MIN_BITRATE = 300_000;
const MAX_BITRATE = 1_200_000;
/** Room left for the file's own bookkeeping (the MP4 header). */
const SIZE_HEADROOM = 0.9;

/** The output size for a video of this size: 720p at most (or `maxShort`
 *  for a smaller try), never larger than the original, aspect ratio kept,
 *  even numbers (H.264 needs them). */
export function videoOutputSize(width: number, height: number, maxShort = VIDEO_MAX_SHORT_SIDE): { width: number; height: number } {
  const longSide = Math.max(width, height);
  const shortSide = Math.min(width, height);
  const maxLong = (VIDEO_MAX_LONG_SIDE * maxShort) / VIDEO_MAX_SHORT_SIDE;
  const scale = Math.min(1, maxLong / longSide, maxShort / shortSide);
  const even = (n: number) => Math.max(2, Math.floor((n * scale) / 2) * 2);
  return { width: even(width), height: even(height) };
}

/** The tries, in order, until the file is small enough: 720p first; then
 *  24 frames a second and a lower bitrate; then 540p. Some video encoders
 *  (phones, computers) won't go below a certain bitrate at 720p, so the
 *  later tries are what keeps any clip under 1.5 MB. */
export const VIDEO_TRIES: readonly { maxShort: number; fps: number; bitrateFactor: number }[] = [
  { maxShort: VIDEO_MAX_SHORT_SIDE, fps: VIDEO_MAX_FPS, bitrateFactor: 1 },
  { maxShort: VIDEO_MAX_SHORT_SIDE, fps: 24, bitrateFactor: 0.75 },
  { maxShort: 540, fps: 24, bitrateFactor: 0.75 },
];

/** The bitrate that keeps a clip of `seconds` (already cut to 20 s) inside
 *  VIDEO_MAX_BYTES; `factor` lowers it for a second try. */
export function videoBitrate(seconds: number, factor = 1): number {
  const budget = (VIDEO_MAX_BYTES * 8 * SIZE_HEADROOM) / Math.max(1, Math.min(seconds, VIDEO_MAX_SECONDS));
  return Math.round(Math.max(MIN_BITRATE, Math.min(MAX_BITRATE, budget * factor)));
}

export interface CompressedVideo {
  blob: Blob;
  width: number;
  height: number;
  seconds: number;
}

/** Why a video could not be made small. `unsupported` and `too-big` mean
 *  the shop shows the picture only; `unreadable` means the file itself. */
export class VideoCompressError extends Error {
  constructor(
    message: string,
    readonly reason: 'unsupported' | 'unreadable' | 'too-big'
  ) {
    super(message);
    this.name = 'VideoCompressError';
  }
}

/**
 * Makes one video small (see the top of this file), trying VIDEO_TRIES in
 * order until the result is at most VIDEO_MAX_BYTES. `onProgress` gets 0–1.
 */
export async function compressBrandVideo(source: Blob, onProgress?: (share: number) => void): Promise<CompressedVideo> {
  const { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output, Quality, canEncodeVideo } =
    await import('mediabunny');

  if (typeof VideoEncoder === 'undefined') {
    throw new VideoCompressError('This browser cannot make videos smaller. Use Chrome on a phone or computer.', 'unsupported');
  }

  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(source) });
  try {
    const track = await input.getPrimaryVideoTrack().catch(() => null);
    if (!track) throw new VideoCompressError('This file has no video that can be read.', 'unreadable');
    const fullSeconds = await input.computeDuration().catch(() => 0);
    if (!(fullSeconds > 0)) throw new VideoCompressError('This video could not be read.', 'unreadable');
    const seconds = Math.min(fullSeconds, VIDEO_MAX_SECONDS);
    const stats = await track.computePacketStats(120).catch(() => null);
    const sourceFps = stats?.averagePacketRate ?? VIDEO_MAX_FPS;

    let lastBytes = 0;
    for (const [attempt, tryOptions] of VIDEO_TRIES.entries()) {
      const size = videoOutputSize(track.displayWidth, track.displayHeight, tryOptions.maxShort);
      // Only ever fewer frames than the original, never invented ones.
      const frameRate = sourceFps > tryOptions.fps + 1 ? tryOptions.fps : undefined;
      const bitrate = videoBitrate(seconds, tryOptions.bitrateFactor);
      if (!(await canEncodeVideo('avc', { width: size.width, height: size.height, bitrate }))) {
        throw new VideoCompressError('This browser cannot make videos smaller. Use Chrome on a phone or computer.', 'unsupported');
      }
      const target = new BufferTarget();
      const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
      const conversion = await Conversion.init({
        input,
        output,
        video: {
          codec: 'avc',
          width: size.width,
          height: size.height,
          fit: 'contain',
          frameRate,
          quality: new Quality({ bitrate, bitrateMode: 'constant' }),
          keyFrameInterval: 2,
          forceTranscode: true,
        },
        audio: { discard: true },
        trim: fullSeconds > VIDEO_MAX_SECONDS ? { start: 0, end: VIDEO_MAX_SECONDS } : undefined,
      });
      if (!conversion.isValid) {
        throw new VideoCompressError('This browser cannot make this video smaller.', 'unsupported');
      }
      if (onProgress) conversion.onProgress = (p) => onProgress(Math.min(0.99, (attempt + p) / VIDEO_TRIES.length));
      await conversion.execute();
      const buffer = target.buffer;
      if (!buffer) throw new VideoCompressError('This video could not be made smaller.', 'unsupported');
      if (buffer.byteLength <= VIDEO_MAX_BYTES) {
        onProgress?.(1);
        return { blob: new Blob([buffer], { type: 'video/mp4' }), width: size.width, height: size.height, seconds };
      }
      lastBytes = buffer.byteLength;
    }
    throw new VideoCompressError(`Even made smaller, this video is ${megabytesText(lastBytes)} (the limit is 1.5 MB).`, 'too-big');
  } catch (err) {
    if (err instanceof VideoCompressError) throw err;
    throw new VideoCompressError('This video could not be made smaller.', 'unsupported');
  } finally {
    input.dispose();
  }
}

/** "5.1 MB" */
export function megabytesText(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A stored video made small by this shop (its name says so). */
export function isCompressedVideoUrl(url: string): boolean {
  return /-720p\.mp4(\?|$)/.test(url);
}
