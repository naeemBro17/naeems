import type { ReactNode } from 'react';
import type { AppSettings } from '../../types';
import { openExternal, whatsAppUrl } from '../../lib/expertLinks';

interface SocialLinksProps {
  settings: AppSettings;
}

const ICON_PROPS = {
  viewBox: '0 0 24 24',
  'aria-hidden': true,
} as const;

/* All platform marks are drawn monochrome and inherit currentColor — no brand
   colours, per the profile's editorial treatment. */

function FacebookIcon() {
  return (
    <svg {...ICON_PROPS} fill="currentColor">
      <path d="M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06c0 5.02 3.66 9.18 8.44 9.94v-7.03H7.9v-2.91h2.54V9.85c0-2.52 1.49-3.91 3.77-3.91 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.78-1.63 1.57v1.89h2.78l-.45 2.91h-2.33V22c4.78-.76 8.44-4.92 8.44-9.94z" />
    </svg>
  );
}

function MessengerIcon() {
  return (
    <svg {...ICON_PROPS} fill="currentColor">
      <path d="M12 2C6.48 2 2 6.13 2 11.25c0 2.92 1.46 5.52 3.75 7.22V22l3.42-1.88c.91.25 1.87.38 2.83.38 5.52 0 10-4.13 10-9.25S17.52 2 12 2zm1.01 12.44l-2.55-2.72-4.98 2.72 5.48-5.82 2.61 2.72 4.92-2.72-5.48 5.82z" />
    </svg>
  );
}

