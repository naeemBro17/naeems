import { useEffect } from 'react';

const DEFAULT_TITLE = "Naeem's";

/** Sets the browser tab title for as long as the calling page is mounted,
 *  restoring the app-wide default on unmount. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title;
    return () => {
      document.title = DEFAULT_TITLE;
    };
  }, [title]);
}
