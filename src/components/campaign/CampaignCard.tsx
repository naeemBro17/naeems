import { Link } from 'react-router-dom';
import { useMemo, type ReactNode } from 'react';
import { two, useCountdown, type Left } from './useCountdown';
import type { CampaignStyle } from '../../lib/campaigns';

/** What the card needs about a campaign (a live one, or the admin's
 *  preview of one being edited). */
export interface CampaignCardData {
  id: string;
  name: string;
  slug: string;
  style: CampaignStyle;
  ends_at: string;
}

function Sparkles({ seed, count }: { seed: string; count: number }) {
  const items = useMemo(() => {
    let s = 0;
    for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) % 2147483647;
    s = s || 7;
    const r = () => {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646;
    };
    return Array.from({ length: count }, (_, i) => {
      const star = r() < 0.55;
      return { i, star, left: r() * 96, top: r() * 92, size: star ? 8 + r() * 14 : 2 + r() * 3, dur: 1.6 + r() * 2.2, delay: -(r() * 4) };
    });
  }, [seed, count]);
  return (
    <span className="cmp-sparks" aria-hidden="true">
      {items.map((p) => (
        <span
          key={p.i}
          className={p.star ? 'cmp-sp' : 'cmp-dot'}
          style={{ left: `${p.left}%`, top: `${p.top}%`, width: p.size, height: p.size, animationDuration: `${p.dur}s`, animationDelay: `${p.delay}s` }}
        >
          {p.star && (
            <svg viewBox="0 0 24 24">
              <path d="M12 0C12.9 7.6 16.4 11.1 24 12C16.4 12.9 12.9 16.4 12 24C11.1 16.4 7.6 12.9 0 12C7.6 11.1 11.1 7.6 12 0Z" fill="#fff4d2" />
            </svg>
          )}
        </span>
      ))}
    </span>
  );
}

function CardBody({
  campaign,
  headline,
  variant,
  left,
  before,
}: {
  campaign: CampaignCardData;
  headline: string;
  variant: 'home' | 'hero';
  left: Left;
  before?: ReactNode;
}) {
  const glitter = campaign.style === 'glitter';
  const eyebrow = glitter ? 'Mega sale · Limited time' : 'Limited time';
  const boxes: [string, string][] = [
    [two(left.d), 'DAYS'],
    [two(left.h), 'HRS'],
    [two(left.m), 'MIN'],
    [two(left.s), 'SEC'],
  ];
  const timer = (
    <span className="cmp-timer" role="timer" aria-label={`Ends in ${left.d} days ${left.h} hours ${left.m} minutes`}>
      {boxes.map(([v, l]) => (
        <span key={l} className="cmp-tb" data-testid={`cmp-${l.toLowerCase()}`}>
          <b>{v}</b>
          <small>{l}</small>
        </span>
      ))}
    </span>
  );
  return (
    <>
      {glitter && <Sparkles seed={campaign.id} count={variant === 'home' ? 22 : 34} />}
      {glitter && <span className="cmp-shine" aria-hidden="true" />}
      {before}
      <span className="cmp-in">
        <span className="cmp-eyb">{eyebrow}</span>
        <span className={glitter ? 'cmp-name cmp-name--gold' : 'cmp-name'}>{campaign.name}</span>
        {headline && <span className="cmp-sub">{headline}</span>}
        {variant === 'hero' ? (
          <span className="cmp-ends">
            <span className="cmp-ends__label">Ends in</span>
            {timer}
          </span>
        ) : (
          <span className="cmp-row">
            {timer}
            <span className="cmp-shop">
              Shop now
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
                <path d="M9 6l6 6-6 6" />
              </svg>
            </span>
          </span>
        )}
      </span>
    </>
  );
}

/**
 * Batch 66: the campaign "poster" — the Home card (one tap target, opens
 * the campaign page) and the campaign page's hero share it. Dark in light
 * and dark mode on purpose. Seconds tick; screen readers get role="timer"
 * without being read every second (no aria-live).
 */
export function CampaignCard({
  campaign,
  headline,
  variant,
  heroBack,
}: {
  campaign: CampaignCardData;
  headline: string;
  variant: 'home' | 'hero';
  /** The hero's round back button (top-left, inside the hero). */
  heroBack?: ReactNode;
}) {
  const left = useCountdown(campaign.ends_at);
  if (left.done) return null;
  const cls = `cmp-card cmp-card--${variant} cmp-card--${campaign.style}`;
  return variant === 'home' ? (
    <Link to={`/campaign/${campaign.slug}`} className={cls} data-testid="campaign-card">
      <CardBody campaign={campaign} headline={headline} variant="home" left={left} />
    </Link>
  ) : (
    <section className={cls} data-testid="campaign-hero" aria-label={campaign.name}>
      <CardBody campaign={campaign} headline={headline} variant="hero" left={left} before={heroBack} />
    </section>
  );
}

/** The admin's preview: the real card with the countdown frozen at the
 *  chosen dates (no ticking, no link). */
export function CampaignCardPreview({ campaign, headline, left }: { campaign: CampaignCardData; headline: string; left: Left }) {
  return (
    <div className={`cmp-card cmp-card--home cmp-card--${campaign.style} cmp-card--preview`} data-testid="campaign-preview" aria-hidden="true">
      <CardBody campaign={campaign} headline={headline} variant="home" left={left} />
    </div>
  );
}
