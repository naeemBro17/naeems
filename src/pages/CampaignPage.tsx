import { useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useProducts } from '../contexts/ProductContext';
import { useLiveCampaigns } from '../contexts/CampaignContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { navigateBack } from '../lib/viewTransition';
import { campaignHeadline, campaignProductIds, campaignsLoaded } from '../lib/campaigns';
import { CampaignCard } from '../components/campaign/CampaignCard';
import { ProductGrid } from '../components/viewer/ProductGrid';
import { BackButton } from '../components/shared/BackButton';
import type { Product } from '../types';

function InfoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 7.5h.01" />
    </svg>
  );
}

/**
 * /campaign/<slug> (Batch 66): the campaign's hero (name, headline,
 * countdown) with a back button inside it, the "sale prices are already
 * applied" note, and its products in Naeem's order as the normal shop
 * cards. Ended, switched off or unknown: "This sale has ended" with a way
 * back to the shop (no dead end).
 */
export function CampaignPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const campaigns = useLiveCampaigns();
  const { products, variantsFor, isLoading } = useProducts();
  const campaign = campaigns.find((c) => c.slug === slug) ?? null;
  useDocumentTitle(campaign ? `${campaign.name} | NAEEM'S` : "Sale | NAEEM'S");

  const shown = useMemo((): Product[] => {
    if (!campaign) return [];
    const byId = new Map(products.filter((p) => p.is_active).map((p) => [p.id, p]));
    return campaignProductIds(campaign).flatMap((id) => {
      const p = byId.get(id);
      return p ? [p] : [];
    });
  }, [campaign, products]);

  if (!campaign) {
    if (!campaignsLoaded()) {
      return <div className="cmp-page" aria-label="Loading sale" />;
    }
    return (
      <div className="viewer-shell detail-shell cmp-page">
        <header className="detail-header">
          <BackButton />
        </header>
        <main className="cmp-ended" data-testid="campaign-ended">
          <span className="cmp-ended__icon" aria-hidden="true">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
          </span>
          <h1>This sale has ended</h1>
          <p>Prices are back to normal. Everything is still in the shop.</p>
          <Link to="/" className="button button--primary">
            Browse all products
          </Link>
        </main>
      </div>
    );
  }

  const back = (
    <button type="button" className="cmp-back" onClick={() => navigateBack(navigate)} aria-label="Go back">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M15 6l-6 6 6 6" />
      </svg>
    </button>
  );

  return (
    <div className="viewer-shell cmp-page" data-testid="campaign-page">
      <CampaignCard campaign={campaign} headline={campaignHeadline(campaign, products, variantsFor)} variant="hero" heroBack={back} />
      <p className="cmp-note">
        <InfoIcon />
        Sale prices are already applied. Coupons can&apos;t be used on these items.
      </p>
      <main className="cmp-page__grid">
        <ProductGrid
          products={shown}
          isLoading={isLoading && shown.length === 0}
          searchQuery=""
          selectedCategoryId={null}
          onClearSearch={() => {}}
          activeFilterCount={0}
          onClearFilters={() => {}}
          campaignTag={campaign.id}
        />
      </main>
    </div>
  );
}
