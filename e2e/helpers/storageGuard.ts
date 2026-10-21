import { readFileSync } from 'node:fs';
import type { BrowserContext, Request, Response, Route } from '@playwright/test';

/**
 * Batch 40: tests never download real files from Supabase Storage.
 *
 * On 11 Oct 2026 Supabase blocked the whole shop for using 23.4 GB of
 * "cached egress" on a 5 GB plan. Each browser test starts with an empty
 * cache, so every test that opened Home downloaded about 2.5 MB of real
 * product photos and a brand video, ~400 tests per full run, many runs per
 * batch (reports/batch-40.txt Part 0).
 *
 * Every browser context in the suite (also the extra ones a test opens with
 * browser.newContext / browser.newPage) answers Storage file reads here,
 * with a 1×1 PNG for pictures and a 1-second, 1.4 KB MP4 for videos. Uploads
 * and deletes (POST / PUT / DELETE) still reach Storage: only a test that is
 * about uploading makes them, with its own tiny file that it removes again.
 * Such a test may read its OWN uploaded file back with allowStorageFile().
 *
 * A test that sets its own page.route for a Storage address wins over this
 * one; it should end with route.fallback() (comes back here), never
 * route.continue() (straight to the real network). Any real Storage file
 * that still reaches the browser is recorded and fails the test
 * (storageLeaks), so a new test can't quietly start downloading again.
 */

export const STORAGE_FILE = /^https:\/\/[a-z0-9-]+\.supabase\.co\/storage\/v1\/(object|render)\//;

/** Marks an answer that came from here, not from Supabase. */
export const PLACEHOLDER_HEADER = 'x-e2e-placeholder';

const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4AWO4e/fufwAIyQOXXY1kiQAAAABJRU5ErkJggg==',
  'base64'
);
const PLACEHOLDER_MP4 = readFileSync(new URL('../assets/placeholder.mp4', import.meta.url));

const VIDEO = /\.(mp4|webm|mov)(\?|$)/i;

/** A read of a stored file (not a listing, info or an upload). */
function isFileRead(request: Request): boolean {
  const method = request.method();
  if (method !== 'GET' && method !== 'HEAD') return false;
  return !/\/storage\/v1\/object\/(list|info)\//.test(request.url());
}

interface Guard {
  allowed: string[];
}

const guards = new WeakMap<BrowserContext, Guard>();

/** Every real Storage file read so far in this worker (address list). */
const leaks: string[] = [];

/** How many real Storage files this worker has read so far. A test reads
 *  it before and after to see what it caused. */
export function storageLeakCount(): number {
  return leaks.length;
}

/** The real Storage files read since `from` (see storageLeakCount). */
export function storageLeaksSince(from: number): string[] {
  return leaks.slice(from);
}

function withoutQuery(url: string): string {
  return url.split('?')[0];
}

/**
 * Answers this context's Storage reads locally. Safe to call twice: the
 * second call does nothing.
 */
export async function guardStorage(context: BrowserContext): Promise<void> {
  if (guards.has(context)) return;
  const guard: Guard = { allowed: [] };
  guards.set(context, guard);

  await context.route(STORAGE_FILE, (route: Route) => {
    const request = route.request();
    if (!isFileRead(request)) return route.fallback();
    if (guard.allowed.includes(withoutQuery(request.url()))) return route.fallback();
    const video = VIDEO.test(request.url());
    return route.fulfill({
      status: 200,
      contentType: video ? 'video/mp4' : 'image/png',
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        [PLACEHOLDER_HEADER]: '1',
      },
      body: request.method() === 'HEAD' ? '' : video ? PLACEHOLDER_MP4 : PLACEHOLDER_PNG,
    });
  });

  // A route answer has no server address; a file that came from Supabase
  // has one. Allowed own uploads are not counted.
  context.on('response', (response: Response) => {
    const request = response.request();
    if (!STORAGE_FILE.test(request.url()) || !isFileRead(request)) return;
    if (guard.allowed.includes(withoutQuery(request.url()))) return;
    void response
      .serverAddr()
      .then((addr) => {
        if (addr !== null) leaks.push(request.url());
      })
      .catch(() => undefined);
  });
}

/**
 * Lets a test that uploaded a file read that one file back for real
 * (e.g. to check the stored pixels). Only for the test's own tiny upload.
 */
export function allowStorageFile(context: BrowserContext, url: string): void {
  const guard = guards.get(context);
  if (guard) guard.allowed.push(withoutQuery(url));
}
