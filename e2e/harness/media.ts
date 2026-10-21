/* Batch 40: runs in the test browser, served by a Vite dev server that
   e2e/batch-40.spec.ts starts (e2e/helpers/devServer.ts). It lets a test
   call the shop's own picture and video code (src/lib) directly — the
   admin pages that use it need the test admin login. */
import {
  ALL_FORMATS,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
} from 'mediabunny';
import { compressBrandVideo, VideoCompressError } from '../../src/lib/videoCompress';
import { resizeImage, resizeImageCard } from '../../src/lib/imageResize';
import { uploadProductPhoto } from '../../src/lib/productImages';
import { uploadAdminImage } from '../../src/lib/supabase';

/** A test clip like a real product video: a slowly moving coloured
 *  background, moving shapes and a line of text, at a high bitrate, with or
 *  without a sound track. */
export async function makeClip(options: { width: number; height: number; seconds: number; fps: number; audio: boolean }): Promise<Blob> {
  const { width, height } = options;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const video = new CanvasSource(canvas, { codec: 'avc', quality: new Quality({ bitrate: 8_000_000 }) });
  output.addVideoTrack(video, { frameRate: options.fps });
  const audio = options.audio ? new AudioBufferSource({ codec: 'aac', quality: new Quality({ bitrate: 128_000 }) }) : null;
  if (audio) output.addAudioTrack(audio);
  await output.start();
  const frames = Math.round(options.seconds * options.fps);
  for (let i = 0; i < frames; i += 1) {
    const t = i / options.fps;
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, `hsl(${(t * 20) % 360} 55% 75%)`);
    gradient.addColorStop(1, `hsl(${(t * 20 + 140) % 360} 45% 35%)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    for (let k = 0; k < 12; k += 1) {
      ctx.fillStyle = `hsl(${(k * 30) % 360} 70% 55%)`;
      ctx.beginPath();
      ctx.arc((width / 2) * (1 + Math.sin(t * (0.6 + k * 0.1) + k)), (height / 2) * (1 + Math.cos(t * (0.4 + k * 0.07) + k)), height / 12, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#fff';
    ctx.font = `${Math.round(height / 12)}px sans-serif`;
    ctx.fillText(`NAEEMS ${t.toFixed(1)} s`, width * 0.08, height * 0.9);
    await video.add(t, 1 / options.fps);
  }
  if (audio) {
    const sampleRate = 48_000;
    const buffer = new AudioBuffer({ length: Math.round(options.seconds * sampleRate), numberOfChannels: 1, sampleRate });
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.2;
    await audio.add(buffer);
  }
  await output.finalize();
  return new Blob([target.buffer as ArrayBuffer], { type: 'video/mp4' });
}

export interface ClipFacts {
  bytes: number;
  width: number;
  height: number;
  seconds: number;
  audioTracks: number;
  codec: string | null;
}

export async function inspectClip(blob: Blob): Promise<ClipFacts> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  try {
    const video = await input.getPrimaryVideoTrack();
    return {
      bytes: blob.size,
      width: video?.displayWidth ?? 0,
      height: video?.displayHeight ?? 0,
      seconds: await input.computeDuration(),
      audioTracks: (await input.getAudioTracks()).length,
      codec: video?.codec ?? null,
    };
  } finally {
    input.dispose();
  }
}

/** Makes a clip, makes it small with the shop's code, describes both. */
export async function compressTest(options: { width: number; height: number; seconds: number; fps: number; audio: boolean }): Promise<
  { ok: true; before: ClipFacts; after: ClipFacts } | { ok: false; before: ClipFacts; reason: string; message: string }
> {
  const clip = await makeClip(options);
  const before = await inspectClip(clip);
  try {
    const small = await compressBrandVideo(clip);
    return { ok: true, before, after: await inspectClip(small.blob) };
  } catch (err) {
    if (err instanceof VideoCompressError) return { ok: false, before, reason: err.reason, message: err.message };
    throw err;
  }
}

/** A photo-like test picture of the given size, as a JPEG file. */
async function testPhoto(width: number, height: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#f4d9c6');
  gradient.addColorStop(1, '#3a6ea5');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  for (let i = 0; i < 400; i += 1) {
    ctx.fillStyle = `hsl(${(i * 37) % 360} 60% 50%)`;
    ctx.beginPath();
    ctx.arc((i * 97) % width, (i * 53) % height, 6 + (i % 30), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#111';
  ctx.font = `${Math.round(width / 20)}px sans-serif`;
  ctx.fillText('NAEEMS Cleanser 236 ml', width * 0.1, height * 0.5);
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
}

async function sizeOf(blob: Blob): Promise<{ width: number; height: number; bytes: number; type: string }> {
  const bitmap = await createImageBitmap(blob);
  const out = { width: bitmap.width, height: bitmap.height, bytes: blob.size, type: blob.type };
  bitmap.close();
  return out;
}

/** The two versions the shop makes of an uploaded product photo. */
export async function photoVersions(width: number, height: number): Promise<{
  original: { width: number; height: number; bytes: number; type: string };
  large: { width: number; height: number; bytes: number; type: string };
  card: { width: number; height: number; bytes: number; type: string };
}> {
  const original = await testPhoto(width, height);
  return {
    original: await sizeOf(original),
    large: await sizeOf(await resizeImage(original)),
    card: await sizeOf(await resizeImageCard(original)),
  };
}

/** Stores a test photo twice the way the product editor does, and a
 *  one-photo field's photo twice (the test answers Storage itself). */
export async function uploadTest(): Promise<{ product: { url: string; cardUrl: string }[]; admin: string[] }> {
  const photo = await testPhoto(2000, 1500);
  const file = new File([photo], 'photo.jpg', { type: 'image/jpeg' });
  return {
    product: [await uploadProductPhoto(photo), await uploadProductPhoto(photo)],
    admin: [await uploadAdminImage('banners/slide-1.webp', file), await uploadAdminImage('banners/slide-1.webp', file)],
  };
}
