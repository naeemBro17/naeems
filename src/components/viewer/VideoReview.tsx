import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import {
  YOUTUBE_EMBED_ORIGIN,
  extractYouTubeId,
  youtubeEmbedUrl,
  youtubeThumbnailUrl,
} from '../../lib/youtube';

/** YouTube's own player-state numbers, as reported over postMessage. */
const YT_ENDED = 0;
const YT_PLAYING = 1;
const YT_PAUSED = 2;

/** How often to say "listening" until the player first answers — the same
 *  handshake YouTube's own iframe_api script repeats until the player is
 *  ready. */
const HANDSHAKE_EVERY_MS = 250;

/** If the video hasn't started this long after the tap, the browser most
 *  likely refused to autoplay with sound — retry muted (always allowed). */
const SOUND_AUTOPLAY_GRACE_MS = 2500;

interface PlayerInfo {
  playerState?: number;
  muted?: boolean;
}

function readPlayerInfo(raw: unknown): PlayerInfo | null {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof data !== 'object' || data === null) return null;
  const message = data as { event?: unknown; info?: unknown };
  if (message.event === 'onStateChange' && typeof message.info === 'number') {
    return { playerState: message.info };
  }
  if (message.event !== 'infoDelivery' || typeof message.info !== 'object' || message.info === null) {
    return null;
  }
  const info = message.info as { playerState?: unknown; muted?: unknown };
  return {
    playerState: typeof info.playerState === 'number' ? info.playerState : undefined,
    muted: typeof info.muted === 'boolean' ? info.muted : undefined,
  };
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5.5v13l11-6.5-11-6.5z" />
    </svg>
  );
}

function SoundIcon({ muted }: { muted: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M11 5L6 9H3v6h3l5 4V5z" fill="currentColor" />
      {muted ? (
        <path d="M22 9l-6 6M16 9l6 6" />
      ) : (
        <path d="M15.5 8.5a5 5 0 010 7M18.5 5.5a9 9 0 010 13" />
      )}
    </svg>
  );
}

/**
 * The product page's "Video Review" (Batch 23 Part 7). The video is a trust
 * signal — proof the product is real and reviewed — so it must never pull
 * the shopper away from ordering:
 *
 * - Idle, it's a row with the video's real YouTube thumbnail.
 * - Tapped, it plays right there, inline, at full width (16:9). No sheet,
 *   no fullscreen, no page change; Add to Cart stays on the page.
 * - A transparent layer covers the whole player, so no tap can ever reach
 *   YouTube's title, logo or links (which open the YouTube app). The layer
 *   IS the control: tap to play/pause, plus our own sound button.
 * - While it isn't actually playing (starting, paused) the thumbnail covers
 *   the player, hiding YouTube's own pause screen and "more videos"; when
 *   it ends, it goes back to the thumbnail row.
 *
 * A link that isn't a recognisable YouTube video renders nothing — opening
 * an unknown link in a new tab would be exactly the exit this avoids.
 */
export function VideoReview({ url }: { url: string }) {
  const videoId = useMemo(() => extractYouTubeId(url), [url]);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [isActive, setIsActive] = useState(false);
  const [playerState, setPlayerState] = useState<number | null>(null);
  const [hasPlayed, setHasPlayed] = useState(false);
  const [muted, setMuted] = useState(false);

  const command = useCallback((func: string, args: unknown[] = []) => {
    frameRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: 'command', func, args }),
      YOUTUBE_EMBED_ORIGIN
    );
  }, []);

  const stop = useCallback(() => {
    setIsActive(false);
    setPlayerState(null);
    setHasPlayed(false);
    setMuted(false);
  }, []);

  // The player reports its state over postMessage once we say we're
  // listening (YouTube's documented embed protocol — no extra script).
  useEffect(() => {
    if (!isActive) return undefined;
    let answered = false;
    const handshake = window.setInterval(() => {
      if (answered) return;
      frameRef.current?.contentWindow?.postMessage(
        JSON.stringify({ event: 'listening', id: 'product-video-review', channel: 'widget' }),
        YOUTUBE_EMBED_ORIGIN
      );
      command('addEventListener', ['onStateChange']);
    }, HANDSHAKE_EVERY_MS);
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== YOUTUBE_EMBED_ORIGIN) return;
      if (event.source !== frameRef.current?.contentWindow) return;
      const info = readPlayerInfo(event.data);
      if (!info) return;
      answered = true;
      window.clearInterval(handshake);
      if (info.muted !== undefined) setMuted(info.muted);
      if (info.playerState === undefined) return;
      if (info.playerState === YT_ENDED) {
        stop();
        return;
      }
      setPlayerState(info.playerState);
      if (info.playerState === YT_PLAYING) setHasPlayed(true);
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.clearInterval(handshake);
      window.removeEventListener('message', onMessage);
    };
  }, [isActive, stop, command]);

  // Some browsers only allow a video to start by itself when it's silent.
  useEffect(() => {
    if (!isActive || hasPlayed) return undefined;
    const timer = window.setTimeout(() => {
      command('mute');
      command('playVideo');
      setMuted(true);
    }, SOUND_AUTOPLAY_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [isActive, hasPlayed, command]);

  if (!videoId) return null;
  const thumbnail = youtubeThumbnailUrl(videoId);

  if (!isActive) {
    return (
      <button type="button" className="video-review" onClick={() => setIsActive(true)}>
        <span className="video-review__thumb" aria-hidden="true">
          <img src={thumbnail} alt="" loading="lazy" />
          <span className="video-review__play">
            <PlayIcon />
          </span>
        </span>
        <span className="video-review__text">
          <span className="video-review__title">Watch Review</span>
          <span className="video-review__sub">Reviewed on YouTube</span>
        </span>
      </button>
    );
  }

  const isPlaying = playerState === YT_PLAYING;
  const showPoster = !hasPlayed || playerState === YT_PAUSED;

  const handleSurfaceTap = () => {
    command(isPlaying ? 'pauseVideo' : 'playVideo');
  };

  const handleSoundTap = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    command(muted ? 'unMute' : 'mute');
    setMuted(!muted);
  };

  return (
    <div className="video-player">
      <div className="video-player__frame">
        <iframe
          ref={frameRef}
          src={youtubeEmbedUrl(videoId, window.location.origin)}
          title="Product video review"
          allow="autoplay; encrypted-media; picture-in-picture"
          referrerPolicy="strict-origin-when-cross-origin"
          tabIndex={-1}
        />
        {showPoster && (
          <div className="video-player__poster" aria-hidden="true">
            <img src={thumbnail} alt="" />
            {hasPlayed ? (
              <span className="video-player__big-play">
                <PlayIcon />
              </span>
            ) : (
              <span className="spinner spinner--large video-player__spinner" />
            )}
          </div>
        )}
        {/* Every tap on the video lands here, never on YouTube's links. */}
        <button
          type="button"
          className="video-player__surface"
          onClick={handleSurfaceTap}
          aria-label={isPlaying ? 'Pause video' : 'Play video'}
        />
        <button
          type="button"
          className="video-player__sound"
          onClick={handleSoundTap}
          aria-label={muted ? 'Turn sound on' : 'Turn sound off'}
        >
          <SoundIcon muted={muted} />
        </button>
      </div>
      <p className="video-player__label">Reviewed on YouTube</p>
    </div>
  );
}