function InstagramIcon() {
  return (
    <svg
      {...ICON_PROPS}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.2" cy="6.8" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function WhatsAppIcon() {
  return (
    <svg {...ICON_PROPS} fill="currentColor">
      <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.86 9.86 0 004.79 1.22h.01c5.46 0 9.9-4.45 9.9-9.91C21.95 6.45 17.5 2 12.04 2zm5.8 14.06c-.25.69-1.44 1.32-1.99 1.4-.53.08-1.2.11-1.94-.12a17.6 17.6 0 01-1.75-.65c-3.08-1.33-5.09-4.43-5.25-4.64-.15-.2-1.25-1.66-1.25-3.17s.79-2.25 1.07-2.56c.28-.31.61-.38.81-.38h.58c.19 0 .44-.07.69.53.25.6.85 2.08.93 2.23.08.15.13.33.02.53-.1.2-.16.33-.31.5-.15.18-.32.39-.46.53-.15.15-.31.32-.13.62.18.31.79 1.3 1.69 2.11 1.16 1.03 2.14 1.35 2.45 1.5.31.15.49.13.67-.08.18-.2.77-.9.98-1.21.2-.31.41-.26.69-.15.28.1 1.76.83 2.06.98.31.15.51.23.59.36.08.13.08.74-.17 1.44z" />
    </svg>
  );
}

function YouTubeIcon() {
  return (
    <svg {...ICON_PROPS} fill="currentColor">
      <path d="M21.58 7.19a2.5 2.5 0 00-1.76-1.77C18.25 5 12 5 12 5s-6.25 0-7.82.42a2.5 2.5 0 00-1.76 1.77C2 8.77 2 12 2 12s0 3.23.42 4.81a2.5 2.5 0 001.76 1.77C5.75 19 12 19 12 19s6.25 0 7.82-.42a2.5 2.5 0 001.76-1.77C22 15.23 22 12 22 12s0-3.23-.42-4.81zM10 15.02V8.98L15.2 12 10 15.02z" />
    </svg>
  );
}

function ThreadsIcon() {
  return (
    <svg {...ICON_PROPS} fill="currentColor">
      <path d="M16.4 11.28c-.09-.04-.19-.09-.29-.13-.17-3.13-1.88-4.92-4.75-4.94h-.04c-1.72 0-3.15.73-4.03 2.07l1.58 1.08c.66-1 1.69-1.21 2.45-1.21h.03c.95.01 1.66.28 2.12.82.33.39.55.92.67 1.6a12.1 12.1 0 00-2.72-.13c-2.74.16-4.5 1.76-4.38 3.98.06 1.13.62 2.1 1.58 2.73.81.54 1.86.8 2.95.74 1.44-.08 2.57-.63 3.36-1.63.6-.76.98-1.74 1.15-2.98.7.42 1.21.98 1.5 1.65.48 1.14.51 3.01-1.01 4.53-1.34 1.33-2.94 1.91-5.37 1.93-2.69-.02-4.73-.88-6.05-2.56C4.6 17.24 4.96 14.5 4.96 12s-.36-5.24 1.19-7.17C7.47 3.15 9.51 2.29 12.2 2.27c2.71.02 4.79.89 6.17 2.58.68.83 1.19 1.88 1.53 3.1l1.85-.49c-.41-1.5-1.06-2.8-1.94-3.87C18.05 1.4 15.48.29 12.21.27h-.01C8.94.29 6.4 1.4 4.66 3.6 3.11 5.55 2.31 8.27 2.28 11.99v.02c.03 3.72.83 6.44 2.38 8.39 1.74 2.2 4.28 3.31 7.54 3.33h.01c2.9-.02 4.94-.78 6.63-2.46 2.21-2.2 2.14-4.96 1.41-6.66-.52-1.22-1.52-2.21-2.85-2.9-.33-.19-.68-.35-1-.43zm-4.5 4.72c-1.21.07-2.46-.47-2.52-1.61-.05-.85.6-1.79 2.6-1.9.23-.01.45-.02.67-.02.72 0 1.4.07 2.01.2-.23 2.85-1.57 3.28-2.76 3.34z" />
    </svg>
  );
}

interface SocialEntry {
  key: string;
  name: string;
  sub: string;
  icon: ReactNode;
  href: string;
}

/**
 * Two-up grid of platform links. Only platforms with a configured URL render,
 * so the grid never shows a dead button.
 */
export function SocialLinks({ settings }: SocialLinksProps) {
  const handleFallback = (handle: string) =>
    handle.trim() === '' ? 'Follow us' : handle.trim();

  const whatsapp = whatsAppUrl(settings.expert_whatsapp_url);

  const entries: SocialEntry[] = [];

  if (settings.expert_facebook_url.trim() !== '') {
    entries.push({
      key: 'facebook',
      name: 'Facebook',
      sub: "Naeem's Page",
      icon: <FacebookIcon />,
      href: settings.expert_facebook_url.trim(),
    });
  }
  if (settings.messenger_link.trim() !== '') {
    entries.push({
      key: 'messenger',
      name: 'Messenger',
      sub: 'Chat directly',
      icon: <MessengerIcon />,
      href: settings.messenger_link.trim(),
    });
  }
  if (settings.expert_instagram_url.trim() !== '') {
    entries.push({
      key: 'instagram',
      name: 'Instagram',
      sub: handleFallback(settings.expert_instagram_handle),
      icon: <InstagramIcon />,
      href: settings.expert_instagram_url.trim(),
    });
  }
  if (whatsapp !== null) {
    entries.push({
      key: 'whatsapp',
      name: 'WhatsApp',
      sub: 'Quick message',
      icon: <WhatsAppIcon />,
      href: whatsapp,
    });
  }
  if (settings.expert_youtube_url.trim() !== '') {
    entries.push({
      key: 'youtube',
      name: 'YouTube',
      sub: 'Watch reviews',
      icon: <YouTubeIcon />,
      href: settings.expert_youtube_url.trim(),
    });
  }
  if (settings.expert_threads_url.trim() !== '') {
    entries.push({
      key: 'threads',
      name: 'Threads',
      sub: handleFallback(settings.expert_threads_handle),
      icon: <ThreadsIcon />,
      href: settings.expert_threads_url.trim(),
    });
  }

  if (entries.length === 0) return null;

  return (
    <section className="exp-section">
      <h2 className="exp-label">Connect</h2>
      <div className="exp-socials">
        {entries.map((entry) => (
          <button
            key={entry.key}
            type="button"
            className="exp-social"
            onClick={() => openExternal(entry.href)}
          >
            <span className="exp-social__icon">{entry.icon}</span>
            <span className="exp-social__text">
              <span className="exp-social__name">{entry.name}</span>
              <span className="exp-social__sub">{entry.sub}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
