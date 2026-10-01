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
  currentTime?: number;
  duration?: number;
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
  const info = message.info as { playerState?: unknown; muted?: unknown; currentTime?: unknown; duration?: unknown };
  return {
    playerState: typeof info.playerState === 'number' ? info.playerState : undefined,
    muted: typeof info.muted === 'boolean' ? info.muted : undefined,
    currentTime: typeof info.currentTime === 'number' ? info.currentTime : undefined,
    duration: typeof info.duration === 'number' ? info.duration : undefined,
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

/** Show our cover this many seconds before the end, so YouTube's own end
 *  screen ("more videos") never gets a frame. */
const END_GUARD_S = 0.6;

/** After a tap, how long the shopper's choice (play / pause) wins over
 *  YouTube's reports — which can arrive late, from an earlier tap. After
 *  that, YouTube's own last reported state rules again. */
const TAP_INTENT_MS = 700;

/**
 * Our own cover (Batch 27): the video's YouTube thumbnail, our round Play
 * button and a small "Reviewed on YouTube" label — never YouTube's title,
 * channel picture, logo or pause screen. Shown before the first play, while
 * starting (a spinner in place of Play), while paused, and after the end.
 */
function VideoCover({ thumbnail, loading }: { thumbnail: string; loading: boolean }) {
  return (
    <>
      <img className="video-cover__img" src={thumbnail} alt="" loading="lazy" />
      <span className="video-cover__shade" aria-hidden="true" />
      {loading ? (
        <span className="spinner spinner--large video-cover__spinner" aria-hidden="true" />
      ) : (
        <span className="video-cover__play" aria-hidden="true">
          <PlayIcon />
        </span>
      )}
      <span className="video-cover__label">Reviewed on YouTube</span>
    </>
  );
}

/**
 * The product page's "Video review" (Batch 23 Part 7, cover redone in Batch
 * 27). The video is a trust signal — proof the product is real and reviewed
 * — so it must never pull the shopper away from ordering:
 *
 * - Idle, it's our cover (see VideoCover) at full width, 16:9.
 * - Tapped, it plays right there, inline. No sheet, no fullscreen, no page
 *   change; Add to Cart stays on the page.
 * - A transparent layer covers the whole player, so no tap can ever reach
 *   YouTube's title, logo or links (which open the YouTube app). The layer
 *   IS the control: tap to play/pause, plus our own sound button.
 * - Play / pause follows the shopper's tap at once (the label and our cover
 *   change on the tap itself, like any video app), then settles to what
 *   YouTube reports.
 * - Whenever it isn't confirmed playing (starting, paused — the cover goes
 *   up the moment Pause is tapped, before YouTube even answers — or within
 *   the last moment before the end) our cover sits over the player; when it
 *   ends, it goes back to the idle cover.
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
  /** What the shopper last asked for: playing (true) or paused (false). */
  const [wantPlaying, setWantPlaying] = useState(true);
  const [nearEnd, setNearEnd] = useState(false);
  const lastTapRef = useRef(0);
  const playerStateRef = useRef<number | null>(null);

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
    setWantPlaying(true);
    setNearEnd(false);
    playerStateRef.current = null;
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
      if (info.currentTime !== undefined && info.duration !== undefined && info.duration > 0) {
        const near = info.duration - info.currentTime <= END_GUARD_S;
        setNearEnd((was) => (was === near ? was : near));
      }
      if (info.playerState === undefined) return;
      if (info.playerState === YT_ENDED) {
        stop();
        return;
      }
      setPlayerState(info.playerState);
      playerStateRef.current = info.playerState;
      if (info.playerState === YT_PLAYING) setHasPlayed(true);
      // A report right after a tap may belong to an earlier tap.
      if (performance.now() - lastTapRef.current < TAP_INTENT_MS) return;
      if (info.playerState === YT_PLAYING) setWantPlaying(true);
      if (info.playerState === YT_PAUSED) setWantPlaying(false);
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.clearInterval(handshake);
      window.removeEventListener('message', onMessage);
    };
  }, [isActive, stop, command]);

  // YouTube only reports a state when it CHANGES. A moment after the last
  // tap, line the shopper's choice up with YouTube's last report again, so a
  // tap YouTube didn't follow can never leave the two out of step.
  const [tapCount, setTapCount] = useState(0);
  useEffect(() => {
    if (tapCount === 0) return undefined;
    const timer = window.setTimeout(() => {
      const state = playerStateRef.current;
      if (state === YT_PLAYING) setWantPlaying(true);
      if (state === YT_PAUSED) setWantPlaying(false);
    }, TAP_INTENT_MS);
    return () => window.clearTimeout(timer);
  }, [tapCount]);

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
      <button
        type="button"
        className="video-review"
        onClick={() => setIsActive(true)}
        aria-label="Play the video review"
        data-testid="video-cover"
      >
        <VideoCover thumbnail={thumbnail} loading={false} />
      </button>
    );
  }

  // The cover stays up unless the shopper wants it playing AND YouTube
  // confirms it is.
  const confirmedPlaying = playerState === YT_PLAYING;
  const showCover = !hasPlayed || !wantPlaying || !confirmedPlaying || nearEnd;

  // Until YouTube has really started, the control only ever means "play".
  const showsPause = hasPlayed && wantPlaying;

  const handleSurfaceTap = () => {
    if (!hasPlayed) {
      command('playVideo');
      return;
    }
    lastTapRef.current = performance.now();
    setTapCount((n) => n + 1);
    const next = !wantPlaying;
    setWantPlaying(next);
    command(next ? 'playVideo' : 'pauseVideo');
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
        {showCover && (
          <div className="video-player__poster" aria-hidden="true" data-testid="video-cover">
            <VideoCover thumbnail={thumbnail} loading={!hasPlayed} />
          </div>
        )}
        {/* Every tap on the video lands here, never on YouTube's links. */}
        <button
          type="button"
          className="video-player__surface"
          onClick={handleSurfaceTap}
          aria-label={showsPause ? 'Pause video' : 'Play video'}
        />
        {hasPlayed && (
          <button
            type="button"
            className="video-player__sound"
            onClick={handleSoundTap}
            aria-label={muted ? 'Turn sound on' : 'Turn sound off'}
          >
            <SoundIcon muted={muted} />
          </button>
        )}
      </div>
    </div>
  );
}
