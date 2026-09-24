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

/** Privacy-enhanced embed domain, autoplaying once the viewer opens it. */
export function youtubeEmbedUrl(id: string): string {
  return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`;
}
