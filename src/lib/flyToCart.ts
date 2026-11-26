// Batch 70: a small copy of the product photo flies from the tapped button
// into the floating cart bubble on an arc, then the badge pops. Transform and
// opacity only (Web Animations API, composited). Skipped with reduced motion
// or when the bubble is not on screen.
export function flyToCart(from: Element, imageUrl: string | null): void {
  if (typeof window === 'undefined') return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    window.dispatchEvent(new CustomEvent('naeems:cart-bump'));
    return;
  }
  const bubble = document.querySelector('[data-testid="glass-cart"]');
  if (!bubble) return;
  const a = from.getBoundingClientRect();
  const b = bubble.getBoundingClientRect();
  const size = 44;
  const fly = document.createElement('div');
  fly.className = 'b70-fly';
  fly.setAttribute('aria-hidden', 'true');
  if (imageUrl) {
    const img = document.createElement('img');
    img.src = imageUrl;
    img.alt = '';
    img.decoding = 'async';
    fly.appendChild(img);
  }
  const x0 = a.left + a.width / 2 - size / 2;
  const y0 = a.top + a.height / 2 - size / 2;
  const dx = b.left + b.width / 2 - size / 2 - x0;
  const dy = b.top + b.height / 2 - size / 2 - y0;
  fly.style.transform = `translate3d(${x0}px, ${y0}px, 0)`;
  document.body.appendChild(fly);
  const animation = fly.animate(
    [
      { transform: `translate3d(${x0}px, ${y0}px, 0) scale(1)`, opacity: 1 },
      { transform: `translate3d(${x0 + dx * 0.5}px, ${y0 + dy * 0.5 - 80}px, 0) scale(0.9)`, opacity: 1, offset: 0.5 },
      { transform: `translate3d(${x0 + dx}px, ${y0 + dy}px, 0) scale(0.35)`, opacity: 0.2 },
    ],
    { duration: 620, easing: 'cubic-bezier(.45,0,.3,1)' }
  );
  const done = () => {
    fly.remove();
    window.dispatchEvent(new CustomEvent('naeems:cart-bump'));
  };
  animation.onfinish = done;
  animation.oncancel = done;
}
