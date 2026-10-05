import { useCallback, useState } from 'react';
import { useTheme } from '../../contexts/ThemeContext';
import { extractYouTubeId, youtubeBannerUrl } from '../../lib/youtube';
import { videoPosterUrl } from '../../lib/brandVideo';
import { BrandLogoImage, brandCardStyle, useBrandLogo } from './BrandLogo';
import type { Brand } from '../../types';

/** Reduce-motion or the browser's data saver: the picture only, no video. */
function prefersStillBanner(): boolean {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return reduced || connection?.saveData === true;
}

/**
 * The top of a brand page (Batch 26 Part 5): about 16:9, full width.
 * Uploaded video → plays muted, looping, inline; no sound button, controls
 * or fullscreen. Otherwise a YouTube clip (same rules), the banner image, or
 * a soft gradient. The logo sits on a rounded plate over it, with the same
 * light/dark rules as the brand cards.
 *
 * Never blank while a video loads (Batch 29 Part 6): a still picture fills
 * exactly the video's box from the first paint — the video's own preview
 * frame, else the banner image, else the logo on a calm surface — and the
 * video fades in over it (250 ms) only once it is really playing. If it
 * never plays (blocked autoplay, slow network), the still simply stays.
 */
export function BrandBanner({ brand }: { brand: Brand }) {
  const { theme } = useTheme();
  const [still] = useState(prefersStillBanner);
  const logo = useBrandLogo(brand, theme);
  const [logoFailed, setLogoFailed] = useState(false);
  const youtubeId = brand.banner_youtube_url ? extractYouTubeId(brand.banner_youtube_url) : null;
  const video = !still && brand.banner_video_url ? brand.banner_video_url : null;
  const youtube = !still && !video && youtubeId ? youtubeId : null;
  const image = brand.banner_image_url;
  // Still pictures to try, in order; a missing one (e.g. no preview frame
  // made yet) moves on to the next.
  const stills = [brand.banner_video_url ? videoPosterUrl(brand.banner_video_url) : null, image].filter(
    (src): src is string => src !== null
  );
  const [stillIndex, setStillIndex] = useState(0);
  const stillSrc = stills[stillIndex] ?? null;
  const posterSrc = brand.banner_video_url && stillSrc === videoPosterUrl(brand.banner_video_url) ? stillSrc : null;
  const [playing, setPlaying] = useState(false);
  const hasVideo = brand.banner_video_url !== null;

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
      <div
        className={`brand-banner__media${!hasVideo && !youtube && !image ? ' brand-banner__media--empty' : ''}`}
        data-testid="brand-banner-media"
      >
        {hasVideo ? (
          <>
            <span
              className={`brand-banner__fallback brand-banner__fallback--${logo.tone}`}
              style={brandCardStyle(logo)}
              aria-hidden="true"
              data-testid="brand-banner-fallback"
            >
              {logo.src && !logoFailed ? (
                <BrandLogoImage view={logo} className="brand-banner__fallback-logo" width={160} height={80} onError={() => setLogoFailed(true)} />
              ) : (
                <span className="brand-banner__plate-name">{brand.name}</span>
              )}
            </span>
            {stillSrc !== null && (
              <img
                key={stillSrc}
                className="brand-banner__image brand-banner__still"
                src={stillSrc}
                alt=""
                decoding="async"
                // Only the preview frame is fetched with CORS: a missing one
                // then answers with a plain error (never kept by the offline
                // helper), so it can appear later without a stale miss.
                crossOrigin={posterSrc ? 'anonymous' : undefined}
                // The brand page's largest picture (its first paint).
                fetchPriority="high"
                onError={() => setStillIndex((i) => i + 1)}
                data-testid="brand-banner-still"
              />
            )}
          </>
        ) : (
          image && <img className="brand-banner__image" src={image} alt="" decoding="async" fetchPriority="high" />
        )}
        {video && (
          <video
            ref={videoRef}
            className={`brand-banner__video${playing ? ' brand-banner__video--playing' : ''}`}
            src={video}
            poster={image ?? undefined}
            onPlaying={() => setPlaying(true)}
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
      <div className={`brand-banner__plate brand-banner__plate--${logo.tone}`} style={brandCardStyle(logo)}>
        {logo.src && !logoFailed ? (
          <BrandLogoImage
            view={logo}
            className="brand-banner__logo"
            alt={brand.name}
            width={120}
            height={60}
            onError={() => setLogoFailed(true)}
          />
        ) : (
          <span className="brand-banner__plate-name">{brand.name}</span>
        )}
      </div>
    </div>
  );
}
