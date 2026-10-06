import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTheme } from '../../../contexts/ThemeContext';
import { ThemeIcon } from '../../shared/ThemeToggle';
import { AdminIcon, type AdminUiIconName } from './AdminIcon';

/* Shared pieces every admin page is built from (Batch 25). Styles live in
   src/styles/admin.css under .adm, so nothing here can reach the shop. */

export function AdminThemeButton({ variant = 'filled' }: { variant?: 'filled' | 'ghost' }) {
  const { theme, toggleTheme } = useTheme();
  return (
    <button
      type="button"
      className={`adm-icon-btn adm-icon-btn--${variant}`}
      onClick={toggleTheme}
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      <ThemeIcon theme={theme} />
    </button>
  );
}

export interface MenuItem {
  label: string;
  onSelect: () => void;
  icon?: AdminUiIconName;
  danger?: boolean;
  disabled?: boolean;
}

interface PageHeaderProps {
  title: string;
  /** Small orange line above the title (Home: "NAEEM'S SUPER ADMIN"). */
  eyebrow?: string;
  /** Small grey line between eyebrow and title (Home: "Good morning,"). */
  kicker?: string;
  /** Small grey line under the title (Home: today's date). */
  subtitle?: string;
  /** Shows a back arrow before the title (sub-pages such as Settings → Orders). */
  onBack?: () => void;
  backLabel?: string;
  /** The page's main action — the one orange button. */
  primary?: ReactNode;
  /** Secondary page actions: ghost buttons on a computer, a ⋮ menu on a phone. */
  menu?: MenuItem[];
}

/**
 * The same page header everywhere: big title on the left; on the right the
 * theme switch, "View site" (computer), secondary actions and the one
 * orange main action.
 */
export function AdminPageHeader({ title, eyebrow, kicker, subtitle, onBack, backLabel, primary, menu }: PageHeaderProps) {
  const items = (menu ?? []).filter((m) => !m.disabled);
  return (
    <header className="adm-page-header">
      <div className="adm-page-header__titles">
        {eyebrow && <p className="adm-page-header__eyebrow">{eyebrow}</p>}
        {kicker && <p className="adm-page-header__kicker">{kicker}</p>}
        <div className="adm-page-header__title-row">
          {onBack && (
            <button type="button" className="adm-icon-btn adm-icon-btn--plain" onClick={onBack} aria-label={backLabel ?? 'Back'}>
              <AdminIcon name="chevron-left" />
            </button>
          )}
          <h1 className="adm-page-header__title">{title}</h1>
        </div>
        {subtitle && <p className="adm-page-header__subtitle">{subtitle}</p>}
      </div>
      <div className="adm-page-header__actions">
        <span className="adm-only-desktop">
          <AdminThemeButton variant="ghost" />
        </span>
        <span className="adm-only-mobile">
          <AdminThemeButton />
        </span>
        <Link to="/" target="_blank" rel="noopener" className="adm-btn adm-btn--ghost adm-only-desktop">
          View site <AdminIcon name="external" className="adm-icon--sm" />
        </Link>
        {items.length > 0 && (
          <>
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                className={`adm-btn adm-btn--ghost adm-only-desktop${item.danger ? ' adm-btn--danger-text' : ''}`}
                onClick={item.onSelect}
              >
                {item.label}
              </button>
            ))}
            <span className="adm-only-mobile">
              <KebabMenu label={`More actions for ${title}`} items={items} />
            </span>
          </>
        )}
        {primary}
      </div>
    </header>
  );
}

