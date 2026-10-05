/* Brand banner videos (Batch 29 Part 6): the still preview picture that
   shows while a video loads, and warming a video up before its page opens. */

/**
 * The still preview of a brand video: its first frame, saved next to the
 * video in Storage under a derived name (the video's path + ".poster.jpg"),
 * so no database column is needed. It exists for videos uploaded from Batch
 * 29 on, and for older ones once Admin → Brands → "Create missing video
 * previews" has been tapped.
 */
export function videoPosterUrl(videoUrl: string): string {
  const q = videoUrl.indexOf('?');
  return q === -1 ? `${videoUrl}.poster.jpg` : `${videoUrl.slice(0, q)}.poster.jpg${videoUrl.slice(q)}`;
}

interface NetworkInformationLike {
  saveData?: boolean;
  effectiveType?: string;
}

/** False on the browser's data saver or a slow (2g/3g) connection — never
 *  download a video nobody asked for there. */
export function canPreloadVideo(): boolean {
  const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  if (!connection) return true;
  if (connection.saveData === true) return false;
  return !['slow-2g', '2g', '3g'].includes(connection.effectiveType ?? '');
}

const started = new Set<string>();

/**
 * Downloads a brand video in the background so its page can start it at
 * once. The offline helper (service worker) keeps the whole file, so a
 * second visit plays straight from the phone, even offline. Once per video
 * per visit; skipped on data saver / slow connections.
 */
export function preloadBrandVideo(url: string | null, priority: 'high' | 'low' = 'low'): void {
  if (!url || started.has(url) || !canPreloadVideo()) return;
  started.add(url);
  const init: RequestInit & { priority?: 'high' | 'low' } = { mode: 'cors', credentials: 'omit', priority };
  void fetch(url, init)
    .then((res) => (res.ok ? res.arrayBuffer() : null))
    .catch(() => {
      started.delete(url);
    });
}
