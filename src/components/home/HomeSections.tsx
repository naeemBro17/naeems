import { useEffect, useState, type CSSProperties, type MouseEvent } from 'react';
import { useAppNavigate } from '../../hooks/useAppNavigate';
import { useComboLines } from '../../hooks/useComboLines';
import { comboPath, comboTotals, fetchCombo, type ComboData } from '../../lib/combos';
import { formatTaka } from '../../lib/format';
import { openExternal, whatsAppUrl } from '../../lib/expertLinks';
import { youtubeThumbnailUrl } from '../../lib/youtube';
import { CONCERN_COLOURS, readVideoLink, type HomeConcern, type HomeVideo } from '../../lib/homeContent';
import type { AppSettings } from '../../types';
import { concernPath } from '../../lib/categoryFilter';

/** A real link; a plain tap navigates in the app. */
function useOpen() {
  const navigate = useAppNavigate();
  return (path: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(path);
  };
}

export function SectionHead({ title, link }: { title: string; link?: { label: string; to: string; external?: boolean } }) {
  const open = useOpen();
  return (
    <div className="b71-sec">
      <h2>{title}</h2>
      {link &&
        (link.external ? (
          <a href={link.to} target="_blank" rel="noopener noreferrer">
            {link.label}
          </a>
        ) : (
          <a href={link.to} onClick={open(link.to)}>
            {link.label}
          </a>
        ))}
    </div>
  );
}

/* ------------------------------------------------------- skin types */

const SKIN_ICON = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

const SKIN_TYPES: { name: string; icon: JSX.Element }[] = [
  {
    name: 'Normal',
    icon: (
      <svg {...SKIN_ICON}>
        <circle cx="12" cy="12" r="7" />
        <path d="M9 13.5c.8 1 1.8 1.5 3 1.5s2.2-.5 3-1.5" />
        <path d="M9.5 10h.01M14.5 10h.01" />
      </svg>
    ),
  },
  {
    name: 'Oily',
    icon: (
      <svg {...SKIN_ICON}>
        <path d="M12 3.5s-6 6.6-6 10.5a6 6 0 0 0 12 0c0-3.9-6-10.5-6-10.5z" />
        <path d="M9.5 14.5a2.5 2.5 0 0 0 2.5 2.5" />
      </svg>
    ),
  },
  {
    name: 'Combination',
    icon: (
      <svg {...SKIN_ICON}>
        <path d="M12 3.5s-6 6.6-6 10.5a6 6 0 0 0 6 6z" />
        <path d="M12 20.5a6 6 0 0 0 6-6c0-1.4-.8-3.2-1.8-4.8" />
        <path d="M14 9l1.5 2M17 6.5l-1 2.5" />
      </svg>
    ),
  },
  {
    name: 'Dry',
    icon: (
      <svg {...SKIN_ICON}>
        <path d="M4 7c3-2 5 2 8 0s5-2 8 0" />
        <path d="M4 12c3-2 5 2 8 0s5-2 8 0" />
        <path d="M8 16l2 3 2-2 2 3" />
      </svg>
    ),
  },
];

/** Batch 72: the Shop grid filtered by one skin type. */
function skinPath(name: string): string {
  return `/shop?skin=${encodeURIComponent(name)}`;
}

export function SkinTypes() {
  const open = useOpen();
  return (
    <section aria-label="Shop by skin type" data-testid="home-skin-types">
      <SectionHead title="Shop by skin type" />
      <div className="b71-sts">
        {SKIN_TYPES.map((t) => (
          <a key={t.name} href={skinPath(t.name)} className="b71-st" onClick={open(skinPath(t.name))}>
            <span>{t.icon}</span>
            {t.name}
          </a>
        ))}
      </div>
    </section>
  );
}

/* --------------------------------------------------------- concerns */

export function Concerns({ concerns }: { concerns: HomeConcern[] }) {
  const open = useOpen();
  if (concerns.length === 0) return null;
  return (
    <section aria-label="Shop by concern" data-testid="home-concerns">
      <SectionHead title="Shop by concern" />
      <div className="b71-hscroll">
        {concerns.map((c) => {
          const colour = CONCERN_COLOURS[c.colour];
          const style = { '--cc-bg': colour.bg, '--cc-ink': colour.ink } as CSSProperties;
          return (
            <a key={c.name} href={concernPath(c.name)} className="b71-cc" style={style} onClick={open(concernPath(c.name))}>
              <b>{c.name}</b>
              {c.line !== '' && <span>{c.line}</span>}
            </a>
          );
        })}
      </div>
    </section>
  );
}

/* ----------------------------------------------------------- combos */

