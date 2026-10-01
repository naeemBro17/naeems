import { useCallback, useState } from 'react';
import { useTheme } from '../../contexts/ThemeContext';
import { brandLogoFor } from '../../lib/brands';
import { extractYouTubeId, youtubeBannerUrl } from '../../lib/youtube';
import type { Brand } from '../../types';

/** Reduce-motion or the browser's data saver: the picture only, no video. */
function prefersStillBanner(): boolean {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return reduced || connection?.saveData === true;
}

/**
 * The top of a brand page (Batch 26 Part 5): about 16:9, full width.
 * Uploaded video → plays muted, looping, inline, the banner image as its
 * poster; no sound button, controls or fullscreen. Otherwise a YouTube clip
 * (same rules), the banner image, or a soft gradient. The logo sits on a
 * rounded plate over it, with the same light/dark rules as the brand cards.
 */
export function BrandBanner({ brand }: { brand: Brand }) {
  const { theme } = useTheme();
  const [still] = useState(prefersStillBanner);
  const logo = brandLogoFor(brand, theme);
  const youtubeId = brand.banner_youtube_url ? extractYouTubeId(brand.banner_youtube_url) : null;
  const video = !still && brand.banner_video_url ? brand.banner_video_url : null;
  const youtube = !still && !video && youtubeId ? youtubeId : null;
  const image = brand.banner_image_url;

  // React sets `muted` as a property only; some phones decide autoplay from
  // the attribute itself, so it is written onto the element as well.
  const videoRef = useCallback((el: HTMLVideoElement | null) => {
    if (!el) return;
    el.muted = true;
    el.defaultMuted = true;
    el.setAttribute('muted', '');
  }, []);

  return (
    <div className="brand-banner" data-testid="brand-banner">
      <div className={`brand-banner__media${!video && !youtube && !image ? ' brand-banner__media--empty' : ''}`}>
        {image && <img className="brand-banner__image" src={image} alt="" decoding="async" />}
        {video && (
          <video
            ref={videoRef}
            className="brand-banner__video"
            src={video}
            poster={image ?? undefined}
            muted
            autoPlay
            loop
            playsInline
            preload="auto"
            disablePictureInPicture
            disableRemotePlayback
            controlsList="nodownload nofullscreen noremoteplayback"
            aria-hidden="true"
            tabIndex={-1}
            data-testid="brand-banner-video"
          />
        )}
        {youtube && (
          <>
            <iframe
              className="brand-banner__youtube"
              src={youtubeBannerUrl(youtube)}
              title={`${brand.name} video`}
              allow="autoplay; encrypted-media"
              tabIndex={-1}
              aria-hidden="true"
              data-testid="brand-banner-youtube"
            />
            <span className="brand-banner__cover" aria-hidden="true" />
          </>
        )}
      </div>
      <div className={`brand-banner__plate brand-banner__plate--${logo.tone}`}>
        {logo.src ? (
          <img className="brand-banner__logo" src={logo.src} alt={brand.name} width={120} height={60} decoding="async" />
        ) : (
          <span className="brand-banner__plate-name">{brand.name}</span>
        )}
      </div>
    </div>
  );
}
