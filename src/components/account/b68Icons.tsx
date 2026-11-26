// Batch 68: line icons for the Account tab. Google "G" stays in its own colours (Google's brand rule).
const line = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export const ArrowIcon = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth="2.4" {...line} aria-hidden="true"><path d="M5 12h14M13 5l7 7-7 7" /></svg>
);
export const BackIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" strokeWidth="2.2" {...line} aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
);
export const ChevronIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth="2.6" {...line} aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
);
export const CheckIcon = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" strokeWidth="3" {...line} aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
);
export const LockIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" strokeWidth="2" {...line} aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
);
export const SunIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" strokeWidth="1.9" {...line} aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
);
export const MoonIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" strokeWidth="1.9" {...line} aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /></svg>
);
export const StarIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z" /></svg>
);
export const OrdersIcon = () => (
  <svg width="21" height="21" viewBox="0 0 24 24" strokeWidth="1.8" {...line} aria-hidden="true"><rect x="5" y="3.5" width="14" height="17" rx="2" /><path d="M9 8h6M9 12h6M9 16h3" /></svg>
);
export const HeartLineIcon = () => (
  <svg width="21" height="21" viewBox="0 0 24 24" strokeWidth="1.8" {...line} aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z" /></svg>
);
export const PinIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" strokeWidth="1.8" {...line} aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.5" /></svg>
);
export const ClockIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" strokeWidth="1.8" {...line} aria-hidden="true"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
);
export const HelpIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" strokeWidth="1.8" {...line} aria-hidden="true"><path d="M20 11.5a8 8 0 0 1-11.7 7.1L4 20l1.4-4.1A8 8 0 1 1 20 11.5z" /></svg>
);
export const LogOutIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" strokeWidth="2" {...line} aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>
);
export const GoogleG = () => (
  <svg width="26" height="26" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.4-.4-3.5z" />
    <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
    <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
    <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
  </svg>
);
