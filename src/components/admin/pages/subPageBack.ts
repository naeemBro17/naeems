import type { Location, NavigateFunction } from 'react-router-dom';

/** How a page was opened: from its list (Back returns there, filters and
 *  scroll kept) or with an exact place to return to (Edit order → the
 *  order it came from). Neither = a link opened directly or after a reload
 *  in a fresh tab: Back goes to the section's list. */
export interface SubPageState {
  fromList?: boolean;
  returnTo?: string;
}

export function goBackFromSubPage(navigate: NavigateFunction, location: Location, fallback: string): void {
  const state = (location.state ?? null) as SubPageState | null;
  if (state?.returnTo && state.returnTo.startsWith('/admin')) {
    navigate(state.returnTo, { replace: true });
  } else if (state?.fromList) {
    navigate(-1);
  } else {
    navigate(fallback, { replace: true });
  }
}
