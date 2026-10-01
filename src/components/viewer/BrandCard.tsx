import { useState, type MouseEvent } from 'react';
import { useTheme } from '../../contexts/ThemeContext';
import { useAppNavigate } from '../../hooks/useAppNavigate';
import { brandLogoFor, brandPath } from '../../lib/brands';
import type { Brand } from '../../types';

/** The logo box's fixed size, so a lazy logo never moves anything. */
const LOGO_WIDTH = 160;
const LOGO_HEIGHT = 80;

/**
 * One wide (2:1) rounded brand card: only the logo, centred with padding —
 * or the brand name as text while there is no logo. Light mode: white card,
 * normal logo. Dark mode: dark card with the white logo, or a light card
 * with the normal logo when there is no white one (lib/brands.ts).
 * Used by Home's "Shop by Brand" row and the /brands page.
 */
export function BrandCard({ brand }: { brand: Brand }) {
  const { theme } = useTheme();
  const navigate = useAppNavigate();
  const logo = brandLogoFor(brand, theme);
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
      href={path}
      onClick={open}
      className={`brand-card brand-card--${logo.tone}`}
      aria-label={brand.name}
      data-testid="brand-card"
      data-brand-slug={brand.slug}
    >
      {showLogo ? (
        <img
          className="brand-card__logo"
          src={logo.src ?? undefined}
          alt=""
          width={LOGO_WIDTH}
          height={LOGO_HEIGHT}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="brand-card__name">{brand.name}</span>
      )}
    </a>
  );
}
