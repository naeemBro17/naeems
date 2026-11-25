// Batch 67: small line icons for the Cart and Order Summary screens.
const base = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export function MinusIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" strokeWidth="2.4" {...base} aria-hidden="true"><path d="M5 12h14" /></svg>;
}
export function PlusIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" strokeWidth="2.4" {...base} aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;
}
export function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" strokeWidth="2" {...base} aria-hidden="true">
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
    </svg>
  );
}
export function ClockIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" strokeWidth="2" {...base} aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
}
export function CheckIcon({ size = 13 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth="2.6" {...base} aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>;
}
export function ArrowRightIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" strokeWidth="2.4" {...base} aria-hidden="true"><path d="M5 12h14M13 5l7 7-7 7" /></svg>;
}
export function ShieldIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" strokeWidth="1.8" {...base} aria-hidden="true">
      <path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}
export function PinIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" strokeWidth="1.9" {...base} aria-hidden="true">
      <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z" />
      <circle cx="12" cy="9.5" r="2.5" />
    </svg>
  );
}
export function TagIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" strokeWidth="1.9" {...base} aria-hidden="true">
      <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" />
      <circle cx="7.5" cy="7.5" r="1.5" />
    </svg>
  );
}
export function ChevronRightIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" strokeWidth="2.2" {...base} aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>;
}
export function WalletIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" strokeWidth="1.8" {...base} aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h13v4" />
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M16 13.5h2" />
    </svg>
  );
}
export function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" strokeWidth="2.2" {...base} aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </svg>
  );
}
export function SparkIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.2 6.6L21 11l-6.8 2.4L12 20l-2.2-6.6L3 11l6.8-2.4z" /></svg>;
}
export function EmptyBagArt() {
  return (
    <svg className="b67-empty__art" viewBox="0 0 148 148" aria-hidden="true">
      <circle className="a-bg" cx="74" cy="74" r="72" />
      <path className="a-bag" d="M48 58h52l-4 50a6 6 0 0 1-6 5.5H58a6 6 0 0 1-6-5.5z" strokeWidth="2.4" strokeLinejoin="round" />
      <path className="a-ink" d="M62 64v-8a12 12 0 0 1 24 0v8" fill="none" strokeWidth="2.4" strokeLinecap="round" />
      <circle className="a-dot" cx="62" cy="65" r="2.6" />
      <circle className="a-dot" cx="86" cy="65" r="2.6" />
      <path className="a-spark" d="M104 40l3 6 6 3-6 3-3 6-3-6-6-3 6-3z" />
      <circle className="a-spark" cx="40" cy="48" r="3" />
    </svg>
  );
}
