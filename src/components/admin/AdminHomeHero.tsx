import { memo, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AdminThemeButton } from './ui/AdminUi';
import { AdminIcon } from './ui/AdminIcon';
import { clockParts } from '../../lib/adminClock';

/**
 * Batch 51 Part 5: the iPhone-lock-screen clock — 12-hour hours:minutes
 * without AM/PM in glass digits, the seconds small beside the minutes.
 * Its own component: it ticks once a second without re-rendering the
 * dashboard, waits for the next whole second, and stops while the tab is
 * hidden. The digits are tabular, so nothing jumps.
 */
export const GlassClock = memo(function GlassClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let timer = 0;
    const tick = () => {
      setNow(new Date());
      timer = window.setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
    };
    const start = () => {
      window.clearTimeout(timer);
      if (document.visibilityState === 'hidden') return;
      tick();
    };
    start();
    document.addEventListener('visibilitychange', start);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', start);
    };
  }, []);

  const t = clockParts(now);
  return (
    <p className="adm-clock" role="timer" aria-label={`${t.hours}:${t.minutes}`} data-testid="admin-clock">
      <span className="adm-clock__hm" aria-hidden="true">
        {t.hours}
        <span className="adm-clock__colon">:</span>
        {t.minutes}
      </span>
      <span className="adm-clock__s" aria-hidden="true" data-testid="admin-clock-seconds">
        {t.seconds}
      </span>
    </p>
  );
});

interface AdminHomeHeroProps {
  /** "NAEEM'S SUPER ADMIN". */
  eyebrow: string;
  /** "Good evening, Naeem". */
  greeting: string;
  /** "Thursday, 19 November". */
  date: string;
}

/**
 * The hero card at the top of Admin → Home: greeting and date, and the
 * glass clock over soft light washes (brand orange at low opacity on one
 * side, neutral grey on the other — decoration, approved by Naeem).
 * Computer: greeting on the left, clock on the right. Phone: clock on top.
 */
export function AdminHomeHero({ eyebrow, greeting, date }: AdminHomeHeroProps) {
  return (
    <header className="adm-hero" data-testid="admin-hero">
      <span className="adm-hero__wash adm-hero__wash--warm" aria-hidden="true" />
      <span className="adm-hero__wash adm-hero__wash--cool" aria-hidden="true" />
      <div className="adm-hero__tools">
        <span className="adm-only-desktop">
          <AdminThemeButton variant="ghost" />
        </span>
        <span className="adm-only-mobile">
          <AdminThemeButton />
        </span>
        <Link to="/" target="_blank" rel="noopener" className="adm-btn adm-btn--ghost adm-only-desktop">
          View site <AdminIcon name="external" className="adm-icon--sm" />
        </Link>
      </div>
      <div className="adm-hero__clock">
        <GlassClock />
      </div>
      <div className="adm-hero__text">
        <p className="adm-page-header__eyebrow adm-hero__eyebrow">{eyebrow}</p>
        <h1 className="adm-hero__greeting adm-page-header__title">{greeting}</h1>
        <p className="adm-hero__date">{date}</p>
      </div>
    </header>
  );
}
