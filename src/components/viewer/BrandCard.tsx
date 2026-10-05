import { useEffect, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { useTheme } from '../../contexts/ThemeContext';
import { useAppNavigate } from '../../hooks/useAppNavigate';
import { brandPath } from '../../lib/brands';
import { preloadBrandVideo } from '../../lib/brandVideo';
import { BrandLogoImage, brandCardStyle, useBrandLogo, useNearScreen } from './BrandLogo';
import type { Brand } from '../../types';

/** The logo box's fixed size, so a lazy logo never moves anything. */
const LOGO_WIDTH = 160;
const LOGO_HEIGHT = 80;

/**
 * Home's brand row and /brands (Batch 29 Part 6): once the cards are on
 * screen and the page has gone quiet, start downloading the banner videos
 * of the first three brands, so their pages open with the video ready.
 * (preloadBrandVideo skips data saver and slow connections.)
 */
export function usePreloadFirstBrandVideos(brands: Brand[], containerRef: RefObject<Element>): void {
  const near = useNearScreen(containerRef);
  const firstVideos = brands
    .slice(0, 3)
    .map((b) => b.banner_video_url)
    .filter((url): url is string => url !== null)
    .join(' ');

  useEffect(() => {
    if (!near || firstVideos === '') return;
    const run = () => firstVideos.split(' ').forEach((url) => preloadBrandVideo(url));
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(run, { timeout: 4000 });
      return () => window.cancelIdleCallback(id);
    }
    const timer = window.setTimeout(run, 2000);
    return () => window.clearTimeout(timer);
  }, [near, firstVideos]);
}

/**
 * One wide (2:1) rounded brand card: only the logo, centred with padding —
 * or the brand name as text while there is no logo. Light mode: white card,
 * normal logo. Dark mode: dark card with the white logo, or a light card
 * with the normal logo when there is no white one. A logo with a brand-
 * colour background fills the whole card with that colour in both modes
 * (Batch 29 — see BrandLogo.tsx). Used by Home's "Shop by Brand" row and
 * the /brands page.
 */
export function BrandCard({ brand }: { brand: Brand }) {
  const { theme } = useTheme();
  const navigate = useAppNavigate();
  const cardRef = useRef<HTMLAnchorElement>(null);
  const near = useNearScreen(cardRef);
  const logo = useBrandLogo(brand, theme, near);
  const [failed, setFailed] = useState(false);
  const path = brandPath(brand);

  const open = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(path);
  };

  const showLogo = logo.src !== null && !failed;

  return (
    <a
      ref={cardRef}
      href={path}
      onClick={open}
      // Touching the card starts its banner video downloading at once.
      onPointerDown={() => preloadBrandVideo(brand.banner_video_url, 'high')}
      className={`brand-card brand-card--${logo.tone}`}
      style={brandCardStyle(logo)}
      aria-label={brand.name}
      data-testid="brand-card"
      data-brand-slug={brand.slug}
    >
      {showLogo ? (
        <BrandLogoImage
          view={logo}
          className="brand-card__logo"
          width={LOGO_WIDTH}
          height={LOGO_HEIGHT}
          lazy
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="brand-card__name">{brand.name}</span>
      )}
    </a>
  );
}
