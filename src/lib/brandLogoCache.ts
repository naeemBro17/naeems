import type { LogoKind } from './logoProcess';
import type { CleanedLogo } from './logoClean';

/* Display-time clean-up of brand logos (Batch 29 Part 5), so logos uploaded
   before this batch look right without Naeem re-uploading anything.

   Each logo is cleaned once per phone — in a Web Worker when the phone can
   (off the main thread), else on the main thread — and the result is kept
   in the browser's Cache Storage, so later visits read it straight back.
   Logo URLs never change once uploaded (a replaced logo gets a new file
   name), so a cached result never goes stale. If a logo can't be read (no
   CORS, an error, too slow), it is shown exactly as it was before. */

export interface LogoWorkerRequest {
  id: number;
  fetchUrl: string;
}

export type LogoWorkerReply = ({ id: number; ok: true } & CleanedLogo) | { id: number; ok: false };

export interface DisplayLogo {
  /** What to put in <img src>: the cleaned copy, or the original URL. */
  src: string;
  kind: LogoKind;
  /** Card colour for a colour-background logo, else null. */
  background: string | null;
}

const CACHE_NAME = 'nph-brand-logos-v1';
const KIND_HEADER = 'x-logo-kind';
const BACKGROUND_HEADER = 'x-logo-background';
/** Give up and show the original after this long. */
const TIMEOUT_MS = 6000;
const KINDS: readonly LogoKind[] = ['transparent', 'cleared', 'colour', 'plain'];

const pending = new Map<string, Promise<DisplayLogo>>();
const settled = new Map<string, DisplayLogo>();

function asIs(url: string): DisplayLogo {
  return { src: url, kind: 'plain', background: null };
}

/**
 * The URL the cleaner downloads. A separate query string keeps it apart from
 * the copy the offline helper (service worker) may have stored for a normal
 * <img> — that copy is "opaque" (unreadable to scripts) and would make the
 * read fail.
 */
function fetchUrlFor(url: string): string {
  try {
    const u = new URL(url, window.location.href);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return url;
    u.searchParams.set('nph-logo', '1');
    return u.toString();
  } catch {
    return url;
  }
}

/* ---------- The worker (one, created on first use) ---------- */

let worker: Worker | null = null;
let workerBroken = false;
let nextId = 0;
const waiting = new Map<number, (reply: LogoWorkerReply) => void>();

function canUseWorker(): boolean {
  return (
    !workerBroken &&
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    'convertToBlob' in OffscreenCanvas.prototype
  );
}

function getWorker(): Worker | null {
  if (!canUseWorker()) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./logoWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<LogoWorkerReply>) => {
      const resolve = waiting.get(event.data.id);
      waiting.delete(event.data.id);
      resolve?.(event.data);
    };
    worker.onerror = () => {
      workerBroken = true;
      worker = null;
      for (const [id, resolve] of waiting) resolve({ id, ok: false });
      waiting.clear();
    };
    return worker;
  } catch {
    workerBroken = true;
    return null;
  }
}

async function cleanOnMainThread(fetchUrl: string): Promise<CleanedLogo | null> {
  try {
    const res = await fetch(fetchUrl, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) return null;
    const { cleanLogoBlob } = await import('./logoClean');
    return await cleanLogoBlob(await res.blob());
  } catch {
    return null;
  }
}

function clean(url: string): Promise<CleanedLogo | null> {
  const fetchUrl = fetchUrlFor(url);
  const w = getWorker();
  if (!w) return cleanOnMainThread(fetchUrl);
  return new Promise((resolve) => {
    nextId += 1;
    const id = nextId;
    waiting.set(id, (reply) => {
      if (!reply.ok) {
        resolve(null);
        return;
      }
      resolve({ kind: reply.kind, background: reply.background, blob: reply.blob });
    });
    w.postMessage({ id, fetchUrl } satisfies LogoWorkerRequest);
  });
}

/* ---------- The per-phone cache ---------- */

async function openCache(): Promise<Cache | null> {
  try {
    return typeof caches === 'undefined' ? null : await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

function fromStored(url: string, kind: LogoKind, background: string | null, blob: Blob | null): DisplayLogo {
  return {
    src: blob && blob.size > 0 ? URL.createObjectURL(blob) : url,
    kind,
    background,
  };
}

async function readStored(cache: Cache | null, url: string): Promise<DisplayLogo | null> {
  if (!cache) return null;
  try {
    const hit = await cache.match(url);
    if (!hit) return null;
    const kind = hit.headers.get(KIND_HEADER) as LogoKind | null;
    if (!kind || !KINDS.includes(kind)) return null;
    const background = hit.headers.get(BACKGROUND_HEADER) || null;
    return fromStored(url, kind, background, await hit.blob());
  } catch {
    return null;
  }
}

async function store(cache: Cache | null, url: string, cleaned: CleanedLogo): Promise<void> {
  if (!cache) return;
  try {
    await cache.put(
      url,
      new Response(cleaned.blob ?? '', {
        headers: {
          'Content-Type': cleaned.blob ? 'image/webp' : 'text/plain',
          [KIND_HEADER]: cleaned.kind,
          [BACKGROUND_HEADER]: cleaned.background ?? '',
        },
      })
    );
  } catch {
    // Storage full or blocked — it will simply be cleaned again next visit.
  }
}

async function resolveLogo(url: string): Promise<DisplayLogo> {
  const cache = await openCache();
  const stored = await readStored(cache, url);
  if (stored) return stored;
  const cleaned = await clean(url);
  if (!cleaned) return asIs(url);
  void store(cache, url, cleaned);
  return fromStored(url, cleaned.kind, cleaned.background, cleaned.blob);
}

/** The cleaned logo if it's already known this session (no waiting). */
export function peekLogo(url: string): DisplayLogo | undefined {
  return settled.get(url);
}

/** The cleaned logo — from memory, this phone's cache, or cleaned now. */
export function loadLogo(url: string): Promise<DisplayLogo> {
  const known = pending.get(url);
  if (known) return known;
  const timeout = new Promise<DisplayLogo>((resolve) => {
    window.setTimeout(() => resolve(asIs(url)), TIMEOUT_MS);
  });
  const promise = Promise.race([resolveLogo(url).catch(() => asIs(url)), timeout]).then((logo) => {
    settled.set(url, logo);
    return logo;
  });
  pending.set(url, promise);
  return promise;
}
