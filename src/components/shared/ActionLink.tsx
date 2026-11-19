import type { AnchorHTMLAttributes, MouseEvent } from 'react';
import { isNewTabClick } from '../../lib/adminPages';

interface ActionLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'> {
  /** The page's own address (what "Open in new tab" opens). */
  to: string;
  /** What a normal tap does — the same in-app navigation as before. */
  onOpen: () => void;
  /** Runs first on every click (e.g. stopPropagation inside a row). */
  onBeforeOpen?: (e: MouseEvent<HTMLAnchorElement>) => void;
}

/**
 * Batch 52 Part 2: a real link (<a href>) for anything that takes you to
 * another page, so a long-press on a phone and right-click / Ctrl-click /
 * middle-click on a computer offer "Open in new tab". A normal tap is
 * handled exactly as before by `onOpen` (no full page reload, the same
 * unsaved-changes guard, scroll memory and transitions).
 */
export function ActionLink({ to, onOpen, onBeforeOpen, className, ...rest }: ActionLinkProps) {
  return (
    <a
      {...rest}
      href={to}
      className={`link-as-button${className ? ` ${className}` : ''}`}
      onClick={(e) => {
        onBeforeOpen?.(e);
        if (isNewTabClick(e)) return;
        e.preventDefault();
        onOpen();
      }}
    />
  );
}
