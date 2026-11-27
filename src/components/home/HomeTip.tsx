import { useMemo, useState } from 'react';
import { useProducts } from '../../contexts/ProductContext';
import { nextTip, parseTips, splitAccent, visitTip, type SkinTip } from '../../lib/homeContent';

/** The tip text with its orange part (shared with the admin preview). */
export function TipText({ tip }: { tip: Pick<SkinTip, 'text' | 'accent'> }) {
  const parts = splitAccent(tip.text, tip.accent);
  return (
    <span className="b71-tip__txt" data-testid="home-tip-text">
      {parts.before}
      {parts.accent !== '' && <em>{parts.accent}</em>}
      {parts.after}
    </span>
  );
}

export function tipLabel(tip: Pick<SkinTip, 'own'>): string {
  return tip.own ? "NAEEM'S RULE" : 'SKIN TIP';
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 5v6h-6" />
    </svg>
  );
}

/**
 * Batch 71 Part 4: one skin tip per visit (lib/homeContent.ts visitTip),
 * never the one this phone saw last. A tap shows another with a short fade
 * (none with reduced motion, see batch71.css).
 */
export function HomeTip() {
  const { settings, isLoading } = useProducts();
  const tips = useMemo(() => parseTips(settings.home_tips), [settings.home_tips]);
  const [tip, setTip] = useState<SkinTip | null>(null);
  const [swap, setSwap] = useState(0);
  // Picked only once the saved list is known (the shop's last copy shows at
  // once on a repeat visit), so a default tip never flashes first. The
  // space stays reserved meanwhile (min-height), so nothing moves.
  if (isLoading) return <div className="b71-tip" aria-hidden="true" data-testid="home-tip-wait" />;
  const shown = tip !== null && tips.some((t) => t.id === tip.id && t.active) ? tip : visitTip(tips);
  if (shown === null) return null;

  const showNext = () => {
    const next = nextTip(tips, shown.id);
    if (next) {
      setTip(next);
      setSwap((n) => n + 1);
    }
  };

  return (
    <button
      type="button"
      className={`b71-tip${swap > 0 ? ' b71-tip--swap' : ''}`}
      onClick={showNext}
      data-testid="home-tip"
      data-tip-id={shown.id}
    >
      <span className="b71-tip__lab" data-testid="home-tip-label">
        <i aria-hidden="true" />
        {tipLabel(shown)}
      </span>
      <span key={swap} style={{ display: 'block' }}>
        <TipText tip={shown} />
      </span>
      <span className="b71-tip__more">
        <RefreshIcon />
        Tap for another
      </span>
    </button>
  );
}
