import { useLiveCampaigns } from '../../contexts/CampaignContext';
import { useProducts } from '../../contexts/ProductContext';
import { campaignHeadline } from '../../lib/campaigns';
import { CampaignCard } from './CampaignCard';

/** Batch 66: the live campaigns on Home (ending soonest first, at most 2);
 *  nothing when none is live. */
export function HomeCampaigns() {
  const campaigns = useLiveCampaigns();
  const { products, variantsFor } = useProducts();
  if (campaigns.length === 0) return null;
  return (
    <>
      {campaigns.slice(0, 2).map((c) => (
        <CampaignCard key={c.id} campaign={c} headline={campaignHeadline(c, products, variantsFor)} variant="home" />
      ))}
    </>
  );
}