function ComboCard({ combo }: { combo: ComboData }) {
  const open = useOpen();
  const lines = useComboLines(combo.items);
  if (lines.length === 0) return null;
  const { total } = comboTotals(lines);
  const photos = lines.slice(0, 3);
  const path = comboPath(combo.code);
  return (
    <a href={path} className="b71-cb" onClick={open(path)} data-testid="home-combo-card">
      <div className="b71-cb__img" aria-hidden="true">
        {photos.map((line) => (line.thumb ? <img key={line.key} src={line.thumb} alt="" loading="lazy" decoding="async" /> : <i key={line.key} />))}
      </div>
      <b>{combo.name}</b>
      <span>
        {lines.length} {lines.length === 1 ? 'product' : 'products'} · {formatTaka(total)}
      </span>
    </a>
  );
}

/** Each chosen combo through the public get_combo (works signed out). */
function useCombos(codes: string[]): ComboData[] {
  const [combos, setCombos] = useState<ComboData[]>([]);
  const key = codes.join(',');
  useEffect(() => {
    let live = true;
    if (key === '') {
      setCombos([]);
      return undefined;
    }
    void Promise.all(key.split(',').map((code) => fetchCombo(code))).then((loads) => {
      if (!live) return;
      setCombos(loads.flatMap((l) => (l.kind === 'ready' ? [l.combo] : [])));
    });
    return () => {
      live = false;
    };
  }, [key]);
  return combos;
}

export function BestCombos({ codes }: { codes: string[] }) {
  const combos = useCombos(codes);
  if (combos.length === 0) return null;
  return (
    <section aria-label="Our best combos" data-testid="home-combos">
      <SectionHead title="Our best combos" />
      <div className="b71-hscroll">
        {combos.map((c) => (
          <ComboCard key={c.code} combo={c} />
        ))}
      </div>
    </section>
  );
}

/* ----------------------------------------------------------- videos */

function PlayIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="#1c1c1e" aria-hidden="true">
      <path d="M8 5.5v13l11-6.5z" />
    </svg>
  );
}

/** Thumbnails only (no YouTube player until tapped); a tap opens YouTube. */
export function Videos({ videos, channelUrl }: { videos: HomeVideo[]; channelUrl: string }) {
  const cards = videos.flatMap((v) => {
    const link = readVideoLink(v.url);
    return link ? [{ ...v, ...link }] : [];
  });
  if (cards.length === 0) return null;
  const channel = channelUrl.trim();
  return (
    <section aria-label="Watch and learn" data-testid="home-videos">
      <SectionHead title="Watch and learn" link={channel !== '' ? { label: 'YouTube', to: channel, external: true } : undefined} />
      <div className="b71-hscroll">
        {cards.map((v) => (
          <a
            key={`${v.id}-${v.url}`}
            href={v.url}
            className={`b71-yt${v.isShort ? ' b71-yt--short' : ''}`}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={v.isShort ? 'home-video-short' : 'home-video'}
          >
            <div className="b71-yt__img">
              <img src={youtubeThumbnailUrl(v.id)} alt="" loading="lazy" decoding="async" />
              <i aria-hidden="true">
                <PlayIcon />
              </i>
            </div>
            {v.title !== '' && <p>{v.title}</p>}
          </a>
        ))}
      </div>
    </section>
  );
}

/* ----------------------------------------------------------- expert */

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 11.5a8.4 8.4 0 0 1-12.3 7.4L3 20.5l1.6-5.4A8.4 8.4 0 1 1 21 11.5z" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </svg>
  );
}

export function ExpertCard({ settings }: { settings: AppSettings }) {
  const open = useOpen();
  const [photoFailed, setPhotoFailed] = useState(false);
  const wa = whatsAppUrl(settings.expert_whatsapp_url);
  const booking = settings.expert_appointment_url.trim();
  const photo = settings.expert_photo_url.trim();
  return (
    <section className="b71-expert" aria-label="Talk with Naeem" data-testid="home-expert">
      <a href="/contact" onClick={open('/contact')} className="b71-expert__top">
        {photo !== '' && !photoFailed ? (
          <img className="b71-expert__av" src={photo} alt="" loading="lazy" decoding="async" onError={() => setPhotoFailed(true)} />
        ) : (
          <span className="b71-expert__av" aria-hidden="true" />
        )}
        <div>
          <small>Skincare expert</small>
          <b>Talk with Naeem</b>
          <p>Not sure what suits your skin? Ask me.</p>
        </div>
      </a>
      <div className="b71-expert__btns">
        {wa ? (
          <button type="button" className="b71-btn-o" onClick={() => openExternal(wa)}>
            <ChatIcon />
            Message
          </button>
        ) : (
          <a href="/contact" className="b71-btn-o" onClick={open('/contact')}>
            <ChatIcon />
            Message
          </a>
        )}
        {booking !== '' ? (
          <button type="button" className="b71-btn-o" onClick={() => openExternal(booking)}>
            <CalendarIcon />
            Book a session
          </button>
        ) : (
          <a href="/contact" className="b71-btn-o" onClick={open('/contact')}>
            <CalendarIcon />
            Book a session
          </a>
        )}
      </div>
    </section>
  );
}
