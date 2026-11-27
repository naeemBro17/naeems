import type { MouseEvent } from 'react';
import { useAppNavigate } from '../../hooks/useAppNavigate';
import { productPath } from '../../lib/slugify';
import type { PickedItem } from '../../lib/routine';
import type { Product } from '../../types';
import { Card } from './BestSellers';
import { SectionHead } from './HomeSections';

/**
 * Batch 72: Home's "Picked for you" (approved mockup, screen 4), in Best
 * sellers' place for a customer who saved "My skin". The Best sellers
 * cards with a green word saying why; a plain sideways row (the browser's
 * own scrolling, no drift).
 */
export function PickedForYou({ picked, line }: { picked: PickedItem[]; line: string }) {
  const navigate = useAppNavigate();
  const open = (e: MouseEvent<HTMLAnchorElement>, product: Product) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(productPath(product));
  };
  return (
    <section aria-label="Picked for you" data-testid="home-picked">
      <SectionHead title="Picked for you" />
      {line !== '' && <p className="b72-pf-line">{line}</p>}
      <div className="b71-hscroll">
        {picked.map(({ product, why }) => (
          <Card key={product.id} product={product} hidden={false} onOpen={open} why={why} testId="picked-card" />
        ))}
      </div>
    </section>
  );
}
