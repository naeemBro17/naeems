import { useCallback } from 'react';
import { useNavigate as useRouterNavigate, type NavigateOptions, type To } from 'react-router-dom';
import { navigateWithTransition } from '../lib/viewTransition';

/**
 * Drop-in replacement for react-router's `useNavigate` for forward/lateral
 * navigation (`navigate('/path')`, `navigate(to, { replace: true })`) — a
 * component switches over by changing one import line. The returned
 * function runs the navigation inside a native View Transition instead of a
 * plain history update, which is what lets the transition apply before the
 * very first frame of the new page ever paints (see reports/batch-21.txt
 * Part 1) instead of a frame after.
 *
 * Deliberately does NOT accept a numeric delta (`navigate(-1)`) — an in-app
 * "go back" button calls lib/viewTransition.ts's navigateBack instead, which
 * starts its own transition before stepping back (see that function).
 */
export function useAppNavigate() {
  const navigate = useRouterNavigate();

  return useCallback(
    (to: To, options?: NavigateOptions) => {
      navigateWithTransition(navigate, to, options);
    },
    [navigate]
  );
}
