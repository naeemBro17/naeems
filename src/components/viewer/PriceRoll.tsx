import { useEffect, useRef, useState } from 'react';

/**
 * Fix 72.1: the product page's price. When the text changes (another size),
 * the old number slides up and fades while the new one rises in; transform
 * and opacity only; instant with reduced motion (CSS).
 */
export function PriceRoll({ text, className }: { text: string; className?: string }) {
  const [shown, setShown] = useState<{ current: string; leaving: string | null; key: number }>({
    current: text,
    leaving: null,
    key: 0,
  });
  const timer = useRef<number | null>(null);

  useEffect(() => {
    setShown((s) => (s.current === text ? s : { current: text, leaving: s.current, key: s.key + 1 }));
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setShown((s) => ({ ...s, leaving: null })), 340);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [text]);

  return (
    <span className={`f721-roll${className ? ` ${className}` : ''}`} data-testid="pdp-price">
      {shown.leaving !== null && (
        <span key={`out-${shown.key}`} className="f721-roll__out" aria-hidden="true">
          {shown.leaving}
        </span>
      )}
      <span key={`in-${shown.key}`} className={shown.key > 0 ? 'f721-roll__in' : undefined}>
        {shown.current}
      </span>
    </span>
  );
}
