/** 11-character YouTube video ids are always this alphabet. */
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Pull the video id out of any common YouTube URL shape (watch, youtu.be,
 * embed, shorts, live) — or null when the URL isn't a recognisable YouTube
 * link at all, so callers can fail gracefully instead of embedding garbage.
 */
export function extractYouTubeId(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, '');

  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return YT_ID_RE.test(id) ? id : null;
  }

  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') {
      const id = url.searchParams.get('v');
      return id && YT_ID_RE.test(id) ? id : null;
    }
    const match = /^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})/.exec(url.pathname);
    if (match) return match[1];
  }

  return null;
}

/** Where the embedded player lives — also the only origin its messages are
 *  trusted from (components/viewer/VideoReview.tsx). */
export const YOUTUBE_EMBED_ORIGIN = 'https://www.youtube-nocookie.com';

/**
 * The inline review player (Batch 23 Part 7): privacy-enhanced domain,
 * autoplaying on the shopper's tap, with every YouTube control, keyboard
 * shortcut, fullscreen button, annotation and related-video suggestion
 * turned off that YouTube lets an embed turn off. `enablejsapi` lets the
 * page's own play/pause and sound buttons drive it.
 */
export function youtubeEmbedUrl(id: string, pageOrigin: string): string {
  const params = new URLSearchParams({
    autoplay: '1',
    controls: '0',
    rel: '0',
    modestbranding: '1',
    playsinline: '1',
    disablekb: '1',
    fs: '0',
    iv_load_policy: '3',
    enablejsapi: '1',
    origin: pageOrigin,
  });
  return `${YOUTUBE_EMBED_ORIGIN}/embed/${id}?${params.toString()}`;
}

/** YouTube's own still for a video — shown before it plays, while paused
 *  and after it ends. */
export function youtubeThumbnailUrl(id: string): string {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}
