import { memo, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AdminThemeButton } from './ui/AdminUi';
import { AdminIcon } from './ui/AdminIcon';
import { clockParts } from '../../lib/adminClock';

/**
 * Batch 53 Part 1: re-renders only its own part, once per `periodMs`, on
 * the whole second / minute; stops while the tab is hidden and catches up
 * when it comes back.
 */
function useTick(periodMs: number): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let timer = 0;
    const tick = () => {
      setNow(new Date());
      timer = window.setTimeout(tick, periodMs - (Date.now() % periodMs) + 5);
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
  }, [periodMs]);

  return now;
}

/** One glass number. `data-t` feeds the top highlight (::after) with the
 *  same digits, so the two can never differ. */
function GlassDigits({ value, className = '' }: { value: string; className?: string }) {
  return (
    <span className={`adm-clock__d ${className}`.trim()} data-t={value}>
      {value}
    </span>
  );
}

/** The seconds: the only part that changes every second. */
const ClockSeconds = memo(function ClockSeconds() {
  const t = clockParts(useTick(1000));
  return (
    <span className="adm-clock__s" data-testid="admin-clock-seconds">
      <GlassDigits value={t.seconds} />
    </span>
  );
});

/**
 * Batch 51 Part 5 / Batch 53 Part 1: the iPhone-lock-screen clock —
 * 12-hour hours:minutes without AM/PM in "liquid glass" digits (soft
 * see-through grey, a thin light edge, a bright top highlight, a soft
 * shadow under them), the seconds small at the bottom right of the
 * minutes. Hours and minutes re-render once a minute; the seconds are
 * their own component. Its size comes from the card's width (container
 * units), so the widest time always fits; the digits are tabular, so
 * nothing jumps. Nothing animates.
 */
export const GlassClock = memo(function GlassClock() {
  const t = clockParts(useTick(60_000));
  return (
    <p className="adm-clock" role="timer" aria-label={`${t.hours}:${t.minutes}`} data-testid="admin-clock">
      <span className="adm-clock__t" aria-hidden="true">
        <GlassDigits value={t.hours} />
        <span className="adm-clock__dots">
          <i />
          <i />
        </span>
        <GlassDigits value={t.minutes} />
        <ClockSeconds />
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
