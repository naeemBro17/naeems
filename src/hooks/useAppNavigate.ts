import { useCallback } from 'react';
import { useNavigate as useRouterNavigate, type NavigateOptions, type To } from 'react-router-dom';
import { navigateWithTransition } from '../lib/viewTransition';

/**
 * Drop-in replacement for react-router's `useNavigate` — same call shape
 * (`navigate('/path')`, `navigate(-1)`, `navigate(to, { replace: true })`),
 * so a component switches over by changing one import line. The returned
 * function runs the navigation inside a native View Transition instead of a
 * plain history update, which is what lets PageTransition apply its
 * slide/fade class before the very first frame of the new page ever paints
 * (see reports/batch-21.txt Part 1) instead of a frame after.
 *
 * Only covers navigations that go through a component's own click handler.
 * A real phone back-gesture or the browser's own Back/Forward buttons fire
 * outside any handler this hook can wrap — PageTransition's manual CSS
 * fallback (still fixed for the same black-frame bug) handles those.
 */
export function useAppNavigate() {
  const navigate = useRouterNavigate();

  return useCallback(
    (to: To | number, options?: NavigateOptions) => {
      navigateWithTransition(navigate, to, options);
    },
    [navigate]
  );
}
