import type { ReactNode } from 'react';
import { AdminIcon } from './ui/AdminIcon';
import { AdminThemeButton } from './ui/AdminUi';
import { useLeaveGuard } from './LeaveGuard';

export interface PagePrimaryAction {
  label: string;
  /** The page's form: the button submits it (`form` attribute). */
  formId?: string;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
}

/** A link next to the main action (e.g. "View on site", new tab). */
export interface PageSecondaryLink {
  label: string;
  href: string;
  testId?: string;
}

function SecondaryLink({ link, className }: { link: PageSecondaryLink; className: string }) {
  return (
    <a
      className={`adm-btn adm-btn--ghost ${className}`}
      href={link.href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid={link.testId}
    >
      {link.label}
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M7 17L17 7M9 7h8v8" />
      </svg>
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

interface AdminFormPageProps {
  title: string;
  /** Small grey line under the title (e.g. "Last updated by …"). */
  subtitle?: ReactNode;
  backLabel: string;
  onBack: () => void;
  primary?: PagePrimaryAction;
  secondary?: PageSecondaryLink;
  testId: string;
  /** Batch 35: small buttons always shown at the top right (the order
   *  page's pen). */
  headerExtra?: ReactNode;
  /** Batch 35: false for a page that is not one form (the order page saves
   *  each field on its own), so leaving never asks "Discard changes?". */
  guard?: boolean;
  /** Extra class on the page (layout). */
  className?: string;
  children: ReactNode;
}

function PrimaryButton({ action, className }: { action: PagePrimaryAction; className: string }) {
  return (
    <button
      type={action.formId ? 'submit' : 'button'}
      form={action.formId}
      className={`adm-btn adm-btn--primary ${className}`}
      onClick={action.onClick}
      disabled={action.disabled || action.busy}
      aria-busy={action.busy || undefined}
    >
      {action.busy ? <span className="spinner" aria-hidden="true" /> : action.label}
    </button>
  );
}

/**
 * Batch 32 Part 3: one admin page for one big form — a top bar with ← Back,
 * the title and (on a computer) the main action; on a phone the main action
 * docks at the bottom of the screen. Anything typed inside marks the page
 * as changed, so leaving asks "Discard changes?" (LeaveGuard).
 */
export function AdminFormPage({
  title,
  subtitle,
  backLabel,
  onBack,
  primary,
  secondary,
  testId,
  headerExtra,
  guard = true,
  className,
  children,
}: AdminFormPageProps) {
  const { markDirty } = useLeaveGuard();
  const onEdit = guard ? markDirty : undefined;
  return (
    <section
      className={`adm-fpage${primary ? ' adm-fpage--docked' : ''}${className ? ` ${className}` : ''}`}
      aria-label={title}
      data-testid={testId}
    >
      <header className="adm-fpage__bar">
        <button type="button" className="adm-fpage__back" onClick={onBack} aria-label={backLabel}>
          <AdminIcon name="chevron-left" />
          <span>Back</span>
        </button>
        <div className="adm-fpage__titles">
          <h1 className="adm-fpage__title">{title}</h1>
          {subtitle && <p className="adm-fpage__subtitle">{subtitle}</p>}
        </div>
        <div className="adm-fpage__actions">
          <span className="adm-only-desktop">
            <AdminThemeButton variant="ghost" />
          </span>
          {headerExtra}
          {secondary && (
            <span className="adm-only-desktop">
              <SecondaryLink link={secondary} className="adm-fpage__secondary" />
            </span>
          )}
          {primary && (
            <span className="adm-only-desktop">
              <PrimaryButton action={primary} className="adm-fpage__primary" />
            </span>
          )}
        </div>
      </header>
      <div className="adm-fpage__body" onInputCapture={onEdit} onChangeCapture={onEdit}>
        {children}
      </div>
      {primary && (
        <div className="adm-fpage__dock adm-only-mobile">
          <div className="adm-fpage__dock-inner">
            {secondary && <SecondaryLink link={secondary} className="adm-fpage__dock-secondary" />}
            <PrimaryButton action={primary} className="adm-fpage__dock-btn" />
          </div>
        </div>
      )}
    </section>
  );
}
