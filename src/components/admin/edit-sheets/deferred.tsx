import { lazy, Suspense, useState, type ComponentType, type LazyExoticComponent } from 'react';
import { useAdminEdit } from '../../../contexts/AdminEditContext';
import type { BentoEditSheet as BentoSheet } from './BentoEditSheet';
import type { BannerEditSheet as BannerSheet } from './BannerEditSheet';
import type { BrowseEditSheet as BrowseSheet } from './BrowseEditSheet';
import type { ExpertEditSheet as ExpertSheet } from './ExpertEditSheet';

/* The admin's in-place edit sheets, used on shop pages (Home's banner,
   bento, browse circles and product grid; the expert page). Their code —
   forms, uploaders, editors — is only downloaded the first time an admin
   actually opens one (Batch 29 Part 7), so customers never load it. Each
   wrapper takes exactly the sheet's own props. Once opened, a sheet stays
   mounted so its close animation still plays. */

function deferred<P extends object>(
  Sheet: LazyExoticComponent<ComponentType<P>>,
  isActive: (props: P) => boolean
): (props: P) => JSX.Element | null {
  // A lazy component's own type hides P behind ref plumbing; it renders
  // exactly like the plain component it wraps.
  const Plain = Sheet as unknown as ComponentType<P>;
  return function DeferredSheet(props: P) {
    const active = isActive(props);
    const [used, setUsed] = useState(active);
    if (active && !used) setUsed(true);
    if (!used) return null;
    return (
      <Suspense fallback={null}>
        <Plain {...props} />
      </Suspense>
    );
  };
}

export const BannerEditSheet = deferred<Parameters<typeof BannerSheet>[0]>(
  lazy(() => import('./BannerEditSheet').then((m) => ({ default: m.BannerEditSheet }))),
  (p) => p.isOpen
);

export const BrowseEditSheet = deferred<Parameters<typeof BrowseSheet>[0]>(
  lazy(() => import('./BrowseEditSheet').then((m) => ({ default: m.BrowseEditSheet }))),
  (p) => p.isOpen
);

export const BentoEditSheet = deferred<Parameters<typeof BentoSheet>[0]>(
  lazy(() => import('./BentoEditSheet').then((m) => ({ default: m.BentoEditSheet }))),
  (p) => p.target !== null
);

export const ExpertEditSheet = deferred<Parameters<typeof ExpertSheet>[0]>(
  lazy(() => import('./ExpertEditSheet').then((m) => ({ default: m.ExpertEditSheet }))),
  (p) => p.section !== null
);

const LazyProductEditSheet = lazy(() =>
  import('./ProductEditSheet').then((m) => ({ default: m.ProductEditSheet }))
);

/** Home's product editor — opened from a card while editing. */
export function ProductEditSheet() {
  const { editingProduct } = useAdminEdit();
  const [used, setUsed] = useState(editingProduct !== null);
  if (editingProduct !== null && !used) setUsed(true);
  if (!used) return null;
  return (
    <Suspense fallback={null}>
      <LazyProductEditSheet />
    </Suspense>
  );
}
