import { useEffect, useRef, useState } from 'react';

interface Stat {
  value: string;
  label: string;
}

interface StatsRowProps {
  stats: Stat[];
}

/** Wait before the count-up starts, so the page has settled. */
const START_DELAY_MS = 400;
const COUNT_DURATION_MS = 1400;

/** Split "500+" into 500 and "+", or return null when there is no leading number. */
function splitStatValue(value: string): { target: number; suffix: string } | null {
  const match = /^(\d+(?:\.\d+)?)(.*)$/.exec(value.trim());
  if (!match) return null;
  return { target: Number(match[1]), suffix: match[2] };
}

function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** Whole numbers count as integers; a decimal target keeps one decimal place. */
function formatCount(current: number, target: number): string {
  return Number.isInteger(target) ? String(Math.round(current)) : current.toFixed(1);
}

function AnimatedStat({ value, label }: Stat) {
  const parts = splitStatValue(value);
  const [display, setDisplay] = useState(() =>
    parts ? `0${parts.suffix}` : value
  );
  const frameRef = useRef<number>();
  const timerRef = useRef<number>();

  useEffect(() => {
    // Nothing numeric to animate — render the value as written.
    if (!parts) {
      setDisplay(value);
      return;
    }

    const { target, suffix } = parts;
    setDisplay(`0${suffix}`);

    const step = (start: number) => {
      const tick = (now: number) => {
        const progress = Math.min(1, (now - start) / COUNT_DURATION_MS);
        setDisplay(`${formatCount(target * easeOut(progress), target)}${suffix}`);
        if (progress < 1) frameRef.current = requestAnimationFrame(tick);
      };
      frameRef.current = requestAnimationFrame(tick);
    };

    timerRef.current = window.setTimeout(
      () => step(performance.now()),
      START_DELAY_MS
    );

    return () => {
      window.clearTimeout(timerRef.current);
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    };
    // parts is derived from value; re-running on the raw string is what matters.
  }, [value]);

  return (
    <div className="exp-stat">
      <span className="exp-stat__value">{display}</span>
      <span className="exp-stat__label">{label}</span>
    </div>
  );
}

/** Three-up stat strip. Renders nothing unless at least one stat has a value. */
export function StatsRow({ stats }: StatsRowProps) {
  const filled = stats.filter((s) => s.value.trim() !== '' || s.label.trim() !== '');
  if (filled.length === 0) return null;

  return (
    <div className="exp-stats">
      {filled.map((stat, index) => (
        <AnimatedStat key={`${stat.label}-${index}`} {...stat} />
      ))}
    </div>
  );
}
