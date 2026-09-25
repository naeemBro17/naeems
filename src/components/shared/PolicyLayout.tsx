import type { ReactNode } from 'react';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { BackButton } from './BackButton';

interface PolicyLayoutProps {
  title: string;
  children: ReactNode;
}

/** Shared shell for the five policy/trust pages (Batch 19 Part 4) — same
 *  detail-header/detail-main pattern every other full-page screen already
 *  uses, so these get the site's fonts/spacing/dark-mode for free. Content
 *  itself lives in `.policy-page` (see app.css) for readable line length
 *  and heading/list/table styling. */
export function PolicyLayout({ title, children }: PolicyLayoutProps) {
  useDocumentTitle(`${title} — Naeem's`);

  return (
    <div className="viewer-shell detail-shell">
      <header className="detail-header">
        <BackButton />
        <h1 className="detail-header__title">{title}</h1>
        <div className="detail-header__actions" />
      </header>
      <main className="detail-main">
        <article className="policy-page">{children}</article>
      </main>
    </div>
  );
}
