import { useEffect, useMemo, useState } from 'react';
import { useProducts, sortFeaturedFirst } from '../contexts/ProductContext';
import { useTheme } from '../contexts/ThemeContext';
import { useAuth } from '../contexts/AuthContext';
import { useAppNavigate } from '../hooks/useAppNavigate';
import { categoryPath } from '../lib/categoryFilter';
import { greetingFor } from '../lib/greeting';
import { initialsOf } from '../lib/format';
import { homeGreeting, isOn, parseComboCodes, parseConcerns, parseVideos } from '../lib/homeContent';
import { ThemeIcon } from '../components/shared/ThemeToggle';
import { SiteFooter } from '../components/shared/SiteFooter';
import { HeroBanner } from '../components/viewer/HeroBanner';
import { BrowseCircles } from '../components/viewer/BrowseCircles';
import { BrandRow } from '../components/viewer/BrandRow';
import { HomeCampaigns } from '../components/campaign/HomeCampaigns';
import { HomeTip } from '../components/home/HomeTip';
import { BestSellers } from '../components/home/BestSellers';
import { BestCombos, Concerns, ExpertCard, SectionHead, SkinTypes, Videos } from '../components/home/HomeSections';
import { EditModeToggle } from '../components/admin/EditModeToggle';
import type { Product } from '../types';

/** How many newest products stand in when nothing is featured. */
const NEWEST_COUNT = 10;

/** Featured products in the shop's featured order, else the newest 10. */
export function bestSellerList(active: Product[]): Product[] {
  const featured = sortFeaturedFirst(active).filter((p) => p.is_featured);
  if (featured.length > 0) return featured;
  return [...active].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, NEWEST_COUNT);
}

function Greeting() {
  const { profile, isCustomer } = useAuth();
  const [hour, setHour] = useState(() => new Date().getHours());
  const [photoFailed, setPhotoFailed] = useState(false);
  useEffect(() => {
    const id = window.setInterval(() => setHour(new Date().getHours()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  if (!isCustomer || !profile) return null;
  const name = (profile.full_name ?? '').trim();
  return (
    <div className="b71-hello" data-testid="home-greeting">
      {profile.photo_url && !photoFailed ? (
        <img className="b71-hello__av" src={profile.photo_url} alt="" onError={() => setPhotoFailed(true)} />
      ) : (
        <span className="b71-hello__av" aria-hidden="true">
          {initialsOf(name || 'Skincare fan')}
        </span>
      )}
      <div>
        <small>{homeGreeting(greetingFor(hour).text)}</small>
        {name !== '' && <b>{name}</b>}
      </div>
    </div>
  );
}

/**
 * Batch 71: the new Home (the product grid moved to /shop). Top to bottom:
 * wordmark and theme button, the greeting (signed-in customers), Naeem's
 * skin tip, the search pill, live campaigns, the banner, Browse, Shop by
 * brand, the optional skin type / concern rows, Best sellers, the optional
 * combos, videos, Talk with Naeem and the footer.
 */
export function HomePage() {
  const { theme, toggleTheme } = useTheme();
  const navigate = useAppNavigate();
  const { products, categories, settings } = useProducts();
  const activeProducts = useMemo(() => products.filter((p) => p.is_active), [products]);
  const bestSellers = useMemo(() => bestSellerList(activeProducts), [activeProducts]);
  const concerns = useMemo(() => parseConcerns(settings.home_concerns), [settings.home_concerns]);
  const comboCodes = useMemo(() => parseComboCodes(settings.home_combo_codes), [settings.home_combo_codes]);
  const videos = useMemo(() => parseVideos(settings.home_videos), [settings.home_videos]);

  const openCategory = (id: string | null) => {
    const slug = id === null ? null : categories.find((c) => c.id === id)?.slug ?? null;
    navigate(categoryPath(slug));
  };

  return (
    <div className="viewer-shell b71-home" data-testid="home-page">
      <header className="b71-top">
        <h1 className="b71-mark">NAEEM&apos;S</h1>
        <button
          type="button"
          className="b71-icon-btn"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          data-testid="home-theme"
        >
          <ThemeIcon theme={theme} />
        </button>
      </header>

      <Greeting />
      <HomeTip />

      <button type="button" className="b71-search" onClick={() => navigate('/search')} data-testid="home-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-4.35-4.35" />
        </svg>
        Search products, brands, concerns
      </button>

      <div className="b71-camps" data-testid="home-campaigns">
        <HomeCampaigns />
      </div>

      <div className="b71-banner" data-testid="home-banner">
        <HeroBanner slides={settings.banner_slides} onScrollToProducts={() => navigate('/shop')} />
      </div>

      <div className="b71-browse" data-testid="home-browse">
        <BrowseCircles categories={categories} products={activeProducts} selectedId={null} onSelect={openCategory} />
      </div>

      <BrandRow activeProducts={activeProducts} variant="home" />

      {isOn(settings.home_show_skin_types) && <SkinTypes />}
      {isOn(settings.home_show_concerns) && <Concerns concerns={concerns} />}

      {bestSellers.length > 0 && (
        <section aria-label="Best sellers" data-testid="home-best">
          <SectionHead title="Best sellers" link={{ label: 'See all', to: '/shop' }} />
          <BestSellers products={bestSellers} />
        </section>
      )}

      {isOn(settings.home_show_combos) && comboCodes.length > 0 && <BestCombos codes={comboCodes} />}

      <Videos videos={videos} channelUrl={settings.expert_youtube_url} />

      <ExpertCard settings={settings} />

      <SiteFooter />

      {/* Admin only (renders nothing for everyone else): edit the banner
          and the Browse circles in place. */}
      <EditModeToggle />
    </div>
  );
}
