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

interface AdminFormPageProps {
  title: string;
  /** Small grey line under the title (e.g. "Last updated by …"). */
  subtitle?: ReactNode;
  backLabel: string;
  onBack: () => void;
  primary?: PagePrimaryAction;
  testId: string;
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
export function AdminFormPage({ title, subtitle, backLabel, onBack, primary, testId, children }: AdminFormPageProps) {
  const { markDirty } = useLeaveGuard();
  return (
    <section className={`adm-fpage${primary ? ' adm-fpage--docked' : ''}`} aria-label={title} data-testid={testId}>
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
          {primary && (
            <span className="adm-only-desktop">
              <PrimaryButton action={primary} className="adm-fpage__primary" />
            </span>
          )}
        </div>
      </header>
      <div className="adm-fpage__body" onInputCapture={markDirty} onChangeCapture={markDirty}>
        {children}
      </div>
      {primary && (
        <div className="adm-fpage__dock adm-only-mobile">
          <div className="adm-fpage__dock-inner">
            <PrimaryButton action={primary} className="adm-fpage__dock-btn" />
          </div>
        </div>
      )}
    </section>
  );
}
