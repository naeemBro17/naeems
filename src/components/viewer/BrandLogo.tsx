import { useEffect, useState, type CSSProperties, type RefObject } from 'react';
import { brandLogoFor } from '../../lib/brands';
import { loadLogo, peekLogo, type DisplayLogo } from '../../lib/brandLogoCache';
import type { Brand } from '../../types';

/**
 * True once the element has come within ~one screen of view (and stays
 * true) — so a long row of brand cards only prepares the logos someone is
 * about to see, like the plain lazy images did before.
 */
export function useNearScreen(ref: RefObject<Element>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (near || !el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: '300px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, near]);
  return near;
}

/** The cleaned version of one logo URL (lib/brandLogoCache.ts); undefined
 *  while it's being read (or not started yet), null when there is no URL. */
function useCleanLogo(url: string | null, enabled: boolean): DisplayLogo | null | undefined {
  const [logo, setLogo] = useState<DisplayLogo | null | undefined>(() => (url ? peekLogo(url) : null));

  useEffect(() => {
    if (!url) {
      setLogo(null);
      return;
    }
    const known = peekLogo(url);
    if (known) {
      setLogo(known);
      return;
    }
    setLogo(undefined);
    if (!enabled) return;
    let current = true;
    void loadLogo(url).then((loaded) => {
      if (current) setLogo(loaded);
    });
    return () => {
      current = false;
    };
  }, [url, enabled]);

  return logo;
}

export interface BrandLogoView {
  /** null = no logo: show the brand name as text. */
  src: string | null;
  /** The card behind it: white, dark, or the logo's own brand colour. */
  tone: 'light' | 'dark' | 'colour';
  /** The card colour when tone is 'colour', else null. */
  background: string | null;
  /** False while the logo is still being prepared (show nothing yet — the
   *  card keeps its size, so nothing moves). */
  ready: boolean;
}

/**
 * Which logo, on which card (Batch 29 Part 5) — one rule for Home's "Shop by
 * Brand", /brands, the brand page and the admin preview:
 *  - A logo with a solid brand-colour background: the whole card takes that
 *    colour and the logo sits on it, the same in light and dark mode (the
 *    dark-mode logo is not used).
 *  - Otherwise the Batch 26 rule (lib/brands.ts brandLogoFor): light mode =
 *    normal logo on white; dark mode = white logo on dark, or the normal
 *    logo on a light card when there is no white one.
 * Both logos are cleaned the same way (see-through backdrop, trimmed), so
 * switching light/dark changes colours only, never the logo's size.
 */
export function useBrandLogo(
  brand: Pick<Brand, 'logo_url' | 'logo_dark_url'>,
  theme: 'light' | 'dark',
  /** False until the card is near the screen (see useNearScreen). */
  enabled = true
): BrandLogoView {
  const slot = brandLogoFor(brand, theme);
  const normal = useCleanLogo(brand.logo_url, enabled);
  const usesDark = slot.src !== null && slot.src === brand.logo_dark_url && slot.src !== brand.logo_url;
  const dark = useCleanLogo(usesDark ? brand.logo_dark_url : null, enabled);

  if (normal?.kind === 'colour') {
    return { src: normal.src, tone: 'colour', background: normal.background, ready: true };
  }
  if (slot.src === null) return { src: null, tone: slot.tone, background: null, ready: true };

  // The normal logo must be read first even in dark mode: if it has a brand
  // colour, that colour wins over the dark-mode logo.
  const normalKnown = brand.logo_url === null || normal !== undefined;
  if (!usesDark) {
    return { src: normal?.src ?? slot.src, tone: slot.tone, background: null, ready: normalKnown };
  }
  if (dark?.kind === 'colour') {
    return { src: dark.src, tone: 'colour', background: dark.background, ready: normalKnown };
  }
  return { src: dark?.src ?? slot.src, tone: 'dark', background: null, ready: normalKnown && dark !== undefined };
}

/** Inline style for the card behind a colour-background logo. */
export function brandCardStyle(view: BrandLogoView): CSSProperties | undefined {
  return view.background ? { background: view.background, borderColor: view.background } : undefined;
}

interface BrandLogoImageProps {
  view: BrandLogoView;
  className: string;
  width: number;
  height: number;
  alt?: string;
  /** Native lazy loading, for cards in long rows/grids. */
  lazy?: boolean;
  onError: () => void;
}

/** The logo picture itself — fitted into the same fixed box in every mode.
 *  It simply appears once ready (no fade: nothing may animate on its own
 *  after a page has settled), and its box is held meanwhile. */
export function BrandLogoImage({ view, className, width, height, alt = '', lazy = false, onError }: BrandLogoImageProps) {
  if (!view.ready || view.src === null) {
    return <span className={`${className} brand-logo--waiting`} aria-hidden="true" />;
  }
  return (
    <img
      className={className}
      src={view.src}
      alt={alt}
      width={width}
      height={height}
      loading={lazy ? 'lazy' : undefined}
      decoding="async"
      onError={onError}
      data-logo-tone={view.tone}
    />
  );
}
