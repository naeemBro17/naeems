import { useEffect, useState } from 'react';
import { BottomSheet } from './BottomSheet';
import { useToast } from '../../hooks/useToast';
import {
  barClosed,
  chromeAlreadyTried,
  closeBar,
  currentInApp,
  onInAppHelpRequest,
  reopenInChrome,
} from '../../lib/inAppBrowser';

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Batch 52 Part 4: inside Facebook / Messenger / Instagram's own browser, a
 * small calm bar at the top: "For Google login and faster checkout, open
 * this page in Safari." with "How?" (a short sheet + Copy link). Closed
 * with ✕ = hidden for the rest of the visit. On Android it only shows when
 * the jump to Chrome did not happen. Normal browsers never see it.
 */
export function InAppBrowserBar() {
  const [info] = useState(currentInApp);
  const [hidden, setHidden] = useState(barClosed);
  const [sheetOpen, setSheetOpen] = useState(false);
  const { showToast } = useToast();

  // The Google login buttons ask for the same help (lib/inAppBrowser.ts).
  useEffect(() => onInAppHelpRequest(() => setSheetOpen(true)), []);

  if (!info.inApp) return null;
  const android = info.platform === 'android';
  const browser = android ? 'Chrome' : 'Safari';
  const showBar = !hidden && (!android || chromeAlreadyTried());

  const copyLink = async () => {
    const ok = await copyText(window.location.href);
    showToast(ok ? `Link copied. Paste it in ${browser}` : 'Could not copy the link');
  };

  return (
    <>
      {showBar && (
        <div className="inapp-bar" role="region" aria-label="Open in your browser" data-testid="inapp-bar">
          <p className="inapp-bar__text">
            For Google login and faster checkout, open this page in {browser}.{' '}
            <button type="button" className="inapp-bar__how" onClick={() => setSheetOpen(true)} data-testid="inapp-how">
              How?
            </button>
          </p>
          <button
            type="button"
            className="inapp-bar__close"
            aria-label="Close"
            onClick={() => {
              closeBar();
              setHidden(true);
            }}
            data-testid="inapp-close"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      )}
      <BottomSheet isOpen={sheetOpen} onClose={() => setSheetOpen(false)} title={`Open in ${browser}`}>
        <div className="inapp-sheet" data-testid="inapp-sheet">
          <p className="inapp-sheet__text">
            {android
              ? 'Tap ••• in the corner of the screen, then choose Open in browser. Or tap the button below.'
              : 'Tap ••• in the corner of the screen, then choose Open in browser.'}
          </p>
          {android && (
            <button type="button" className="button button--primary button--full" onClick={() => reopenInChrome(true)}>
              Open in Chrome
            </button>
          )}
          <button
            type="button"
            className={`button button--full ${android ? 'button--secondary' : 'button--primary'}`}
            onClick={() => void copyLink()}
            data-testid="inapp-copy"
          >
            Copy link
          </button>
        </div>
      </BottomSheet>
    </>
  );
}
