import { PhotoStepError } from './imageResize';

/**
 * Fix 68.1: a failed product photo upload, said in one short plain line
 * for the red message under Photos (the full error goes to the console).
 */

const NETWORK_PATTERN = /failed to fetch|networkerror|network ?error|network request failed|load failed|err_internet|err_network|offline/i;
const DECODE_PATTERN = /decode|could not (read|open)/i;
const MEMORY_PATTERN = /memory|allocat|canvas|toblob|encod/i;

const MAX_DETAIL_LENGTH = 120;

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error !== null && typeof error === 'object' && 'message' in error) {
    const { message } = error as { message: unknown };
    if (typeof message === 'string') return message;
  }
  return String(error);
}

function nameOf(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'name' in error) {
    const { name } = error as { name: unknown };
    if (typeof name === 'string') return name;
  }
  return '';
}

/** The HTTP status a Supabase storage error carries, or null. */
export function uploadErrorStatus(error: unknown): number | null {
  if (error === null || typeof error !== 'object' || !('status' in error)) return null;
  const status = Number((error as { status: unknown }).status);
  return Number.isFinite(status) && status > 0 ? status : null;
}

/** A Supabase storage error (an object with the storage error marker). */
function isStorageError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && '__isStorageError' in error;
}

/** Whether the request never got an answer: the connection dropped, the
 *  phone is offline, or fetch itself failed (Supabase wraps that error). */
export function isNetworkFailure(error: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  if (error !== null && typeof error === 'object' && 'originalError' in error) {
    if (isNetworkFailure((error as { originalError: unknown }).originalError)) return true;
  }
  if (uploadErrorStatus(error) !== null) return false;
  const name = nameOf(error);
  if (name === 'NetworkError' || name === 'AbortError' || name === 'TimeoutError') return true;
  return NETWORK_PATTERN.test(messageOf(error));
}

function cut(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_DETAIL_LENGTH ? `${oneLine.slice(0, MAX_DETAIL_LENGTH - 3)}...` : oneLine;
}

const DECODE_LINE = 'This phone could not open the photo. Try a smaller photo or a screenshot of it.';
const MEMORY_LINE =
  'The phone ran out of memory while making the photo smaller. Close other apps and try one photo at a time.';
const NETWORK_LINE = 'The connection dropped while uploading. Check the internet and try again.';

export function describeUploadError(error: unknown): string {
  if (error instanceof PhotoStepError) return error.kind === 'decode' ? DECODE_LINE : MEMORY_LINE;
  if (isNetworkFailure(error)) return NETWORK_LINE;
  if (isStorageError(error)) {
    const status = uploadErrorStatus(error);
    const message = cut(messageOf(error)) || 'no reason given';
    return status === null ? `Storage said: ${message}` : `Storage said: ${message} (${status})`;
  }
  const name = nameOf(error);
  const message = messageOf(error);
  if (name === 'EncodingError' || DECODE_PATTERN.test(message)) return DECODE_LINE;
  if (error instanceof RangeError || MEMORY_PATTERN.test(message)) return MEMORY_LINE;
  return `Unexpected error: ${cut(message)}`;
}

/** Statuses worth trying again: a timeout, too many requests, a server error. */
export function isRetryableUploadError(error: unknown): boolean {
  const status = uploadErrorStatus(error);
  if (status !== null) return status === 408 || status === 429 || status >= 500;
  return isNetworkFailure(error);
}

export const UPLOAD_RETRY_DELAYS_MS: readonly number[] = [700, 1500];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs one storage upload, and tries again up to twice (after 700 ms, then
 * 1500 ms) only when it failed on the network or with 408 / 429 / 5xx.
 * Anything else (400, 401, 403, 404, 409, 413...) is returned at once.
 * `run` gets `isRetry` so a retry can use upsert: the first try may have
 * reached Storage and saved the file before its answer was lost, and the
 * retry would then be refused as a duplicate. The file names are new and
 * unique, so upsert can only ever replace the same photo.
 */
export async function withUploadRetry<T extends { error: unknown }>(
  run: (isRetry: boolean) => Promise<T>,
  wait: (ms: number) => Promise<void> = sleep
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const isLast = attempt >= UPLOAD_RETRY_DELAYS_MS.length;
    let result: T;
    try {
      result = await run(attempt > 0);
    } catch (error: unknown) {
      if (isLast || !isRetryableUploadError(error)) throw error;
      await wait(UPLOAD_RETRY_DELAYS_MS[attempt]);
      continue;
    }
    if (!result.error || isLast || !isRetryableUploadError(result.error)) return result;
    await wait(UPLOAD_RETRY_DELAYS_MS[attempt]);
  }
}