/** The ⋮ button and its menu. Destructive items are red and always last. */
export function KebabMenu({ label, items, className }: { label: string; items: MenuItem[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number; up: boolean }>({ top: 0, right: 0, up: false });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const ordered = [...items.filter((i) => !i.danger), ...items.filter((i) => i.danger)];

  const place = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const up = rect.bottom + 48 * ordered.length + 16 > window.innerHeight;
    setPos({
      top: up ? rect.top : rect.bottom,
      right: Math.max(8, window.innerWidth - rect.right),
      up,
    });
  }, [ordered.length]);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onScroll = () => setOpen(false);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`adm-kebab${className ? ` ${className}` : ''}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <AdminIcon name="dots" />
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          className={`adm-menu${pos.up ? ' adm-menu--up' : ''}`}
          style={pos.up ? { bottom: window.innerHeight - pos.top + 4, right: pos.right } : { top: pos.top + 4, right: pos.right }}
          onClick={(e) => e.stopPropagation()}
        >
          {ordered.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={`adm-menu__item${item.danger ? ' adm-menu__item--danger' : ''}`}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.icon && <AdminIcon name={item.icon} />}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** Search field with a magnifier; an optional button on its right. */
export function AdminSearch({
  value,
  onChange,
  placeholder,
  label,
  trailing,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  trailing?: ReactNode;
}) {
  return (
    <div className="adm-search">
      <AdminIcon name="search" className="adm-search__icon" />
      <input
        type="search"
        className="adm-search__input"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
      />
      {trailing}
    </div>
  );
}

export interface Chip {
  id: string;
  label: string;
  count?: number;
}

/** Quick filter chips (one row, scrolls sideways on a phone). */
export function ChipRow({
  chips,
  active,
  onSelect,
  label,
}: {
  chips: Chip[];
  active: string;
  onSelect: (id: string) => void;
  label: string;
}) {
  return (
    <div className="adm-chips" role="group" aria-label={label}>
      {chips.map((chip) => (
        <button
          key={chip.id}
          type="button"
          className={`adm-chip${chip.id === active ? ' adm-chip--on' : ''}`}
          aria-pressed={chip.id === active}
          onClick={() => onSelect(chip.id)}
        >
          {chip.label}
          {chip.count !== undefined && <span className="adm-chip__count">{chip.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** A grouped rounded list (More page, Settings, Needs attention). */
export function ListGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="adm-group" aria-label={title}>
      {title && <h2 className="adm-group__title">{title}</h2>}
      <div className="adm-group__box">{children}</div>
    </section>
  );
}

export function ListRow({
  icon,
  label,
  count,
  pill,
  detail,
  onClick,
  href,
  danger,
}: {
  icon?: AdminUiIconName;
  label: ReactNode;
  /** Orange bold number before the label (Needs attention). */
  count?: number;
  /** Small outlined orange pill after the label ("Super Admin"). */
  pill?: string;
  /** Grey text on the right, before the arrow. */
  detail?: string;
  onClick?: () => void;
  href?: string;
  danger?: boolean;
}) {
  const content = (
    <>
      {icon && <AdminIcon name={icon} className="adm-row__icon" />}
      {count !== undefined && <b className="adm-row__count">{count}</b>}
      <span className="adm-row__label">{label}</span>
      {pill && <span className="adm-pill-lock">{pill}</span>}
      {detail && <span className="adm-row__detail">{detail}</span>}
      <AdminIcon name={href ? 'external' : 'chevron-right'} className="adm-row__chevron" />
    </>
  );
  const className = `adm-row${danger ? ' adm-row--danger' : ''}`;
  if (href) {
    return (
      <a className={className} href={href} target="_blank" rel="noopener">
        {content}
      </a>
    );
  }
  return (
    <button type="button" className={className} onClick={onClick}>
      {content}
    </button>
  );
}

export function EmptyState({ icon, title, hint, action }: { icon: AdminUiIconName; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="adm-empty">
      <span className="adm-empty__icon">
        <AdminIcon name={icon} />
      </span>
      <p className="adm-empty__title">{title}</p>
      {hint && <p className="adm-empty__hint">{hint}</p>}
      {action}
    </div>
  );
}

/** Grey placeholder rows while a list loads. */
export function SkeletonRows({ rows = 6, thumb = true }: { rows?: number; thumb?: boolean }) {
  return (
    <div className="adm-skeleton" aria-label="Loading" role="status">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="adm-skeleton__row">
          {thumb && <span className="adm-skeleton__thumb" />}
          <span className="adm-skeleton__lines">
            <span className="adm-skeleton__line" />
            <span className="adm-skeleton__line adm-skeleton__line--short" />
          </span>
        </div>
      ))}
    </div>
  );
}

/** Fixed bar at the bottom while several rows are selected. */
export function BulkBar({ count, children, onClear }: { count: number; children: ReactNode; onClear: () => void }) {
  return (
    <div className="adm-bulkbar" role="region" aria-label="Selected items">
      <span className="adm-bulkbar__count">{count} selected</span>
      <div className="adm-bulkbar__actions">{children}</div>
      <button type="button" className="adm-icon-btn adm-icon-btn--plain" onClick={onClear} aria-label="Clear selection">
        <AdminIcon name="close" />
      </button>
    </div>
  );
}

/** Green / red stock dot with its text. */
export function StockDot({ tone, children }: { tone: 'ok' | 'low'; children: ReactNode }) {
  return (
    <span className={`adm-stock adm-stock--${tone}`}>
      <span className="adm-stock__dot" aria-hidden="true" />
      {children}
    </span>
  );
}
